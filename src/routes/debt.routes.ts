import { DebtTransactionType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, NotFoundError } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as debtService from '../services/debt.service';
import { getStoreSettings } from '../services/settings.service';
import { generatePaymentReceiptPdf } from '../integrations/pdf';
import {
  exportFmtDateTime,
  exportFmtMoney,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

const router = Router();
router.use(requireOwner);

const repaymentSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  method: z.enum(['CASH', 'MPESA', 'BANK_TRANSFER', 'OTHER']),
  mpesaReference: z.string().max(80).optional(),
  notes: z.string().max(300).optional(),
  idempotencyKey: z.string().max(120).optional(),
});

const transferSchema = z.object({
  fromCustomerId: z.string().uuid(),
  toCustomerId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  reason: z.string().min(3).max(300),
  idempotencyKey: z.string().max(120).optional(),
});

const acceptTransferSchema = z.object({
  otp: z.string().min(4).max(10),
});

const adjustmentSchema = z.object({
  customerId: z.string().uuid(),
  adjustmentKind: z.enum(['ADD_DEBT', 'DEDUCT_ERROR', 'DISCOUNT_OR_WRITEOFF']),
  amount: z.coerce.number().positive(),
  reason: z.string().max(300).optional(),
  notes: z.string().max(300).optional(),
  idempotencyKey: z.string().max(120).optional(),
});

const reverseSchema = z.object({
  reason: z.string().min(3).max(300),
});

const resolveClarificationSchema = z.object({
  ownerResponse: z.string().min(2).max(500),
});

router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const transactions = await debtService.listDebtTransactions({
      customerId: req.query.customerId as string | undefined,
      transactionType: req.query.transactionType as DebtTransactionType | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ transactions });
  })
);

router.get(
  '/transactions/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const customerId = req.query.customerId as string | undefined;
    const transactionType = req.query.transactionType as DebtTransactionType | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const [transactions, settings] = await Promise.all([
      debtService.listDebtTransactions({
        customerId,
        transactionType,
        startDate,
        endDate,
        search,
        limit: 5000,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalDebits = transactions
      .filter((t) => t.direction === 'DEBIT')
      .reduce((s, t) => s + t.amount, 0);
    const totalCredits = transactions
      .filter((t) => t.direction === 'CREDIT')
      .reduce((s, t) => s + t.amount, 0);

    const filterParts = [
      ...(customerId ? [`Customer ID: ${customerId}`] : ['All Customers']),
      ...(transactionType ? [`Type: ${transactionType}`] : []),
      ...(startDate ? [`From: ${startDate}`] : []),
      ...(endDate ? [`To: ${endDate}`] : []),
      ...(search ? [`Search: "${search}"`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-debt-ledger',
      title: 'Debt Ledger Transactions',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Transactions Count', value: String(transactions.length) },
        { label: 'Total Debits (+)', value: exportFmtMoney(cur, totalDebits) },
        { label: 'Total Credits (-)', value: exportFmtMoney(cur, totalCredits) },
      ],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        { header: 'Ref #', key: 'referenceNumber', width: 14 },
        {
          header: 'Customer',
          key: 'customerName',
          width: 20,
          format: (r) => `${r.customer.fullName} (${r.customer.accountNumber})`,
        },
        { header: 'Type', key: 'transactionType', width: 16 },
        { header: 'Dir', key: 'direction', width: 9 },
        { header: 'Description', key: 'description', width: 28 },
        { header: `Amount (${cur})`, key: 'amount', width: 14, align: 'right', money: true },
        {
          header: `Balance (${cur})`,
          key: 'runningBalance',
          width: 14,
          align: 'right',
          money: true,
        },
      ],
      rows: transactions,
      store: settings,
    });
  })
);

router.get(
  '/transfers/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const customerId = req.query.customerId as string | undefined;
    const status = req.query.status as string | undefined;

    const [transfers, settings] = await Promise.all([
      debtService.listDebtTransfers({ customerId, status }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';
    const totalAmount = transfers.reduce((s, t) => s + t.amount, 0);
    const filterParts = [
      ...(customerId ? [`Customer ID: ${customerId}`] : ['All Customers']),
      ...(status ? [`Status: ${status}`] : []),
    ];

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-debt-transfers',
      title: 'Debt Transfers Log',
      filterSummary: filterParts.join(' | '),
      summaryRows: [
        { label: 'Transfers Count', value: String(transfers.length) },
        { label: 'Total Transfer Volume', value: exportFmtMoney(cur, totalAmount) },
      ],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        { header: 'Ref #', key: 'referenceNumber', width: 14 },
        {
          header: 'From Customer',
          key: 'fromName',
          width: 20,
          format: (r) => `${r.fromCustomer.fullName} (${r.fromCustomer.accountNumber})`,
        },
        {
          header: 'To Customer',
          key: 'toName',
          width: 20,
          format: (r) => `${r.toCustomer.fullName} (${r.toCustomer.accountNumber})`,
        },
        { header: `Amount (${cur})`, key: 'amount', width: 14, align: 'right', money: true },
        { header: 'Status', key: 'status', width: 16 },
        { header: 'Reason', key: 'reason', width: 26 },
      ],
      rows: transfers,
      store: settings,
    });
  })
);

