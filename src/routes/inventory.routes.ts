import { InventoryMovementType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as inventoryService from '../services/inventory.service';
import { getStoreSettings } from '../services/settings.service';
import {
  exportFmtDate,
  exportFmtDateTime,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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

router.get(
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const search = (req.query.search as string | undefined)?.trim();
    const lowStockOnly = req.query.lowStockOnly === 'true';

    const [overview, settings] = await Promise.all([
      inventoryService.getInventoryOverview({ search, lowStockOnly }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const filterParts = [
      ...(lowStockOnly ? ['Low Stock Only'] : ['All Active Stock']),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    const batchRows = overview.items.flatMap((item) =>
      item.activeBatches.map((b) => ({
        productName: item.name,
        brand: item.brand,
        bottleSize: item.bottleSize,
        batchNumber: b.batchNumber,
        purchaseDate: exportFmtDate(b.purchaseDate),
        referenceNumber: b.referenceNumber || '',
        initialQuantity: b.initialQuantity,
        remainingQuantity: b.remainingQuantity,
        unitCostPrice: b.unitCostPrice,
      }))
    );

    await sendTableExport(res, {
      format,
      filenameBase: lowStockOnly ? 'zamora-low-stock-inventory' : 'zamora-inventory',
      title: 'Inventory Stock & Valuation',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Matching Products', value: String(overview.items.length) },
        { label: 'Total Units in Stock', value: String(overview.totals.totalUnits) },
        { label: 'Total FIFO Cost Value', value: exportFmtMoney(cur, overview.totals.totalCostValue) },
        { label: 'Potential Retail Value', value: exportFmtMoney(cur, overview.totals.totalRetailValue) },
        { label: 'Estimated Gross Profit', value: exportFmtMoney(cur, overview.totals.potentialGrossProfit) },
        { label: 'Low Stock Items', value: String(overview.totals.lowStockCount) },
      ],
      columns: [
        { header: 'Product', key: 'name', width: 22 },
        { header: 'Brand', key: 'brand', width: 14 },
        { header: 'Size', key: 'bottleSize', width: 9 },
        { header: 'Category', key: 'categoryName', width: 13 },
        { header: 'Supplier', key: 'supplierName', width: 15 },
        { header: 'Stock', key: 'currentStock', width: 8, align: 'right' },
        { header: 'Min', key: 'minStockAlert', width: 7, align: 'right' },
        {
          header: 'Status',
          key: 'isLowStock',
          width: 10,
          format: (r) => (r.isLowStock ? 'LOW STOCK' : 'OK'),
        },
        { header: `FIFO Cost (${cur})`, key: 'stockCostValue', width: 14, align: 'right', money: true },
        {
          header: `Retail Val (${cur})`,
          key: 'potentialRetailValue',
          width: 14,
          align: 'right',
          money: true,
        },
        { header: `Est. Profit (${cur})`, key: 'potentialProfit', width: 14, align: 'right', money: true },
      ],
      rows: overview.items,
      extraExcelSheets: [
        {
          name: 'FIFO Batches',
          columns: [
            { header: 'Product', key: 'productName', width: 24 },
            { header: 'Brand', key: 'brand', width: 16 },
            { header: 'Size', key: 'bottleSize', width: 10 },
            { header: 'Batch #', key: 'batchNumber', width: 18 },
            { header: 'Purchase Date', key: 'purchaseDate', width: 14 },
            { header: 'Reference #', key: 'referenceNumber', width: 16 },
            { header: 'Initial Qty', key: 'initialQuantity', width: 12 },
            { header: 'Remaining Qty', key: 'remainingQuantity', width: 14 },
            { header: `Unit Cost (${cur})`, key: 'unitCostPrice', width: 14 },
          ],
          rows: batchRows,
        },
      ],
      store: settings,
    });
  })
);

router.get(
  '/movements/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const productId = req.query.productId as string | undefined;
    const movementType = req.query.movementType as InventoryMovementType | undefined;

    const [movements, settings] = await Promise.all([
      inventoryService.listInventoryMovements({
        productId,
        movementType,
        limit: 5000,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const filterParts = [
      ...(movementType ? [`Type: ${movementType}`] : ['All Movement Types']),
      ...(productId ? [`Product: ${movements[0]?.product.name || productId}`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-inventory-movements',
      title: 'Inventory Movement Ledger',
      filterSummary: filterParts.join(' | '),
      summaryRows: [{ label: 'Movements Count', value: String(movements.length) }],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        {
          header: 'Product',
          key: 'productName',
          width: 22,
          format: (r) => `${r.product.name} (${r.product.bottleSize})`,
        },
        { header: 'Type', key: 'movementType', width: 15 },
        {
          header: 'Batch #',
          key: 'batchNumber',
          width: 15,
          format: (r) => r.inventoryBatch?.batchNumber || '',
        },
        { header: 'Change', key: 'quantityChange', width: 9, align: 'right' },
        {
          header: 'Before -> After',
          key: 'stockShift',
          width: 14,
          format: (r) => `${r.quantityBefore} -> ${r.quantityAfter}`,
        },
        { header: `Total Cost (${cur})`, key: 'totalCostValue', width: 14, align: 'right', money: true },
        { header: 'Reason', key: 'reason', width: 24 },
        {
          header: 'User',
          key: 'userName',
          width: 14,
          format: (r) => r.createdByUser?.name || '',
        },
      ],
      rows: movements,
      store: settings,
    });
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

