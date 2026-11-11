import { ProductStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as productService from '../services/product.service';

const router = Router();
router.use(requireOwner);

const createProductSchema = z.object({
  name: z.string().min(2).max(120),
  brand: z.string().min(1).max(100),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  imageUrl: z.string().max(500).nullable().optional(),
  barcode: z.string().max(80).nullable().optional(),
  bottleSize: z.string().min(1).max(40),
  purchasePrice: z.coerce.number().min(0),
  sellingPrice: z.coerce.number().positive(),
  initialStock: z.coerce.number().int().min(0).optional(),
  minStockAlert: z.coerce.number().int().min(0).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const updateProductSchema = createProductSchema.omit({ initialStock: true }).partial();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const products = await productService.listProducts({
      search: req.query.search as string | undefined,
      categoryId: req.query.categoryId as string | undefined,
      status: req.query.status as ProductStatus | undefined,
      lowStockOnly: req.query.lowStockOnly === 'true',
    });
    res.json({ products });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const product = await productService.getProductDetail(req.params.id as string);
    res.json({ product });
  })
);

router.post(
  '/',
  validateBody(createProductSchema),
  asyncHandler(async (req, res) => {
    const product = await productService.createProduct(req.body, req.owner!.id, req.ip);
    res.status(201).json({ product });
  })
);

router.patch(
  '/:id',
  validateBody(updateProductSchema),
  asyncHandler(async (req, res) => {
    const product = await productService.updateProduct(
      req.params.id as string,
      req.body,
      req.owner!.id,
      req.ip
    );
    res.json({ product });
  })
);

export default router;

