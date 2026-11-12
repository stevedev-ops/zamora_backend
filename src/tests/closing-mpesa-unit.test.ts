import { describe, expect, it } from 'vitest';
import {
  formatMpesaPaymentSummary,
  getMpesaOptionLabel,
  normalizeMpesaType,
} from '../lib/mpesaDisplay';
import { resolveCalendarDayWindow } from '../lib/dateFilter';
import { summarizeDailyClosing } from '../services/report.service';

describe('M-Pesa Option Display & Formatting', () => {
  it('formats Pochi la Biashara, Paybill, and Till accurately', () => {
    expect(
      formatMpesaPaymentSummary({
        mpesaEnabled: true,
        mpesaType: 'POCHI_LA_BIASHARA',
        mpesaPaybillOrTill: '0712345678',
      })
    ).toBe('Pochi la Biashara: 0712345678');

    expect(
      formatMpesaPaymentSummary(
        {
          mpesaEnabled: true,
          mpesaType: 'PAYBILL',
          mpesaPaybillOrTill: '522533',
          mpesaAccountReference: 'ZAMORA',
        },
        'CUST-0001'
      )
    ).toBe('M-Pesa Paybill: 522533 | Account: ZAMORA');

    expect(
      formatMpesaPaymentSummary(
        {
          mpesaEnabled: true,
          mpesaType: 'PAYBILL',
          mpesaPaybillOrTill: '522533',
          mpesaAccountReference: null,
        },
        'CUST-0001'
      )
    ).toBe('M-Pesa Paybill: 522533 | Account: CUST-0001');

    expect(
      formatMpesaPaymentSummary({
        mpesaEnabled: true,
        mpesaType: 'TILL',
        mpesaPaybillOrTill: '123456',
      })
    ).toBe('M-Pesa Till No.: 123456');

    expect(
      formatMpesaPaymentSummary({
        mpesaEnabled: false,
        mpesaType: 'TILL',
        mpesaPaybillOrTill: '123456',
      })
    ).toBeNull();
  });

  it('normalizes legacy settings without mpesaType and exposes human labels', () => {
    expect(normalizeMpesaType({ mpesaAccountReference: 'ZAMORA' })).toBe('PAYBILL');
    expect(normalizeMpesaType({ mpesaAccountReference: null })).toBe('TILL');
    expect(getMpesaOptionLabel('POCHI_LA_BIASHARA')).toBe('Pochi la Biashara');
    expect(getMpesaOptionLabel('PAYBILL')).toBe('M-Pesa Paybill');
    expect(getMpesaOptionLabel('TILL')).toBe('M-Pesa Till Number (Buy Goods)');
  });
});

