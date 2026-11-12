import { prisma } from '../lib/prisma';
import { toNumber } from '../lib/money';
import { resolveCalendarDayWindow } from '../lib/dateFilter';

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

export async function getDashboardData(
  chartPeriod: 'daily' | 'weekly' | 'monthly' = 'daily',
  options?: { date?: string; tzOffsetMinutes?: number }
) {
  const now = new Date();
  const todayWindow = resolveCalendarDayWindow({
    date: options?.date,
    tzOffsetMinutes: options?.tzOffsetMinutes,
  });
  const todayStart = todayWindow.start;
  const todayEnd = todayWindow.end;
  const monthStart = startOfMonth(now);

  const [
    salesTodayAgg,
    salesMonthAgg,
    purchasesMonthAgg,
    purchasesTotalAgg,
    debtAgg,
    paymentsTodayAgg,
    repaymentsTodayByMethod,
    paymentsMonthAgg,
    paymentsAllAgg,
    activeCustomersCount,
    debtorsCount,
    activeBatches,
    activeProducts,
    recentSales,
    recentPayments,
    recentDebtTransactions,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: { status: 'COMPLETED', soldAt: { gte: todayStart, lte: todayEnd } },
      _sum: {
        totalAmount: true,
        grossProfit: true,
        amountPaid: true,
        outstandingAmount: true,
        cashAmount: true,
        mpesaAmount: true,
      },
      _count: { id: true },
    }),
    prisma.sale.aggregate({
      where: { status: 'COMPLETED', soldAt: { gte: monthStart } },
      _sum: { totalAmount: true, grossProfit: true, amountPaid: true, outstandingAmount: true },
      _count: { id: true },
    }),
    prisma.supplierPurchase.aggregate({
      where: { purchaseDate: { gte: monthStart } },
      _sum: { totalCost: true },
    }),
    prisma.supplierPurchase.aggregate({
      _sum: { totalCost: true },
    }),
    prisma.customerAccount.aggregate({
      _sum: { currentBalance: true },
    }),
    prisma.payment.aggregate({
      where: { paidAt: { gte: todayStart, lte: todayEnd } },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: {
        paymentType: 'DEBT_REPAYMENT',
        paidAt: { gte: todayStart, lte: todayEnd },
      },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { paidAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
    }),
    prisma.customer.count({ where: { status: 'ACTIVE' } }),
    prisma.customerAccount.count({ where: { currentBalance: { gt: 0 } } }),
    prisma.inventoryBatch.findMany({
      where: { remainingQuantity: { gt: 0 } },
      select: { remainingQuantity: true, unitCostPrice: true },
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        brand: true,
        bottleSize: true,
        currentStock: true,
        minStockAlert: true,
        category: { select: { name: true } },
      },
      orderBy: { currentStock: 'asc' },
    }),
    prisma.sale.findMany({
      where: { status: 'COMPLETED' },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true } },
        _count: { select: { items: true } },
      },
      orderBy: { soldAt: 'desc' },
      take: 8,
    }),
    prisma.payment.findMany({
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true } },
      },
      orderBy: { paidAt: 'desc' },
      take: 8,
    }),
    prisma.debtTransaction.findMany({
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const totalStockValueAtCost = activeBatches.reduce(
    (sum, b) => sum + b.remainingQuantity * toNumber(b.unitCostPrice),
    0
  );

  const lowStockProducts = activeProducts
    .filter((p) => p.currentStock <= p.minStockAlert)
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      bottleSize: p.bottleSize,
      categoryName: p.category.name,
      currentStock: p.currentStock,
      minStockAlert: p.minStockAlert,
    }));

  const chartData = await buildSalesProfitChartSeries(chartPeriod);

  let debtRepaymentsCashToday = 0;
  let debtRepaymentsMpesaToday = 0;
  for (const row of repaymentsTodayByMethod) {
    const amt = toNumber(row._sum.amount ?? 0);
    if (row.method === 'CASH') debtRepaymentsCashToday += amt;
    else if (row.method === 'MPESA') debtRepaymentsMpesaToday += amt;
  }

  return {
    kpis: {
      closingDateLabel: todayWindow.dateLabel,
      totalSalesToday: toNumber(salesTodayAgg._sum.totalAmount ?? 0),
      salesCountToday: salesTodayAgg._count.id,
      cashSalesToday: toNumber(salesTodayAgg._sum.cashAmount ?? 0),
      mpesaSalesToday: toNumber(salesTodayAgg._sum.mpesaAmount ?? 0),
      debtSalesToday: toNumber(salesTodayAgg._sum.outstandingAmount ?? 0),
      debtRepaymentsCashToday: Number(debtRepaymentsCashToday.toFixed(2)),
      debtRepaymentsMpesaToday: Number(debtRepaymentsMpesaToday.toFixed(2)),
      debtRepaymentsTotalToday: Number((debtRepaymentsCashToday + debtRepaymentsMpesaToday).toFixed(2)),
      totalSalesThisMonth: toNumber(salesMonthAgg._sum.totalAmount ?? 0),
      salesCountThisMonth: salesMonthAgg._count.id,
      totalPurchasesThisMonth: toNumber(purchasesMonthAgg._sum.totalCost ?? 0),
      totalPurchasesAllTime: toNumber(purchasesTotalAgg._sum.totalCost ?? 0),
      grossProfitToday: toNumber(salesTodayAgg._sum.grossProfit ?? 0),
      grossProfitThisMonth: toNumber(salesMonthAgg._sum.grossProfit ?? 0),
      totalOutstandingDebt: toNumber(debtAgg._sum.currentBalance ?? 0),
      paymentsReceivedToday: toNumber(paymentsTodayAgg._sum.amount ?? 0),
      paymentsReceivedThisMonth: toNumber(paymentsMonthAgg._sum.amount ?? 0),
      totalPaymentsReceived: toNumber(paymentsAllAgg._sum.amount ?? 0),
      activeCustomersCount,
      customersWithDebtCount: debtorsCount,
      totalStockValueAtCost: Number(totalStockValueAtCost.toFixed(2)),
      lowStockCount: activeProducts.filter((p) => p.currentStock <= p.minStockAlert).length,
    },
    lowStockProducts,
    recentSales: recentSales.map((s) => ({
      id: s.id,
      receiptNumber: s.receiptNumber,
      customerName: s.customer?.fullName ?? 'Walk-in Customer',
      accountNumber: s.customer?.accountNumber ?? null,
      paymentMethod: s.paymentMethod,
      totalAmount: toNumber(s.totalAmount),
      amountPaid: toNumber(s.amountPaid),
      outstandingAmount: toNumber(s.outstandingAmount),
      grossProfit: toNumber(s.grossProfit),
      itemCount: s._count.items,
      soldAt: s.soldAt,
    })),
    recentPayments: recentPayments.map((p) => ({
      id: p.id,
      referenceNumber: p.referenceNumber,
      customerName: p.customer?.fullName ?? 'Walk-in Customer',
      accountNumber: p.customer?.accountNumber ?? null,
      paymentType: p.paymentType,
      method: p.method,
      amount: toNumber(p.amount),
      paidAt: p.paidAt,
    })),
    recentDebtTransactions: recentDebtTransactions.map((t) => ({
      id: t.id,
      referenceNumber: t.referenceNumber,
      customerId: t.customerId,
      customerName: t.customer.fullName,
      accountNumber: t.customer.accountNumber,
      transactionType: t.transactionType,
      direction: t.direction,
      amount: toNumber(t.amount),
      runningBalance: toNumber(t.runningBalance),
      description: t.description,
      createdAt: t.createdAt,
    })),
    chart: {
      period: chartPeriod,
      series: chartData,
    },
  };
}

