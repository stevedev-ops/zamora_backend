import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as mpesaService from '../services/mpesa.service';

const router = Router();

const stkPushSchema = z.object({
  purpose: z.enum(['POS_SALE', 'DEBT_REPAYMENT']),
  phoneNumber: z.string().min(9).max(20),
  amount: z.coerce.number().positive(),
  customerId: z.string().uuid().optional(),
  saleId: z.string().uuid().optional(),
});

router.post(
  '/stkpush',
  requireOwner,
  validateBody(stkPushSchema),
  asyncHandler(async (req, res) => {
    const result = await mpesaService.initiateMpesaStkPush(req.body);
    res.status(201).json(result);
  })
);

// Safaricom Daraja Webhook Callback
router.post(
  '/callback',
  asyncHandler(async (req, res) => {
    const result = await mpesaService.handleDarajaCallback(req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted', ...result });
  })
);

// Simulation callback helper for local testing/demo when DARAJA_MODE=simulation
router.post(
  '/simulate-callback',
  validateBody(z.object({ checkoutRequestId: z.string().min(5) })),
  asyncHandler(async (req, res) => {
    const result = await mpesaService.simulateMpesaSuccess(req.body.checkoutRequestId);
    res.json(result);
  })
);

router.get(
  '/status/:checkoutRequestId',
  asyncHandler(async (req, res) => {
    const status = await mpesaService.getMpesaTransactionStatus(
      req.params.checkoutRequestId as string
    );
    res.json({ transaction: status });
  })
);

export default router;

