import { InventoryMovementType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as inventoryService from '../services/inventory.service';

const router = Router();
router.use(requireOwner);

const adjustSchema = z.object({
  productId: z.string().uuid(),
  operation: z.enum([
    'ADD',
    'ADJUST_IN',
    'ADJUST_OUT',
    'DAMAGED',
    'EXPIRED',
    'RETURN_IN',
    'RETURN_OUT',
  ]),
  quantity: z.coerce.number().int().positive(),
  unitCostPrice: z.coerce.number().min(0).optional(),
  reason: z.string().min(3).max(300),
  referenceNumber: z.string().max(80).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await inventoryService.getInventoryOverview({
      search: req.query.search as string | undefined,
      lowStockOnly: req.query.lowStockOnly === 'true',
    });
    res.json(data);
  })
);

router.get(
  '/movements',
  asyncHandler(async (req, res) => {
    const movements = await inventoryService.listInventoryMovements({
      productId: req.query.productId as string | undefined,
      movementType: req.query.movementType as InventoryMovementType | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ movements });
  })
);

router.post(
  '/adjust',
  validateBody(adjustSchema),
  asyncHandler(async (req, res) => {
    const result = await inventoryService.adjustInventory(req.body, req.owner!.id, req.ip);
    res.status(201).json(result);
  })
);

export default router;

