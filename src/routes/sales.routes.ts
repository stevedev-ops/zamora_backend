import { SalePaymentMethod } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as posService from '../services/pos.service';
import { getStoreSettings } from '../services/settings.service';
import { generateSaleReceiptPdf } from '../integrations/pdf';

const router = Router();
router.use(requireOwner);

const createSaleSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.coerce.number().int().positive(),
      })
    )
    .min(1),
  discountAmount: z.coerce.number().min(0).optional(),
  discountReason: z.string().max(240).optional(),
  paymentMethod: z.enum(['CASH', 'MPESA', 'CREDIT', 'SPLIT']),
  cashAmount: z.coerce.number().min(0).optional(),
  mpesaAmount: z.coerce.number().min(0).optional(),
  mpesaReference: z.string().max(80).optional(),
  notes: z.string().max(500).optional(),
  allowCreditLimitOverride: z.boolean().optional(),
  idempotencyKey: z.string().max(120).optional(),
});

const updateSaleItemsSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.coerce.number().int().positive(),
    })
  ),
  discountAmount: z.coerce.number().min(0).optional(),
  discountReason: z.string().max(240).optional(),
  notes: z.string().max(500).nullable().optional(),
  reason: z.string().max(300).optional(),
  allowCreditLimitOverride: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sales = await posService.listSales({
      customerId: req.query.customerId as string | undefined,
      paymentMethod: req.query.paymentMethod as SalePaymentMethod | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ sales });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sale = await posService.getSaleById(req.params.id as string);
    res.json({ sale });
  })
);

router.post(
  '/',
  validateBody(createSaleSchema),
  asyncHandler(async (req, res) => {
    const sale = await posService.createSale(req.body, req.owner!.id, req.ip);
    res.status(201).json({ sale });
  })
);

router.patch(
  '/:id/items',
  validateBody(updateSaleItemsSchema),
  asyncHandler(async (req, res) => {
    const result = await posService.updateCreditSaleItems(
      req.params.id as string,
      req.body,
      req.owner!.id,
      req.ip
    );
    res.json(result);
  })
);

router.get(
  '/:id/receipt.pdf',
  asyncHandler(async (req, res) => {
    const [sale, settings] = await Promise.all([
      posService.getSaleById(req.params.id as string),
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

export default router;

