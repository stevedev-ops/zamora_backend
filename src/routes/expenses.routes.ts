import { ExpenseCategory } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as expenseService from '../services/expense.service';

const router = Router();
router.use(requireOwner);

const expenseSchema = z.object({
  category: z.enum([
    'RENT',
    'ELECTRICITY',
    'WATER',
    'TRANSPORT',
    'SALARIES',
    'LICENCES',
    'REPAIRS',
    'OTHER',
  ]),
  title: z.string().min(2).max(160),
  amount: z.coerce.number().positive(),
  expenseDate: z.string().optional(),
  paymentMethod: z.enum(['CASH', 'MPESA', 'BANK_TRANSFER', 'OTHER']),
  payee: z.string().max(120).optional(),
  notes: z.string().max(400).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const expenses = await expenseService.listExpenses({
      category: req.query.category as ExpenseCategory | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    });
    res.json({ expenses });
  })
);

router.post(
  '/',
  validateBody(expenseSchema),
  asyncHandler(async (req, res) => {
    const expense = await expenseService.createExpense(req.body, req.owner!.id, req.ip);
    res.status(201).json({ expense });
  })
);

router.patch(
  '/:id',
  validateBody(expenseSchema.partial()),
  asyncHandler(async (req, res) => {
    const expense = await expenseService.updateExpense(
      req.params.id as string,
      req.body,
      req.owner!.id
    );
    res.json({ expense });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await expenseService.deleteExpense(req.params.id as string, req.owner!.id);
    res.json(result);
  })
);

export default router;