router.get(
  '/clarifications/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const [requests, settings] = await Promise.all([
      debtService.listClarificationRequests(),
      getStoreSettings(),
    ]);

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-debt-clarifications',
      title: 'Customer Clarification Requests',
      summaryRows: [
        { label: 'Total Requests', value: String(requests.length) },
        {
          label: 'Open Requests',
          value: String(requests.filter((r) => r.status === 'OPEN').length),
        },
      ],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        {
          header: 'Customer',
          key: 'customerName',
          width: 20,
          format: (r) => `${r.customer.fullName} (${r.customer.accountNumber})`,
        },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Message', key: 'message', width: 32 },
        { header: 'Owner Response', key: 'ownerResponse', width: 30 },
      ],
      rows: requests,
      store: settings,
    });
  })
);

router.post(
  '/repayments',
  validateBody(repaymentSchema),
  asyncHandler(async (req, res) => {
    const result = await debtService.recordDebtRepayment(req.body, req.owner!.id, req.ip);
    res.status(201).json(result);
  })
);

router.get(
  '/payments/:id/receipt.pdf',
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id as string },
      include: { customer: { include: { account: true } } },
    });
    if (!payment || !payment.customer) {
      throw new NotFoundError('Customer payment receipt not found');
    }
    const settings = await getStoreSettings();
    const pdf = await generatePaymentReceiptPdf(
      payment,
      {
        fullName: payment.customer.fullName,
        accountNumber: payment.customer.accountNumber,
        phone: payment.customer.phone,
        currentBalance: payment.customer.account?.currentBalance ?? 0,
      },
      settings
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payment-${payment.referenceNumber}.pdf"`
    );
    res.send(pdf);
  })
);

router.get(
  '/transfers',
  asyncHandler(async (req, res) => {
    const transfers = await debtService.listDebtTransfers({
      customerId: req.query.customerId as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json({ transfers });
  })
);

router.post(
  '/transfers',
  validateBody(transferSchema),
  asyncHandler(async (req, res) => {
    const result = await debtService.initiateDebtTransfer(req.body, req.owner!.id, req.ip);
    res.status(201).json(result);
  })
);

router.post(
  '/transfers/:id/accept',
  validateBody(acceptTransferSchema),
  asyncHandler(async (req, res) => {
    const result = await debtService.finalizeDebtTransferAcceptance({
      transferId: req.params.id as string,
      otp: req.body.otp,
      acceptedMethod: 'OTP_OWNER',
      userId: req.owner!.id,
      ipAddress: req.ip,
    });
    res.json(result);
  })
);

router.post(
  '/transfers/:id/cancel',
  asyncHandler(async (req, res) => {
    const result = await debtService.rejectOrCancelDebtTransfer({
      transferId: req.params.id as string,
      action: 'CANCELLED',
      userId: req.owner!.id,
    });
    res.json({ transfer: result });
  })
);

router.post(
  '/adjustments',
  validateBody(adjustmentSchema),
  asyncHandler(async (req, res) => {
    const result = await debtService.adjustCustomerDebt(req.body, req.owner!.id, req.ip);
    res.status(201).json(result);
  })
);

router.post(
  '/transactions/:id/reverse',
  validateBody(reverseSchema),
  asyncHandler(async (req, res) => {
    const result = await debtService.reverseDebtTransaction(
      req.params.id as string,
      req.body.reason,
      req.owner!.id,
      req.ip
    );
    res.status(201).json(result);
  })
);

router.get(
  '/clarifications',
  asyncHandler(async (_req, res) => {
    const requests = await debtService.listClarificationRequests();
    res.json({ requests });
  })
);

router.post(
  '/clarifications/:id/resolve',
  validateBody(resolveClarificationSchema),
  asyncHandler(async (req, res) => {
    const updated = await debtService.resolveClarificationRequest(
      req.params.id as string,
      req.body.ownerResponse,
      req.owner!.id
    );
    res.json({ request: updated });
  })
);

router.post(
  '/reminders/overdue',
  asyncHandler(async (req, res) => {
    const result = await debtService.sendOverdueDebtReminders(req.owner!.id);
    res.json(result);
  })
);

export default router;

