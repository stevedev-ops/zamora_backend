import { ExpenseCategory } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as expenseService from '../services/expense.service';
import { getStoreSettings } from '../services/settings.service';
import {
  exportFmtDate,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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
      search: req.query.search as string | undefined,
    });
    res.json({ expenses });
  })
);

router.get(
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const category = req.query.category as ExpenseCategory | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const [expenses, settings] = await Promise.all([
      expenseService.listExpenses({ category, startDate, endDate, search }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalAmount = expenses.reduce((s, e) => s + e.amount, 0);
    const filterParts = [
      ...(category ? [`Category: ${category}`] : ['All Categories']),
      ...(startDate ? [`From: ${startDate}`] : []),
      ...(endDate ? [`To: ${endDate}`] : []),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-expenses',
      title: 'Operating Expenses Report',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Expenses Count', value: String(expenses.length) },
        { label: 'Total Operating Expenses', value: exportFmtMoney(cur, totalAmount) },
      ],
      columns: [
        { header: 'Ref #', key: 'referenceNumber', width: 14 },
        {
          header: 'Date',
          key: 'expenseDate',
          width: 12,
          format: (r) => exportFmtDate(r.expenseDate),
        },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Title', key: 'title', width: 26 },
        { header: 'Payee', key: 'payee', width: 18 },
        { header: 'Method', key: 'paymentMethod', width: 14 },
        { header: `Amount (${cur})`, key: 'amount', width: 15, align: 'right', money: true },
        { header: 'Notes', key: 'notes', width: 22 },
      ],
      rows: expenses,
      store: settings,
    });
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