export async function buildSalesProfitChartSeries(period: 'daily' | 'weekly' | 'monthly') {
  const now = new Date();
  let startDate: Date;

  if (period === 'daily') {
    startDate = startOfDay(new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000));
  } else if (period === 'weekly') {
    startDate = startOfDay(new Date(now.getTime() - 11 * 7 * 24 * 60 * 60 * 1000));
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }

  const sales = await prisma.sale.findMany({
    where: { status: 'COMPLETED', soldAt: { gte: startDate } },
    select: {
      soldAt: true,
      totalAmount: true,
      totalCost: true,
      grossProfit: true,
      amountPaid: true,
      outstandingAmount: true,
    },
    orderBy: { soldAt: 'asc' },
  });

  const buckets = new Map<
    string,
    {
      label: string;
      revenue: number;
      cogs: number;
      grossProfit: number;
      cashCollected: number;
      creditSales: number;
    }
  >();

  // Pre-seed bucket keys for continuous chart x-axis
  if (period === 'daily') {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' });
      buckets.set(key, {
        label,
        revenue: 0,
        cogs: 0,
        grossProfit: 0,
        cashCollected: 0,
        creditSales: 0,
      });
    }
  } else if (period === 'weekly') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      const weekStart = getWeekStart(d);
      const key = weekStart.toISOString().slice(0, 10);
      const label = `Wk ${weekStart.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' })}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          label,
          revenue: 0,
          cogs: 0,
          grossProfit: 0,
          cashCollected: 0,
          creditSales: 0,
        });
      }
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-KE', { month: 'short', year: '2-digit' });
      buckets.set(key, {
        label,
        revenue: 0,
        cogs: 0,
        grossProfit: 0,
        cashCollected: 0,
        creditSales: 0,
      });
    }
  }

  for (const s of sales) {
    let key: string;
    if (period === 'daily') {
      key = s.soldAt.toISOString().slice(0, 10);
    } else if (period === 'weekly') {
      key = getWeekStart(s.soldAt).toISOString().slice(0, 10);
    } else {
      key = `${s.soldAt.getFullYear()}-${String(s.soldAt.getMonth() + 1).padStart(2, '0')}`;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.revenue = Number((bucket.revenue + toNumber(s.totalAmount)).toFixed(2));
      bucket.cogs = Number((bucket.cogs + toNumber(s.totalCost)).toFixed(2));
      bucket.grossProfit = Number((bucket.grossProfit + toNumber(s.grossProfit)).toFixed(2));
      bucket.cashCollected = Number((bucket.cashCollected + toNumber(s.amountPaid)).toFixed(2));
      bucket.creditSales = Number(
        (bucket.creditSales + toNumber(s.outstandingAmount)).toFixed(2)
      );
    }
  }

  return Array.from(buckets.values());
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

