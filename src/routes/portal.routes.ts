import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { asyncHandler, ValidationError } from '../lib/errors';
import { requireCustomerPortal } from '../middleware/auth';
import { otpLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import * as portalService from '../services/portal.service';
import * as mpesaService from '../services/mpesa.service';
import { getStoreSettings } from '../services/settings.service';
import { generateCustomerStatementPdf, generateSaleReceiptPdf } from '../integrations/pdf';

const router = Router();

const portalCookieOptions = {
  httpOnly: true,
  sameSite: env.cookieSameSite,
  secure: env.cookieSecure,
};

const verifyOtpSchema = z.object({
  otp: z.string().min(4).max(10),
});

const clarificationSchema = z.object({
  debtTransactionId: z.string().uuid().optional(),
  saleId: z.string().uuid().optional(),
  message: z.string().min(5).max(500),
});

const flagSaleItemSchema = z.object({
  isFlagged: z.boolean(),
  flagNote: z.string().max(240).nullable().optional(),
});

const transferRespondSchema = z.object({
  action: z.enum(['ACCEPT', 'REJECT']),
  otp: z.string().optional(),
});

const portalStkSchema = z.object({
  phoneNumber: z.string().min(9).max(20),
  amount: z.coerce.number().positive(),
});

// Public transfer confirmation link endpoints (OTP verified)
router.get(
  '/transfer-confirm/:confirmationToken',
  asyncHandler(async (req, res) => {
    const info = await portalService.getPublicTransferConfirmationInfo(
      req.params.confirmationToken as string
    );
    res.json({ transfer: info });
  })
);

router.post(
  '/transfer-confirm/:confirmationToken/respond',
  otpLimiter,
  validateBody(transferRespondSchema),
  asyncHandler(async (req, res) => {
    const result = await portalService.respondToTransferByPublicToken(
      req.params.confirmationToken as string,
      req.body.action,
      req.body.otp,
      req.ip
    );
    res.json(result);
  })
);

// Customer portal authenticated endpoints (/api/portal/me/*)
router.post('/me/logout', (_req, res) => {
  res.clearCookie('portal_token', portalCookieOptions);
  res.json({ message: 'Signed out of portal' });
});

router.get(
  '/me/dashboard',
  requireCustomerPortal,
  asyncHandler(async (req, res) => {
    const data = await portalService.getCustomerPortalDashboard(req.portalSession!.customerId, {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    });
    res.json(data);
  })
);

router.get(
  '/me/sales/:saleId',
  requireCustomerPortal,
  asyncHandler(async (req, res) => {
    const sale = await portalService.getCustomerPortalSaleReceipt(
      req.portalSession!.customerId,
      req.params.saleId as string
    );
    res.json({ sale });
  })
);

router.get(
  '/me/sales/:saleId/receipt.pdf',
  requireCustomerPortal,
  asyncHandler(async (req, res) => {
    const [sale, settings] = await Promise.all([
      portalService.getCustomerPortalSaleReceipt(
        req.portalSession!.customerId,
        req.params.saleId as string
      ),
      getStoreSettings(),
    ]);
    const pdf = await generateSaleReceiptPdf(sale, settings);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="receipt-${sale.receiptNumber}.pdf"`
    );
    res.send(pdf);
  })
);

router.get(
  '/me/statement.pdf',
  requireCustomerPortal,
  asyncHandler(async (req, res) => {
    const [statement, settings] = await Promise.all([
      portalService.getCustomerPortalDashboard(req.portalSession!.customerId, {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
      }),
      getStoreSettings(),
    ]);
    const pdf = await generateCustomerStatementPdf(statement, settings);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="statement-${statement.customer.accountNumber}.pdf"`
    );
    res.send(pdf);
  })
);

router.post(
  '/me/clarifications',
  requireCustomerPortal,
  validateBody(clarificationSchema),
  asyncHandler(async (req, res) => {
    const request = await portalService.submitClarificationRequest(
      req.portalSession!.customerId,
      req.body
    );
    res.status(201).json({ request });
  })
);

router.patch(
  '/me/sale-items/:saleItemId/flag',
  requireCustomerPortal,
  validateBody(flagSaleItemSchema),
  asyncHandler(async (req, res) => {
    const item = await portalService.flagPortalSaleItem(
      req.portalSession!.customerId,
      req.params.saleItemId as string,
      req.body,
      req.ip
    );
    res.json({ item });
  })
);

router.post(
  '/me/transfers/:transferId/respond',
  requireCustomerPortal,
  validateBody(z.object({ action: z.enum(['ACCEPT', 'REJECT']) })),
  asyncHandler(async (req, res) => {
    const result = await portalService.respondToTransferInPortal(
      req.portalSession!.customerId,
      req.params.transferId as string,
      req.body.action,
      req.ip
    );
    res.json(result);
  })
);

router.post(
  '/me/mpesa/stkpush',
  requireCustomerPortal,
  validateBody(portalStkSchema),
  asyncHandler(async (req, res) => {
    const settings = await getStoreSettings();
    if (!settings.mpesaEnabled) {
      throw new ValidationError('M-Pesa portal payments are currently disabled');
    }
    const dashboard = await portalService.getCustomerPortalDashboard(req.portalSession!.customerId);
    if (req.body.amount > dashboard.summary.currentBalance) {
      throw new ValidationError(
        `Amount exceeds your current balance of ${settings.currency} ${dashboard.summary.currentBalance.toFixed(2)}`
      );
    }
    const result = await mpesaService.initiateMpesaStkPush({
      purpose: 'PORTAL_REPAYMENT',
      phoneNumber: req.body.phoneNumber,
      amount: req.body.amount,
      customerId: req.portalSession!.customerId,
    });
    res.status(201).json(result);
  })
);

// Public portal challenge & OTP verification (/api/portal/:token/*)
router.get(
  '/:token/challenge',
  asyncHandler(async (req, res) => {
    const challenge = await portalService.getPortalChallenge(req.params.token as string);
    res.json(challenge);
  })
);

router.post(
  '/:token/open',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const result = await portalService.openPortalDirect(req.params.token as string);
    res.cookie('portal_token', result.sessionToken, {
      ...portalCookieOptions,
      maxAge: 2 * 60 * 60 * 1000,
    });
    res.json(result);
  })
);

router.post(
  '/:token/request-otp',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const result = await portalService.requestPortalOtp(req.params.token as string);
    res.json(result);
  })
);

router.post(
  '/:token/verify-otp',
  otpLimiter,
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const result = await portalService.verifyPortalOtp(
      req.params.token as string,
      req.body.otp
    );

    res.cookie('portal_token', result.sessionToken, {
      ...portalCookieOptions,
      maxAge: 2 * 60 * 60 * 1000,
    });

    res.json(result);
  })
);

export default router;

