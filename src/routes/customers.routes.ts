import { CustomerStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as customerService from '../services/customer.service';
import { getCustomerPortalDashboard } from '../services/portal.service';
import { getStoreSettings } from '../services/settings.service';
import { generateCustomerStatementPdf } from '../integrations/pdf';

const router = Router();
router.use(requireOwner);

const createCustomerSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(8).max(30),
  email: z.string().email().nullable().optional().or(z.literal('')),
  creditLimit: z.coerce.number().min(0).optional(),
  notes: z.string().max(500).nullable().optional(),
});

const updateCustomerSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  phone: z.string().min(8).max(30).optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
  notes: z.string().max(500).nullable().optional(),
});

const creditLimitSchema = z.object({
  limitAmount: z.coerce.number().min(0),
  reason: z.string().min(2).max(240),
});

const shareSchema = z.object({
  channel: z.enum(['SMS', 'WHATSAPP']),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const customers = await customerService.listCustomers({
      search: req.query.search as string | undefined,
      status: req.query.status as CustomerStatus | undefined,
      hasDebt: req.query.hasDebt === 'true',
    });
    res.json({ customers });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const customer = await customerService.getCustomerProfile(req.params.id as string);
    res.json({ customer });
  })
);

router.post(
  '/',
  validateBody(createCustomerSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.createCustomer(
      { ...req.body, email: req.body.email || null },
      req.owner!.id,
      req.ip
    );
    res.status(201).json({ customer });
  })
);

router.patch(
  '/:id',
  validateBody(updateCustomerSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.updateCustomer(
      req.params.id as string,
      { ...req.body, email: req.body.email === '' ? null : req.body.email },
      req.owner!.id,
      req.ip
    );
    res.json({ customer });
  })
);

router.post(
  '/:id/credit-limit',
  validateBody(creditLimitSchema),
  asyncHandler(async (req, res) => {
    const record = await customerService.updateCustomerCreditLimit(
      req.params.id as string,
      req.body.limitAmount,
      req.body.reason,
      req.owner!.id,
      req.ip
    );
    res.json({ creditLimit: record });
  })
);

router.post(
  '/:id/portal-link/regenerate',
  asyncHandler(async (req, res) => {
    const result = await customerService.regenerateCustomerPortalLink(
      req.params.id as string,
      req.owner!.id,
      req.ip
    );
    res.json(result);
  })
);

router.post(
  '/:id/share',
  validateBody(shareSchema),
  asyncHandler(async (req, res) => {
    const result = await customerService.shareCustomerPortalLink(
      req.params.id as string,
      req.body.channel,
      req.owner!.id
    );
    res.json(result);
  })
);

router.get(
  '/:id/statement.pdf',
  asyncHandler(async (req, res) => {
    const [statement, settings] = await Promise.all([
      getCustomerPortalDashboard(req.params.id as string, {
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

export default router;

