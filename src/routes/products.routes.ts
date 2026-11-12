import { ProductStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as productService from '../services/product.service';
import { getStoreSettings } from '../services/settings.service';
import { exportFmtMoney, parseExportFormat, sendTableExport } from '../integrations/export';

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
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const search = (req.query.search as string | undefined)?.trim();
    const categoryId = req.query.categoryId as string | undefined;
    const status = req.query.status as ProductStatus | undefined;
    const lowStockOnly = req.query.lowStockOnly === 'true';

    const [products, settings] = await Promise.all([
      productService.listProducts({ search, categoryId, status, lowStockOnly }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalUnits = products.reduce((s, p) => s + p.currentStock, 0);
    const totalSalesValue = products.reduce((s, p) => s + p.potentialSalesValue, 0);
    const totalProfit = products.reduce((s, p) => s + p.potentialGrossProfit, 0);

    const filterParts = [
      ...(search ? [`Search: "${search}"`] : []),
      ...(categoryId ? [`Category: ${products[0]?.category?.name || categoryId}`] : []),
      ...(status ? [`Status: ${status}`] : []),
      ...(lowStockOnly ? ['Low Stock Only'] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-products',
      title: 'Products Catalog',
      filterSummary: filterParts.length > 0 ? filterParts.join(' | ') : 'All Products',
      summaryRows: [
        { label: 'Products Count', value: String(products.length) },
        { label: 'Total Stock Units', value: String(totalUnits) },
        { label: 'Potential Sales Value', value: exportFmtMoney(cur, totalSalesValue) },
        { label: 'Potential Gross Profit', value: exportFmtMoney(cur, totalProfit) },
      ],
      columns: [
        { header: 'Product', key: 'name', width: 22 },
        { header: 'Brand', key: 'brand', width: 15 },
        { header: 'Size', key: 'bottleSize', width: 10 },
        {
          header: 'Category',
          key: 'categoryName',
          width: 14,
          format: (r) => r.category?.name ?? '',
        },
        {
          header: 'Supplier',
          key: 'supplierName',
          width: 16,
          format: (r) => r.supplier?.name ?? '',
        },
        { header: 'Barcode', key: 'barcode', width: 14 },
        { header: `Buy (${cur})`, key: 'purchasePrice', width: 12, align: 'right', money: true },
        { header: `Sell (${cur})`, key: 'sellingPrice', width: 12, align: 'right', money: true },
        { header: 'Margin %', key: 'profitMarginPercent', width: 10, align: 'right' },
        { header: 'Stock', key: 'currentStock', width: 9, align: 'right' },
        { header: 'Min Alert', key: 'minStockAlert', width: 9, align: 'right' },
        { header: 'Status', key: 'status', width: 10 },
      ],
      rows: products,
      store: settings,
    });
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

