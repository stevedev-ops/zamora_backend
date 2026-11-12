import { SalePaymentMethod } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as posService from '../services/pos.service';
import { getStoreSettings } from '../services/settings.service';
import { generateSaleReceiptPdf } from '../integrations/pdf';
import {
  exportFmtDateTime,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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
  splitShares: z
    .array(
      z.object({
        customerId: z.string().uuid().nullable().optional(),
        payerName: z.string().max(120).nullable().optional(),
        cashAmount: z.coerce.number().min(0).optional(),
        mpesaAmount: z.coerce.number().min(0).optional(),
        debtAmount: z.coerce.number().min(0).optional(),
        notes: z.string().max(300).nullable().optional(),
      })
    )
    .min(2)
    .max(10)
    .optional(),
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
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const customerId = req.query.customerId as string | undefined;
    const paymentMethod = req.query.paymentMethod as SalePaymentMethod | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const [sales, settings] = await Promise.all([
      posService.listSales({
        customerId,
        paymentMethod,
        startDate,
        endDate,
        search,
        limit: 5000,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalSales = sales.reduce((s, row) => s + row.totalAmount, 0);
    const totalPaid = sales.reduce((s, row) => s + row.amountPaid, 0);
    const totalOutstanding = sales.reduce((s, row) => s + row.outstandingAmount, 0);

    const filterParts = [
      ...(paymentMethod ? [`Method: ${paymentMethod}`] : []),
      ...(startDate ? [`From: ${startDate}`] : []),
      ...(endDate ? [`To: ${endDate}`] : []),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-sales',
      title: 'Sales Log',
      filterSummary: filterParts.length > 0 ? filterParts.join(' | ') : 'Recent Sales',
      summaryRows: [
        { label: 'Sales Count', value: String(sales.length) },
        { label: 'Total Billed', value: exportFmtMoney(cur, totalSales) },
        { label: 'Total Paid', value: exportFmtMoney(cur, totalPaid) },
        { label: 'Total Credit / Unpaid', value: exportFmtMoney(cur, totalOutstanding) },
      ],
      columns: [
        { header: 'Receipt #', key: 'receiptNumber', width: 14 },
        {
          header: 'Date',
          key: 'soldAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.soldAt),
        },
        {
          header: 'Customer',
          key: 'customerName',
          width: 20,
          format: (r) => r.customer?.fullName || 'Walk-in',
        },
        { header: 'Method', key: 'paymentMethod', width: 10 },
        {
          header: 'Items',
          key: 'itemsSummary',
          width: 28,
          format: (r) => r.items.map((i) => `${i.productName} x${i.quantity}`).join(', '),
        },
        { header: `Total (${cur})`, key: 'totalAmount', width: 13, align: 'right', money: true },
        { header: `Paid (${cur})`, key: 'amountPaid', width: 13, align: 'right', money: true },
        {
          header: `Debt (${cur})`,
          key: 'outstandingAmount',
          width: 13,
          align: 'right',
          money: true,
        },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Note', key: 'notes', width: 22, format: (r) => r.notes || '' },
      ],
      rows: sales,
      store: settings,
    });
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

