import { Router } from 'express';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import * as reportService from '../services/report.service';
import { getStoreSettings } from '../services/settings.service';
import { generateFinancialReportPdf } from '../integrations/pdf';
import { generateExcelWorkbook } from '../integrations/excel';
import { sendTableExport, parseExportFormat, exportFmtMoney, exportFmtDateTime } from '../integrations/export';

const router = Router();
router.use(requireOwner);

router.get(
  '/closing',
  asyncHandler(async (req, res) => {
    const rawOffset = req.query.tzOffsetMinutes as string | undefined;
    const tzOffsetMinutes =
      rawOffset !== undefined && !Number.isNaN(Number(rawOffset))
        ? Number(rawOffset)
        : undefined;
    const summary = await reportService.getDailyClosingSummary({
      date: req.query.date as string | undefined,
      tzOffsetMinutes,
    });
    res.json(summary);
  })
);

router.get(
  '/closing/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const rawOffset = req.query.tzOffsetMinutes as string | undefined;
    const tzOffsetMinutes =
      rawOffset !== undefined && !Number.isNaN(Number(rawOffset))
        ? Number(rawOffset)
        : undefined;

    const [closing, settings] = await Promise.all([
      reportService.getDailyClosingSummary({
        date: req.query.date as string | undefined,
        tzOffsetMinutes,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';

    await sendTableExport(res, {
      format,
      filenameBase: `zamora-closing-summary-${closing.date}`,
      title: `Daily Closing Summary (${closing.date})`,
      subtitle: `${closing.salesCount} sale(s) · ${closing.itemsSold} bottle(s) sold`,
      filterSummary: `Date: ${closing.date}`,
      summaryRows: [
        { label: 'Total Sold Today', value: exportFmtMoney(cur, closing.totalSold) },
        { label: 'Cash Sales', value: exportFmtMoney(cur, closing.breakdown.cash.amount) },
        { label: 'M-Pesa Sales', value: exportFmtMoney(cur, closing.breakdown.mpesa.amount) },
        { label: 'Debt Sales (Credit)', value: exportFmtMoney(cur, closing.breakdown.debt.amount) },
        {
          label: 'Debt Repayments (Cash / M-Pesa)',
          value: `${exportFmtMoney(cur, closing.repayments.cash)} / ${exportFmtMoney(cur, closing.repayments.mpesa)}`,
        },
        {
          label: 'Total Cash Collected (incl. Repayments)',
          value: exportFmtMoney(cur, closing.reconciliation.totalCashCollected),
        },
        {
          label: 'Total M-Pesa Collected (incl. Repayments)',
          value: exportFmtMoney(cur, closing.reconciliation.totalMpesaCollected),
        },
        {
          label: 'Expenses Today (Cash / M-Pesa)',
          value: `${exportFmtMoney(cur, closing.expenses.cash)} / ${exportFmtMoney(cur, closing.expenses.mpesa)}`,
        },
        { label: 'Net Cash in Drawer', value: exportFmtMoney(cur, closing.reconciliation.netCashInDrawer) },
        { label: 'Gross Profit', value: exportFmtMoney(cur, closing.grossProfit) },
      ],
      columns: [
        { header: 'Receipt #', key: 'receiptNumber', width: 14 },
        {
          header: 'Time',
          key: 'soldAt',
          width: 17,
          format: (r) => exportFmtDateTime(r.soldAt),
        },
        { header: 'Customer', key: 'customerName', width: 20 },
        { header: 'Method', key: 'paymentMethod', width: 10 },
        { header: 'Items', key: 'itemsSummary', width: 28 },
        { header: `Total (${cur})`, key: 'totalAmount', width: 13, align: 'right', money: true },
        { header: `Cash (${cur})`, key: 'cashAmount', width: 13, align: 'right', money: true },
        { header: `M-Pesa (${cur})`, key: 'mpesaAmount', width: 13, align: 'right', money: true },
        { header: `Debt (${cur})`, key: 'outstandingAmount', width: 13, align: 'right', money: true },
        { header: 'Note', key: 'notes', width: 22, format: (r) => r.notes || '' },
      ],
      rows: closing.sales,
      extraExcelSheets: [
        {
          name: 'Closing Summary',
          columns: [
            { header: 'Metric', key: 'metric', width: 34 },
            { header: `Amount (${cur})`, key: 'amount', width: 18 },
            { header: 'Count', key: 'count', width: 12 },
          ],
          rows: [
            { metric: 'Total Sold Today', amount: closing.totalSold, count: closing.salesCount },
            { metric: 'Cash Sales', amount: closing.breakdown.cash.amount, count: closing.breakdown.cash.count },
            { metric: 'M-Pesa Sales', amount: closing.breakdown.mpesa.amount, count: closing.breakdown.mpesa.count },
            { metric: 'Debt Sales (Credit)', amount: closing.breakdown.debt.amount, count: closing.breakdown.debt.count },
            { metric: 'Debt Repayments - Cash', amount: closing.repayments.cash, count: '' },
            { metric: 'Debt Repayments - M-Pesa', amount: closing.repayments.mpesa, count: '' },
            { metric: 'Total Cash Collected', amount: closing.reconciliation.totalCashCollected, count: '' },
            { metric: 'Total M-Pesa Collected', amount: closing.reconciliation.totalMpesaCollected, count: '' },
            { metric: 'Expenses - Cash', amount: closing.expenses.cash, count: '' },
            { metric: 'Expenses - M-Pesa', amount: closing.expenses.mpesa, count: '' },
            { metric: 'Net Cash in Drawer', amount: closing.reconciliation.netCashInDrawer, count: '' },
            { metric: 'Net M-Pesa Balance', amount: closing.reconciliation.netMpesaBalance, count: '' },
            { metric: 'Gross Profit', amount: closing.grossProfit, count: '' },
          ],
        },
        ...(closing.repayments.rows.length > 0
          ? [
              {
                name: 'Debt Repayments',
                columns: [
                  { header: 'Ref #', key: 'referenceNumber', width: 15 },
                  { header: 'Customer', key: 'customerName', width: 22 },
                  { header: 'Method', key: 'method', width: 12 },
                  { header: 'M-Pesa Ref', key: 'mpesaReference', width: 16 },
                  { header: `Amount (${cur})`, key: 'amount', width: 15 },
                ],
                rows: closing.repayments.rows.map((p) => ({
                  referenceNumber: p.referenceNumber,
                  customerName: p.customerName,
                  method: p.method,
                  mpesaReference: p.mpesaReference || '',
                  amount: p.amount,
                })),
              },
            ]
          : []),
      ],
      store: settings,
    });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const report = await reportService.getFinancialAnalyticsReport({
      preset: req.query.preset as reportService.DatePreset | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    });
    res.json(report);
  })
);

router.get(
  '/export/pdf',
  asyncHandler(async (req, res) => {
    const reportType = (req.query.type as string) || 'pnl';
    const [report, settings] = await Promise.all([
      reportService.getFinancialAnalyticsReport({
        preset: req.query.preset as reportService.DatePreset | undefined,
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency;
    const pnl = report.profitAndLoss;

    let title = 'Profit & Loss & Financial Report';
    let summaryRows = [
      { label: 'Net Sales Revenue', value: `${cur} ${pnl.netSalesRevenue.toFixed(2)}` },
      { label: 'Cost of Goods Sold (FIFO)', value: `${cur} ${pnl.costOfGoodsSold.toFixed(2)}` },
      { label: 'Gross Profit', value: `${cur} ${pnl.grossProfit.toFixed(2)} (${pnl.grossMarginPercent}%)` },
      { label: 'Operating Expenses', value: `${cur} ${pnl.totalOperatingExpenses.toFixed(2)}` },
      { label: 'Net Operating Profit', value: `${cur} ${pnl.netOperatingProfit.toFixed(2)}` },
      { label: 'Actual Cash/M-Pesa Collected', value: `${cur} ${pnl.cashVsCredit.totalActualCashCollected.toFixed(2)}` },
      { label: 'Credit Sales Issued (Period)', value: `${cur} ${pnl.cashVsCredit.creditSalesIssued.toFixed(2)}` },
      { label: 'Total Outstanding Customer Debt', value: `${cur} ${pnl.cashVsCredit.totalOutstandingCustomerDebt.toFixed(2)}` },
    ];
    let headers = ['Product', 'Units Sold', 'Revenue', 'COGS', 'Gross Profit', 'Margin %'];
    let rows = report.productProfitability.map((p) => [
      `${p.productName} (${p.bottleSize})`,
      String(p.unitsSold),
      p.totalRevenue.toFixed(2),
      p.cogs.toFixed(2),
      p.grossProfit.toFixed(2),
      `${p.profitMarginPercent}%`,
    ]);

    if (reportType === 'debt') {
      title = 'Customer Debt Report';
      summaryRows = [
        { label: 'Total Outstanding Debt', value: `${cur} ${report.customerDebtReport.totalOutstandingDebt.toFixed(2)}` },
        { label: 'Customers with Debt', value: String(report.customerDebtReport.debtorsCount) },
      ];
      headers = ['Account #', 'Customer', 'Phone', 'Current Debt', 'Credit Limit'];
      rows = report.customerDebtReport.rows.map((c) => [
        c.accountNumber,
        c.fullName,
        c.phone,
        c.currentBalance.toFixed(2),
        c.creditLimit.toFixed(2),
      ]);
    } else if (reportType === 'stock') {
      title = 'Stock Valuation Report';
      summaryRows = [
        { label: 'Total Units in Stock', value: String(report.stockValuationReport.totalUnits) },
        { label: 'Total Stock Cost Value', value: `${cur} ${report.stockValuationReport.totalCostValue.toFixed(2)}` },
        { label: 'Potential Retail Value', value: `${cur} ${report.stockValuationReport.totalRetailValue.toFixed(2)}` },
        { label: 'Potential Gross Profit', value: `${cur} ${report.stockValuationReport.potentialGrossProfit.toFixed(2)}` },
      ];
      headers = ['Category', 'Units', 'Cost Value', 'Retail Value'];
      rows = report.stockValuationReport.byCategory.map((c) => [
        c.category,
        String(c.units),
        c.costValue.toFixed(2),
        c.retailValue.toFixed(2),
      ]);
    }

    const pdf = await generateFinancialReportPdf(
      title,
      report.period.label,
      summaryRows,
      headers,
      rows,
      settings
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="zamora-${reportType}-report.pdf"`);
    res.send(pdf);
  })
);

router.get(
  '/export/excel',
  asyncHandler(async (req, res) => {
    const report = await reportService.getFinancialAnalyticsReport({
      preset: req.query.preset as reportService.DatePreset | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    });

    const pnl = report.profitAndLoss;
    const buffer = await generateExcelWorkbook([
      {
        name: 'Profit & Loss',
        columns: [
          { header: 'Metric', key: 'metric', width: 35 },
          { header: 'Amount (KSh)', key: 'amount', width: 20 },
        ],
        rows: [
          { metric: 'Period', amount: report.period.label },
          { metric: 'Net Sales Revenue', amount: pnl.netSalesRevenue },
          { metric: 'Cost of Goods Sold (FIFO)', amount: pnl.costOfGoodsSold },
          { metric: 'Gross Profit', amount: pnl.grossProfit },
          { metric: 'Operating Expenses', amount: pnl.totalOperatingExpenses },
          { metric: 'Net Operating Profit', amount: pnl.netOperatingProfit },
          { metric: 'POS Cash & M-Pesa Collected', amount: pnl.cashVsCredit.posTotalCollected },
          { metric: 'Customer Debt Repayments', amount: pnl.cashVsCredit.totalDebtRepayments },
          { metric: 'Total Actual Cash Collected', amount: pnl.cashVsCredit.totalActualCashCollected },
          { metric: 'Credit Sales Issued', amount: pnl.cashVsCredit.creditSalesIssued },
          { metric: 'Total Outstanding Customer Debt', amount: pnl.cashVsCredit.totalOutstandingCustomerDebt },
        ],
      },
      {
        name: 'Product Profitability',
        columns: [
          { header: 'Product', key: 'product', width: 28 },
          { header: 'Brand', key: 'brand', width: 18 },
          { header: 'Size', key: 'size', width: 12 },
          { header: 'Units Sold', key: 'units', width: 12 },
          { header: 'Revenue', key: 'revenue', width: 15 },
          { header: 'COGS', key: 'cogs', width: 15 },
          { header: 'Gross Profit', key: 'profit', width: 15 },
          { header: 'Margin %', key: 'margin', width: 12 },
        ],
        rows: report.productProfitability.map((p) => ({
          product: p.productName,
          brand: p.brand,
          size: p.bottleSize,
          units: p.unitsSold,
          revenue: p.totalRevenue,
          cogs: p.cogs,
          profit: p.grossProfit,
          margin: p.profitMarginPercent,
        })),
      },
      {
        name: 'Customer Debt',
        columns: [
          { header: 'Account #', key: 'account', width: 14 },
          { header: 'Customer', key: 'name', width: 24 },
          { header: 'Phone', key: 'phone', width: 18 },
          { header: 'Current Debt', key: 'debt', width: 16 },
          { header: 'Credit Limit', key: 'limit', width: 16 },
        ],
        rows: report.customerDebtReport.rows.map((c) => ({
          account: c.accountNumber,
          name: c.fullName,
          phone: c.phone,
          debt: c.currentBalance,
          limit: c.creditLimit,
        })),
      },
      {
        name: 'Expenses',
        columns: [
          { header: 'Ref', key: 'ref', width: 14 },
          { header: 'Category', key: 'category', width: 16 },
          { header: 'Title', key: 'title', width: 28 },
          { header: 'Amount', key: 'amount', width: 16 },
          { header: 'Method', key: 'method', width: 14 },
          { header: 'Date', key: 'date', width: 20 },
        ],
        rows: report.expenses.map((e) => ({
          ref: e.referenceNumber,
          category: e.category,
          title: e.title,
          amount: e.amount,
          method: e.paymentMethod,
          date: new Date(e.expenseDate).toISOString().slice(0, 10),
        })),
      },
    ]);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="zamora-financial-report.xlsx"');
    res.send(buffer);
  })
);

router.get(
  '/export/csv',
  asyncHandler(async (req, res) => {
    const reportType = (req.query.type as string) || 'pnl';
    const [report, settings] = await Promise.all([
      reportService.getFinancialAnalyticsReport({
        preset: req.query.preset as reportService.DatePreset | undefined,
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
      }),
      getStoreSettings(),
    ]);

    const cur = settings.currency || 'KSh';

    if (reportType === 'debt') {
      await sendTableExport(res, {
        format: 'csv',
        filenameBase: 'zamora-debt-report',
        title: 'Customer Debt Report',
        columns: [
          { header: 'Account #', key: 'accountNumber' },
          { header: 'Customer', key: 'fullName' },
          { header: 'Phone', key: 'phone' },
          { header: `Current Debt (${cur})`, key: 'currentBalance', money: true },
          { header: `Credit Limit (${cur})`, key: 'creditLimit', money: true },
        ],
        rows: report.customerDebtReport.rows,
        store: settings,
      });
      return;
    }

    if (reportType === 'stock') {
      await sendTableExport(res, {
        format: 'csv',
        filenameBase: 'zamora-stock-valuation',
        title: 'Stock Valuation Report',
        columns: [
          { header: 'Category', key: 'category' },
          { header: 'Units', key: 'units' },
          { header: `Cost Value (${cur})`, key: 'costValue', money: true },
          { header: `Retail Value (${cur})`, key: 'retailValue', money: true },
        ],
        rows: report.stockValuationReport.byCategory,
        store: settings,
      });
      return;
    }

    if (reportType === 'products') {
      await sendTableExport(res, {
        format: 'csv',
        filenameBase: 'zamora-product-profitability',
        title: 'Product Profitability Report',
        columns: [
          { header: 'Product', key: 'productName' },
          { header: 'Brand', key: 'brand' },
          { header: 'Size', key: 'bottleSize' },
          { header: 'Units Sold', key: 'unitsSold' },
          { header: `Revenue (${cur})`, key: 'totalRevenue', money: true },
          { header: `COGS (${cur})`, key: 'cogs', money: true },
          { header: `Gross Profit (${cur})`, key: 'grossProfit', money: true },
          { header: 'Margin %', key: 'profitMarginPercent' },
        ],
        rows: report.productProfitability,
        store: settings,
      });
      return;
    }

    const pnl = report.profitAndLoss;
    await sendTableExport(res, {
      format: 'csv',
      filenameBase: 'zamora-pnl-report',
      title: 'Profit & Loss Report',
      columns: [
        { header: 'Metric', key: 'metric' },
        { header: `Value (${cur})`, key: 'amount' },
      ],
      rows: [
        { metric: 'Period', amount: report.period.label },
        { metric: 'Net Sales Revenue', amount: pnl.netSalesRevenue },
        { metric: 'Cost of Goods Sold (FIFO)', amount: pnl.costOfGoodsSold },
        { metric: 'Gross Profit', amount: pnl.grossProfit },
        { metric: 'Operating Expenses', amount: pnl.totalOperatingExpenses },
        { metric: 'Net Operating Profit', amount: pnl.netOperatingProfit },
        { metric: 'POS Cash & M-Pesa Collected', amount: pnl.cashVsCredit.posTotalCollected },
        { metric: 'Customer Debt Repayments', amount: pnl.cashVsCredit.totalDebtRepayments },
        { metric: 'Total Actual Cash Collected', amount: pnl.cashVsCredit.totalActualCashCollected },
        { metric: 'Credit Sales Issued', amount: pnl.cashVsCredit.creditSalesIssued },
        {
          metric: 'Total Outstanding Customer Debt',
          amount: pnl.cashVsCredit.totalOutstandingCustomerDebt,
        },
      ],
      store: settings,
    });
  })
);

export default router;

