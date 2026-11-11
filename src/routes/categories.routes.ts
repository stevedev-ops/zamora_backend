import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as categoryService from '../services/category.service';

const router = Router();
router.use(requireOwner);

const categorySchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(240).optional(),
});

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const categories = await categoryService.listCategories();
    res.json({ categories });
  })
);

router.post(
  '/',
  validateBody(categorySchema),
  asyncHandler(async (req, res) => {
    const category = await categoryService.createCategory(req.body, req.owner!.id, req.ip);
    res.status(201).json({ category });
  })
);

router.patch(
  '/:id',
  validateBody(categorySchema.partial()),
  asyncHandler(async (req, res) => {
    const category = await categoryService.updateCategory(
      req.params.id as string,
      req.body,
      req.owner!.id
    );
    res.json({ category });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await categoryService.deleteCategory(req.params.id as string, req.owner!.id);
    res.json(result);
  })
);

export default router;

