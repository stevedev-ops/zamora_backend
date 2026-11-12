import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as purchaseService from '../services/purchase.service';
import { getStoreSettings } from '../services/settings.service';
import {
  exportFmtDateTime,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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
      search: req.query.search as string | undefined,
    });
    res.json({ purchases });
  })
);

router.get(
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const supplierId = req.query.supplierId as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const [purchases, settings] = await Promise.all([
      purchaseService.listSupplierPurchases({ supplierId, startDate, endDate, search }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalSpend = purchases.reduce((s, p) => s + p.totalCost, 0);
    const filterParts = [
      ...(supplierId ? [`Supplier: ${purchases[0]?.supplier.name || supplierId}`] : ['All Suppliers']),
      ...(startDate ? [`From: ${startDate}`] : []),
      ...(endDate ? [`To: ${endDate}`] : []),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    const lineRows = purchases.flatMap((p) =>
      p.items.map((it) => ({
        referenceNumber: p.referenceNumber,
        purchaseDate: exportFmtDateTime(p.purchaseDate),
        supplier: p.supplier.name,
        product: `${it.product.name} (${it.product.bottleSize})`,
        quantity: it.quantity,
        unitCostPrice: it.unitCostPrice,
        totalCost: it.totalCost,
      }))
    );

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-stock-purchases',
      title: 'Stock Purchases',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Deliveries Count', value: String(purchases.length) },
        { label: 'Total Stock Spend', value: exportFmtMoney(cur, totalSpend) },
      ],
      columns: [
        { header: 'Ref #', key: 'referenceNumber', width: 15 },
        {
          header: 'Date',
          key: 'purchaseDate',
          width: 17,
          format: (r) => exportFmtDateTime(r.purchaseDate),
        },
        {
          header: 'Supplier',
          key: 'supplierName',
          width: 20,
          format: (r) => r.supplier.name,
        },
        {
          header: 'Items',
          key: 'itemsSummary',
          width: 32,
          format: (r) =>
            r.items.map((it) => `${it.product.name} (${it.quantity})`).join(', '),
        },
        { header: `Total Cost (${cur})`, key: 'totalCost', width: 15, align: 'right', money: true },
        { header: 'Notes', key: 'notes', width: 20 },
      ],
      rows: purchases,
      extraExcelSheets: [
        {
          name: 'Purchase Line Items',
          columns: [
            { header: 'Ref #', key: 'referenceNumber', width: 15 },
            { header: 'Date', key: 'purchaseDate', width: 18 },
            { header: 'Supplier', key: 'supplier', width: 22 },
            { header: 'Product', key: 'product', width: 28 },
            { header: 'Quantity', key: 'quantity', width: 10 },
            { header: `Unit Cost (${cur})`, key: 'unitCostPrice', width: 15 },
            { header: `Line Total (${cur})`, key: 'totalCost', width: 15 },
          ],
          rows: lineRows,
        },
      ],
      store: settings,
    });
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

