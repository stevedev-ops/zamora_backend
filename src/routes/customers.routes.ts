import { CustomerStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as customerService from '../services/customer.service';
import { getCustomerPortalDashboard } from '../services/portal.service';
import { getStoreSettings } from '../services/settings.service';
import { generateCustomerStatementPdf } from '../integrations/pdf';
import {
  exportFmtDate,
  exportFmtDateTime,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

const router = Router();
router.use(requireOwner);

const createCustomerSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(8).max(30),
  email: z.string().email().nullable().optional().or(z.literal('')),
  creditLimit: z.coerce.number().min(0).optional(),
  notes: z.string().max(500).nullable().optional(),
});

const updateCustomerSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  phone: z.string().min(8).max(30).optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
  notes: z.string().max(500).nullable().optional(),
});

const creditLimitSchema = z.object({
  limitAmount: z.coerce.number().min(0),
  reason: z.string().min(2).max(240),
});

const shareSchema = z.object({
  channel: z.enum(['SMS', 'WHATSAPP']),
});

const flagSaleItemSchema = z.object({
  isFlagged: z.boolean(),
  flagNote: z.string().max(240).nullable().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const customers = await customerService.listCustomers({
      search: req.query.search as string | undefined,
      status: req.query.status as CustomerStatus | undefined,
      hasDebt: req.query.hasDebt === 'true',
      aging: req.query.aging as customerService.AgingFilterBucket | undefined,
    });
    res.json({ customers });
  })
);

router.get(
  '/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const hasDebt = req.query.hasDebt === 'true';
    const search = (req.query.search as string | undefined)?.trim();
    const status = req.query.status as CustomerStatus | undefined;
    const aging = (req.query.aging as customerService.AgingFilterBucket | undefined) || 'ALL';

    const [customers, settings] = await Promise.all([
      customerService.listCustomers({ search, status, hasDebt, aging }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalDebt = customers.reduce((s, c) => s + c.currentDebt, 0);
    const totalCreditLimit = customers.reduce((s, c) => s + c.creditLimit, 0);
    const totalPurchases = customers.reduce((s, c) => s + c.totalPurchases, 0);
    const totalPayments = customers.reduce((s, c) => s + c.totalPayments, 0);

    const agingLabelMap: Record<string, string> = {
      '0_7': '0-7 Days',
      '8_30': '8-30 Days',
      '30_PLUS': '30+ Days',
    };
    const filterParts = [
      hasDebt ? 'Only Customers With Debt' : 'All Customers',
      ...(aging !== 'ALL' && agingLabelMap[aging] ? [`Aging: ${agingLabelMap[aging]}`] : []),
      ...(status ? [`Status: ${status}`] : []),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: hasDebt ? 'zamora-debtors' : 'zamora-customers',
      title: hasDebt ? 'Debtors List' : 'Customers Directory',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: hasDebt ? 'Debtors Count' : 'Customers Count', value: String(customers.length) },
        { label: 'Total Outstanding Debt', value: exportFmtMoney(cur, totalDebt) },
        { label: 'Total Credit Limits', value: exportFmtMoney(cur, totalCreditLimit) },
        { label: 'Total Purchases', value: exportFmtMoney(cur, totalPurchases) },
        { label: 'Total Payments', value: exportFmtMoney(cur, totalPayments) },
      ],
      columns: [
        { header: 'Account #', key: 'accountNumber', width: 14 },
        { header: 'Customer Name', key: 'fullName', width: 22 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'Status', key: 'status', width: 11 },
        { header: `Debt (${cur})`, key: 'currentDebt', width: 14, align: 'right', money: true },
        { header: `Limit (${cur})`, key: 'creditLimit', width: 14, align: 'right', money: true },
        { header: `Purchases (${cur})`, key: 'totalPurchases', width: 15, align: 'right', money: true },
        { header: `Payments (${cur})`, key: 'totalPayments', width: 15, align: 'right', money: true },
        { header: 'Days Idle', key: 'agingDays', width: 10, align: 'right' },
        {
          header: 'Last Activity',
          key: 'lastTransactionAt',
          width: 14,
          format: (r) => exportFmtDate(r.lastTransactionAt),
        },
      ],
      rows: customers,
      store: settings,
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const customer = await customerService.getCustomerProfile(req.params.id as string);
    res.json({ customer });
  })
);

