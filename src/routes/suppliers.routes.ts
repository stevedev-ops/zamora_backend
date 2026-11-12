import { SupplierStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as supplierService from '../services/supplier.service';
import { getStoreSettings } from '../services/settings.service';
import {
  exportFmtDate,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const search = (req.query.search as string | undefined)?.trim();
    const status = req.query.status as SupplierStatus | undefined;

    const [suppliers, settings] = await Promise.all([
      supplierService.listSuppliers({ search, status }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalPurchased = suppliers.reduce((s, sup) => s + sup.totalPurchased, 0);
    const filterParts = [
      ...(search ? [`Search: "${search}"`] : []),
      ...(status ? [`Status: ${status}`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-suppliers',
      title: 'Suppliers Directory',
      filterSummary: filterParts.length > 0 ? filterParts.join(' | ') : 'All Suppliers',
      summaryRows: [
        { label: 'Suppliers Count', value: String(suppliers.length) },
        { label: 'Total Purchased Value', value: exportFmtMoney(cur, totalPurchased) },
      ],
      columns: [
        { header: 'Supplier Name', key: 'name', width: 22 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'Email', key: 'email', width: 22 },
        { header: 'Address', key: 'address', width: 20 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Products', key: 'productCount', width: 10, align: 'right' },
        { header: 'Deliveries', key: 'purchaseCount', width: 10, align: 'right' },
        {
          header: `Total Purchased (${cur})`,
          key: 'totalPurchased',
          width: 16,
          align: 'right',
          money: true,
        },
        {
          header: 'Last Delivery',
          key: 'lastPurchaseDate',
          width: 14,
          format: (r) => exportFmtDate(r.lastPurchaseDate),
        },
      ],
      rows: suppliers,
      store: settings,
    });
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

