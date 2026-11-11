import { prisma } from '../lib/prisma';
import { calculateMarginPercent, toNumber } from '../lib/money';

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom';

export function resolveDateRange(params: {
  preset?: DatePreset;
  startDate?: string;
  endDate?: string;
}): { start: Date; end: Date; label: string } {
  const now = new Date();
  const preset = params.preset || 'this_month';

  if (preset === 'custom' && (params.startDate || params.endDate)) {
    const start = params.startDate ? new Date(params.startDate) : new Date(2020, 0, 1);
    start.setHours(0, 0, 0, 0);
    const end = params.endDate ? new Date(params.endDate) : new Date();
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
    };
  }

  if (preset === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'Today' };
  }

  if (preset === 'yesterday') {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'Yesterday' };
  }

  if (preset === 'this_week') {
    const start = new Date(now);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'This Week' };
  }

  if (preset === 'last_month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start, end, label: 'Last Month' };
  }

  if (preset === 'this_year') {
    const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: `Year ${now.getFullYear()}` };
  }

  // Default: this_month
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end, label: 'This Month' };
}

export async function getFinancialAnalyticsReport(params: {
  preset?: DatePreset;
  startDate?: string;
  endDate?: string;
}) {
  const range = resolveDateRange(params);

  const [sales, payments, expenses, activeBatches, products, customers, movements] =
    await Promise.all([
      prisma.sale.findMany({
        where: {
          status: 'COMPLETED',
          soldAt: { gte: range.start, lte: range.end },
        },
        include: {
          customer: { select: { id: true, fullName: true, accountNumber: true } },
          items: true,
        },
        orderBy: { soldAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: {
          paidAt: { gte: range.start, lte: range.end },
        },
        include: {
          customer: { select: { id: true, fullName: true, accountNumber: true } },
        },
        orderBy: { paidAt: 'desc' },
      }),
      prisma.expense.findMany({
        where: {
          expenseDate: { gte: range.start, lte: range.end },
        },
        orderBy: { expenseDate: 'desc' },
      }),
      prisma.inventoryBatch.findMany({
        where: { remainingQuantity: { gt: 0 } },
        include: { product: { include: { category: true } } },
      }),
      prisma.product.findMany({
        include: { category: true },
      }),
      prisma.customer.findMany({
        include: { account: true },
        orderBy: { account: { currentBalance: 'desc' } },
      }),
      prisma.inventoryMovement.findMany({
        where: { createdAt: { gte: range.start, lte: range.end } },
        include: { product: { select: { name: true, bottleSize: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

  // 1. Sales & P&L Summary (Recognizing Gross Profit on completed sales, distinguishing Cash vs Credit)
  let subtotalSales = 0;
  let totalDiscounts = 0;
  let netSalesRevenue = 0;
  let totalCogs = 0;
  let totalGrossProfit = 0;
  let posCashCollected = 0;
  let posMpesaCollected = 0;
  let posAmountPaid = 0;
  let creditIssued = 0;

  const dailyTrendMap = new Map<
    string,
    {
      date: string;
      revenue: number;
      cogs: number;
      grossProfit: number;
      cashCollected: number;
      creditIssued: number;
    }
  >();

  const productPerfMap = new Map<
    string,
    {
      productId: string;
      productName: string;
      brand: string;
      bottleSize: string;
      categoryName: string;
      currentPurchasePrice: number;
      currentSellingPrice: number;
      unitsSold: number;
      totalRevenue: number;
      cogs: number;
      grossProfit: number;
    }
  >();

  const productCatalogMap = new Map(products.map((p) => [p.id, p]));

  for (const s of sales) {
    const sub = toNumber(s.subtotal);
    const disc = toNumber(s.discountAmount);
    const total = toNumber(s.totalAmount);
    const cost = toNumber(s.totalCost);
    const profit = toNumber(s.grossProfit);
    const cash = toNumber(s.cashAmount);
    const mpesa = toNumber(s.mpesaAmount);
    const paid = toNumber(s.amountPaid);
    const credit = toNumber(s.outstandingAmount);

    subtotalSales += sub;
    totalDiscounts += disc;
    netSalesRevenue += total;
    totalCogs += cost;
    totalGrossProfit += profit;
    posCashCollected += cash;
    posMpesaCollected += mpesa;
    posAmountPaid += paid;
    creditIssued += credit;

    const dayKey = s.soldAt.toISOString().slice(0, 10);
    const dayEntry = dailyTrendMap.get(dayKey) ?? {
      date: dayKey,
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      cashCollected: 0,
      creditIssued: 0,
    };
    dayEntry.revenue = Number((dayEntry.revenue + total).toFixed(2));
    dayEntry.cogs = Number((dayEntry.cogs + cost).toFixed(2));
    dayEntry.grossProfit = Number((dayEntry.grossProfit + profit).toFixed(2));
    dayEntry.cashCollected = Number((dayEntry.cashCollected + paid).toFixed(2));
    dayEntry.creditIssued = Number((dayEntry.creditIssued + credit).toFixed(2));
    dailyTrendMap.set(dayKey, dayEntry);

    for (const item of s.items) {
      const catProd = productCatalogMap.get(item.productId);
      const existing = productPerfMap.get(item.productId) ?? {
        productId: item.productId,
        productName: item.productName,
        brand: item.brand,
        bottleSize: item.bottleSize,
        categoryName: catProd?.category.name || 'Other',
        currentPurchasePrice: catProd ? toNumber(catProd.purchasePrice) : toNumber(item.unitCostPrice),
        currentSellingPrice: catProd
          ? toNumber(catProd.sellingPrice)
          : toNumber(item.unitSellingPrice),
        unitsSold: 0,
        totalRevenue: 0,
        cogs: 0,
        grossProfit: 0,
      };
      existing.unitsSold += item.quantity;
      existing.totalRevenue = Number((existing.totalRevenue + toNumber(item.lineTotal)).toFixed(2));
      existing.cogs = Number((existing.cogs + toNumber(item.lineCost)).toFixed(2));
      existing.grossProfit = Number(
        (existing.grossProfit + toNumber(item.lineProfit)).toFixed(2)
      );
      productPerfMap.set(item.productId, existing);
    }
  }

  // 2. Debt Repayments vs POS Collections
  let debtRepaymentsCash = 0;
  let debtRepaymentsMpesa = 0;
  let debtRepaymentsOther = 0;
  for (const p of payments) {
    if (p.paymentType === 'DEBT_REPAYMENT') {
      const amt = toNumber(p.amount);
      if (p.method === 'CASH') debtRepaymentsCash += amt;
      else if (p.method === 'MPESA') debtRepaymentsMpesa += amt;
      else debtRepaymentsOther += amt;
    }
  }
  const totalDebtRepayments = debtRepaymentsCash + debtRepaymentsMpesa + debtRepaymentsOther;
  const totalActualCashCollected = posAmountPaid + totalDebtRepayments;

  // 3. Operating Expenses & Net Operating Profit
  const expenseByCategoryMap = new Map<string, number>();
  let totalOperatingExpenses = 0;
  for (const exp of expenses) {
    const amt = toNumber(exp.amount);
    totalOperatingExpenses += amt;
    expenseByCategoryMap.set(
      exp.category,
      Number(((expenseByCategoryMap.get(exp.category) ?? 0) + amt).toFixed(2))
    );
  }
  const netOperatingProfit = Number((totalGrossProfit - totalOperatingExpenses).toFixed(2));

  // 4. Product Profitability list
  const productProfitability = Array.from(productPerfMap.values())
    .map((p) => ({
      ...p,
      profitPerUnitAvg: p.unitsSold > 0 ? Number((p.grossProfit / p.unitsSold).toFixed(2)) : 0,
      profitMarginPercent: calculateMarginPercent(p.grossProfit, p.totalRevenue),
    }))
    .sort((a, b) => b.grossProfit - a.grossProfit);

  const bestSellingProducts = [...productProfitability]
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, 10);

  // 5. Stock Valuation
  let totalStockCostValuation = 0;
  let totalStockRetailValuation = 0;
  let totalUnitsInStock = 0;
  const valuationByCategory = new Map<
    string,
    { category: string; units: number; costValue: number; retailValue: number }
  >();

  for (const batch of activeBatches) {
    const qty = batch.remainingQuantity;
    const costVal = qty * toNumber(batch.unitCostPrice);
    const retailVal = qty * toNumber(batch.product.sellingPrice);
    totalUnitsInStock += qty;
    totalStockCostValuation += costVal;
    totalStockRetailValuation += retailVal;

    const catName = batch.product.category.name;
    const entry = valuationByCategory.get(catName) ?? {
      category: catName,
      units: 0,
      costValue: 0,
      retailValue: 0,
    };
    entry.units += qty;
    entry.costValue = Number((entry.costValue + costVal).toFixed(2));
    entry.retailValue = Number((entry.retailValue + retailVal).toFixed(2));
    valuationByCategory.set(catName, entry);
  }

  // 6. Customer Debt Report
  const nowMs = Date.now();
  const customerDebtRows = customers
    .map((c) => {
      const balance = toNumber(c.account?.currentBalance ?? 0);
      const lastTx = c.account?.lastTransactionAt;
      const daysSinceLastTx = lastTx
        ? Math.floor((nowMs - new Date(lastTx).getTime()) / (24 * 60 * 60 * 1000))
        : 0;
      return {
        id: c.id,
        accountNumber: c.accountNumber,
        fullName: c.fullName,
        phone: c.phone,
        status: c.status,
        currentBalance: balance,
        creditLimit: toNumber(c.account?.creditLimit ?? 0),
        totalPurchases: toNumber(c.account?.totalPurchases ?? 0),
        totalPayments: toNumber(c.account?.totalPayments ?? 0),
        lastTransactionAt: lastTx ?? null,
        daysSinceLastTx,
      };
    })
    .filter((c) => c.currentBalance > 0 || c.totalPurchases > 0);

  const totalOutstandingDebt = customerDebtRows.reduce((sum, c) => sum + c.currentBalance, 0);

  return {
    period: {
      label: range.label,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
    },
    profitAndLoss: {
      salesCount: sales.length,
      subtotalSales: Number(subtotalSales.toFixed(2)),
      totalDiscounts: Number(totalDiscounts.toFixed(2)),
      netSalesRevenue: Number(netSalesRevenue.toFixed(2)),
      costOfGoodsSold: Number(totalCogs.toFixed(2)),
      grossProfit: Number(totalGrossProfit.toFixed(2)),
      grossMarginPercent: calculateMarginPercent(totalGrossProfit, netSalesRevenue),
      totalOperatingExpenses: Number(totalOperatingExpenses.toFixed(2)),
      expensesByCategory: Array.from(expenseByCategoryMap.entries()).map(([category, amount]) => ({
        category,
        amount,
      })),
      netOperatingProfit,
      netMarginPercent: calculateMarginPercent(netOperatingProfit, netSalesRevenue),
      cashVsCredit: {
        posCashCollected: Number(posCashCollected.toFixed(2)),
        posMpesaCollected: Number(posMpesaCollected.toFixed(2)),
        posTotalCollected: Number(posAmountPaid.toFixed(2)),
        creditSalesIssued: Number(creditIssued.toFixed(2)),
        debtRepaymentsCash: Number(debtRepaymentsCash.toFixed(2)),
        debtRepaymentsMpesa: Number(debtRepaymentsMpesa.toFixed(2)),
        debtRepaymentsOther: Number(debtRepaymentsOther.toFixed(2)),
        totalDebtRepayments: Number(totalDebtRepayments.toFixed(2)),
        totalActualCashCollected: Number(totalActualCashCollected.toFixed(2)),
        totalOutstandingCustomerDebt: Number(totalOutstandingDebt.toFixed(2)),
      },
    },
    trends: Array.from(dailyTrendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    productProfitability,
    bestSellingProducts,
    customerDebtReport: {
      totalOutstandingDebt: Number(totalOutstandingDebt.toFixed(2)),
      debtorsCount: customerDebtRows.filter((c) => c.currentBalance > 0).length,
      rows: customerDebtRows,
    },
    repaymentsReport: {
      totalRepayments: Number(totalDebtRepayments.toFixed(2)),
      count: payments.filter((p) => p.paymentType === 'DEBT_REPAYMENT').length,
      rows: payments
        .filter((p) => p.paymentType === 'DEBT_REPAYMENT')
        .map((p) => ({
          id: p.id,
          referenceNumber: p.referenceNumber,
          customerName: p.customer?.fullName ?? '-',
          accountNumber: p.customer?.accountNumber ?? '-',
          method: p.method,
          mpesaReference: p.mpesaReference,
          amount: toNumber(p.amount),
          paidAt: p.paidAt,
        })),
    },
    stockValuationReport: {
      totalUnits: totalUnitsInStock,
      totalCostValue: Number(totalStockCostValuation.toFixed(2)),
      totalRetailValue: Number(totalStockRetailValuation.toFixed(2)),
      potentialGrossProfit: Number((totalStockRetailValuation - totalStockCostValuation).toFixed(2)),
      byCategory: Array.from(valuationByCategory.values()),
    },
    stockMovements: movements.map((m) => ({
      id: m.id,
      productName: `${m.product.name} (${m.product.bottleSize})`,
      movementType: m.movementType,
      quantityChange: m.quantityChange,
      quantityBefore: m.quantityBefore,
      quantityAfter: m.quantityAfter,
      unitCostPrice: toNumber(m.unitCostPrice),
      totalCostValue: toNumber(m.totalCostValue),
      reason: m.reason,
      createdAt: m.createdAt,
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      referenceNumber: e.referenceNumber,
      category: e.category,
      title: e.title,
      amount: toNumber(e.amount),
      paymentMethod: e.paymentMethod,
      payee: e.payee,
      expenseDate: e.expenseDate,
    })),
  };
}