router.post(
  '/',
  validateBody(createCustomerSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.createCustomer(
      { ...req.body, email: req.body.email || null },
      req.owner!.id,
      req.ip
    );
    res.status(201).json({ customer });
  })
);

router.patch(
  '/:id',
  validateBody(updateCustomerSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.updateCustomer(
      req.params.id as string,
      { ...req.body, email: req.body.email === '' ? null : req.body.email },
      req.owner!.id,
      req.ip
    );
    res.json({ customer });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await customerService.deleteCustomer(
      req.params.id as string,
      req.owner!.id,
      req.ip
    );
    res.json(result);
  })
);

router.post(
  '/:id/credit-limit',
  validateBody(creditLimitSchema),
  asyncHandler(async (req, res) => {
    const record = await customerService.updateCustomerCreditLimit(
      req.params.id as string,
      req.body.limitAmount,
      req.body.reason,
      req.owner!.id,
      req.ip
    );
    res.json({ creditLimit: record });
  })
);

router.post(
  '/:id/portal-link/regenerate',
  asyncHandler(async (req, res) => {
    const result = await customerService.regenerateCustomerPortalLink(
      req.params.id as string,
      req.owner!.id,
      req.ip
    );
    res.json(result);
  })
);

router.post(
  '/:id/share',
  validateBody(shareSchema),
  asyncHandler(async (req, res) => {
    const result = await customerService.shareCustomerPortalLink(
      req.params.id as string,
      req.body.channel,
      req.owner!.id
    );
    res.json(result);
  })
);

router.patch(
  '/:id/sale-items/:saleItemId/flag',
  validateBody(flagSaleItemSchema),
  asyncHandler(async (req, res) => {
    const item = await customerService.toggleSaleItemFlag({
      saleItemId: req.params.saleItemId as string,
      isFlagged: req.body.isFlagged,
      flagNote: req.body.flagNote,
      actorType: 'OWNER',
      actorId: req.owner!.id,
      scopeCustomerId: req.params.id as string,
      ipAddress: req.ip,
    });
    res.json({ item });
  })
);

router.get(
  '/:id/statement.pdf',
  asyncHandler(async (req, res) => {
    const [statement, settings] = await Promise.all([
      getCustomerPortalDashboard(req.params.id as string, {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
      }),
      getStoreSettings(),
    ]);
    const pdf = await generateCustomerStatementPdf(statement, settings);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="statement-${statement.customer.accountNumber}.pdf"`
    );
    res.send(pdf);
  })
);

router.get(
  '/:id/statement/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const [statement, settings] = await Promise.all([
      getCustomerPortalDashboard(req.params.id as string, { startDate, endDate }),
      getStoreSettings(),
    ]);

    if (format === 'pdf') {
      const pdf = await generateCustomerStatementPdf(statement, settings);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="statement-${statement.customer.accountNumber}.pdf"`
      );
      res.send(pdf);
      return;
    }

    const cur = settings.currency || 'KSh';
    const filterParts = [
      `Customer: ${statement.customer.fullName} (${statement.customer.accountNumber})`,
      ...(startDate ? [`From: ${startDate}`] : []),
      ...(endDate ? [`To: ${endDate}`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: `statement-${statement.customer.accountNumber}`,
      title: `Account Statement - ${statement.customer.fullName}`,
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Account Number', value: statement.customer.accountNumber },
        { label: 'Phone', value: statement.customer.phone },
        { label: 'Current Balance', value: exportFmtMoney(cur, statement.summary.currentBalance) },
        { label: 'Total Purchases', value: exportFmtMoney(cur, statement.summary.totalPurchases) },
        { label: 'Total Payments', value: exportFmtMoney(cur, statement.summary.totalPayments) },
      ],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 18,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        { header: 'Reference #', key: 'referenceNumber', width: 15 },
        { header: 'Type', key: 'transactionType', width: 18 },
        { header: 'Direction', key: 'direction', width: 10 },
        { header: 'Description', key: 'description', width: 32 },
        {
          header: 'Note / Reason',
          key: 'reason',
          width: 24,
          format: (r) => r.reason || r.sale?.notes || '',
        },
        { header: `Amount (${cur})`, key: 'amount', width: 15, align: 'right', money: true },
        { header: `Balance (${cur})`, key: 'runningBalance', width: 15, align: 'right', money: true },
      ],
      rows: statement.transactions,
      store: settings,
    });
  })
);

export default router;

