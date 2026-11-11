import { SupplierStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as supplierService from '../services/supplier.service';

const router = Router();
router.use(requireOwner);

const supplierSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(8).max(30),
  email: z.string().email().nullable().optional(),
  address: z.string().max(240).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const suppliers = await supplierService.listSuppliers({
      search: req.query.search as string | undefined,
      status: req.query.status as SupplierStatus | undefined,
    });
    res.json({ suppliers });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const supplier = await supplierService.getSupplierDetail(req.params.id as string);
    res.json({ supplier });
  })
);

router.post(
  '/',
  validateBody(supplierSchema),
  asyncHandler(async (req, res) => {
    const supplier = await supplierService.createSupplier(req.body, req.owner!.id, req.ip);
    res.status(201).json({ supplier });
  })
);

router.patch(
  '/:id',
  validateBody(supplierSchema.partial()),
  asyncHandler(async (req, res) => {
    const supplier = await supplierService.updateSupplier(
      req.params.id as string,
      req.body,
      req.owner!.id,
      req.ip
    );
    res.json({ supplier });
  })
);

export default router;

