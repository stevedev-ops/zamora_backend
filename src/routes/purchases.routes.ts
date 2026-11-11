import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as purchaseService from '../services/purchase.service';

const router = Router();
router.use(requireOwner);

const createPurchaseSchema = z.object({
  supplierId: z.string().uuid(),
  purchaseDate: z.string().optional(),
  referenceNumber: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.coerce.number().int().positive(),
        unitCostPrice: z.coerce.number().min(0),
      })
    )
    .min(1),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const purchases = await purchaseService.listSupplierPurchases({
      supplierId: req.query.supplierId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    });
    res.json({ purchases });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const purchase = await purchaseService.getSupplierPurchaseById(req.params.id as string);
    res.json({ purchase });
  })
);

router.post(
  '/',
  validateBody(createPurchaseSchema),
  asyncHandler(async (req, res) => {
    const purchase = await purchaseService.createSupplierPurchase(req.body, req.owner!.id, req.ip);
    res.status(201).json({ purchase });
  })
);

export default router;