describe('Calendar Day Timezone Window & Daily Closing Summary', () => {
  it('resolves exact EAT (UTC+3, tzOffsetMinutes=-180) day boundaries in UTC', () => {
    const win = resolveCalendarDayWindow({
      date: '2026-11-12',
      tzOffsetMinutes: -180,
    });
    expect(win.dateLabel).toBe('2026-11-12');
    expect(win.start.toISOString()).toBe('2026-11-11T21:00:00.000Z');
    expect(win.end.toISOString()).toBe('2026-11-12T20:59:59.999Z');
  });

  it('breaks down Cash, M-Pesa, Debt, SPLIT sales, Repayments, and Expenses', () => {
    const now = new Date('2026-11-12T18:30:00.000Z');
    const summary = summarizeDailyClosing(
      [
        {
          id: 's1',
          receiptNumber: 'RCP-0001',
          paymentMethod: 'CASH',
          totalAmount: 1500,
          cashAmount: 1500,
          mpesaAmount: 0,
          amountPaid: 1500,
          outstandingAmount: 0,
          grossProfit: 400,
          discountAmount: 0,
          soldAt: now,
          customer: null,
          items: [{ quantity: 2, productName: 'Tusker', bottleSize: '500ml' }],
        },
        {
          id: 's2',
          receiptNumber: 'RCP-0002',
          paymentMethod: 'MPESA',
          totalAmount: 2500,
          cashAmount: 0,
          mpesaAmount: 2500,
          amountPaid: 2500,
          outstandingAmount: 0,
          grossProfit: 700,
          discountAmount: 100,
          mpesaReference: 'UBK123',
          soldAt: now,
          customer: null,
          items: [{ quantity: 1, productName: 'Jameson', bottleSize: '750ml' }],
        },
        {
          id: 's3',
          receiptNumber: 'RCP-0003',
          paymentMethod: 'CREDIT',
          totalAmount: 1200,
          cashAmount: 0,
          mpesaAmount: 0,
          amountPaid: 0,
          outstandingAmount: 1200,
          grossProfit: 350,
          discountAmount: 0,
          notes: 'Bought for Mike',
          soldAt: now,
          customer: { id: 'c1', fullName: 'John Kamau', accountNumber: 'CUST-0001' },
          items: [{ quantity: 1, productName: 'Gilbeys', bottleSize: '750ml' }],
        },
        {
          id: 's4',
          receiptNumber: 'RCP-0004',
          paymentMethod: 'SPLIT',
          totalAmount: 3000,
          cashAmount: 500,
          mpesaAmount: 1000,
          amountPaid: 1500,
          outstandingAmount: 1500,
          grossProfit: 800,
          discountAmount: 0,
          notes: 'Party bottles for Brian',
          soldAt: now,
          customer: { id: 'c1', fullName: 'John Kamau', accountNumber: 'CUST-0001' },
          items: [{ quantity: 3, productName: 'Smirnoff', bottleSize: '750ml' }],
        },
      ],
      [
        {
          id: 'p1',
          referenceNumber: 'PAY-0001',
          paymentType: 'DEBT_REPAYMENT',
          method: 'CASH',
          amount: 800,
          paidAt: now,
          customer: { id: 'c1', fullName: 'John Kamau', accountNumber: 'CUST-0001' },
        },
        {
          id: 'p2',
          referenceNumber: 'PAY-0002',
          paymentType: 'DEBT_REPAYMENT',
          method: 'MPESA',
          mpesaReference: 'MP999',
          amount: 600,
          paidAt: now,
          customer: { id: 'c1', fullName: 'John Kamau', accountNumber: 'CUST-0001' },
        },
        {
          // Sale-time payment must NOT double-count as a debt repayment
          id: 'p3',
          referenceNumber: 'PAY-0003',
          paymentType: 'SALE_PAYMENT',
          method: 'CASH',
          amount: 1500,
          paidAt: now,
          customer: null,
        },
      ],
      [
        {
          id: 'e1',
          referenceNumber: 'EXP-0001',
          category: 'UTILITIES',
          title: 'Ice & Bags',
          amount: 300,
          paymentMethod: 'CASH',
          expenseDate: now,
        },
      ]
    );

    expect(summary.totalSold).toBe(8200);
    expect(summary.salesCount).toBe(4);
    expect(summary.itemsSold).toBe(7);
    expect(summary.breakdown.cash.amount).toBe(2000); // 1500 + 500
    expect(summary.breakdown.mpesa.amount).toBe(3500); // 2500 + 1000
    expect(summary.breakdown.debt.amount).toBe(2700); // 1200 + 1500
    expect(summary.repayments.cash).toBe(800);
    expect(summary.repayments.mpesa).toBe(600);
    expect(summary.repayments.total).toBe(1400);
    expect(summary.reconciliation.totalCashCollected).toBe(2800); // 2000 + 800
    expect(summary.reconciliation.totalMpesaCollected).toBe(4100); // 3500 + 600
    expect(summary.reconciliation.netCashInDrawer).toBe(2500); // 2800 - 300
    expect(summary.sales[2].notes).toBe('Bought for Mike');
  });
});
