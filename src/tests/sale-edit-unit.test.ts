import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { resolveUpdatedSingleSalePayments } from '../services/pos.service';

describe('Walk-In & Single-Customer Receipt Edit Payment Resolution', () => {
  it('auto-adjusts walk-in pure Cash sale when items are added or removed', () => {
    const res = resolveUpdatedSingleSalePayments({
      newTotal: 600,
      oldCash: 1200,
      oldMpesa: 0,
      oldPaymentMethod: 'CASH',
      isVoided: false,
      hasCustomer: false,
    });

    expect(res.cashAmount.toNumber()).toBe(600);
    expect(res.mpesaAmount.toNumber()).toBe(0);
    expect(res.amountPaid.toNumber()).toBe(600);
    expect(res.outstandingAmount.toNumber()).toBe(0);
    expect(res.paymentMethod).toBe('CASH');
  });

  it('auto-adjusts walk-in pure M-Pesa sale when items change', () => {
    const res = resolveUpdatedSingleSalePayments({
      newTotal: 1800,
      oldCash: 0,
      oldMpesa: 1200,
      oldPaymentMethod: 'MPESA',
      isVoided: false,
      hasCustomer: false,
    });

    expect(res.cashAmount.toNumber()).toBe(0);
    expect(res.mpesaAmount.toNumber()).toBe(1800);
    expect(res.paymentMethod).toBe('MPESA');
  });

  it('rejects walk-in edit with explicit cash + mpesa not equal to newTotal', () => {
    expect(() =>
      resolveUpdatedSingleSalePayments({
        newTotal: 1000,
        oldCash: 1200,
        oldMpesa: 0,
        oldPaymentMethod: 'CASH',
        isVoided: false,
        hasCustomer: false,
        explicitCash: 500,
        explicitMpesa: 300,
      })
    ).toThrow(/Walk-in sale Cash \+ M-Pesa/);
  });

  it('allows explicit walk-in split adjustment when cash + mpesa equals newTotal', () => {
    const res = resolveUpdatedSingleSalePayments({
      newTotal: 1000,
      oldCash: 1200,
      oldMpesa: 0,
      oldPaymentMethod: 'CASH',
      isVoided: false,
      hasCustomer: false,
      explicitCash: 400,
      explicitMpesa: 600,
    });

    expect(res.cashAmount.toNumber()).toBe(400);
    expect(res.mpesaAmount.toNumber()).toBe(600);
    expect(res.paymentMethod).toBe('SPLIT');
  });

  it('keeps customer deposit intact when bill grows, and reduces paid proportionally when bill drops below paid', () => {
    const grown = resolveUpdatedSingleSalePayments({
      newTotal: 1500,
      oldCash: 200,
      oldMpesa: 0,
      oldPaymentMethod: 'SPLIT',
      isVoided: false,
      hasCustomer: true,
    });
    expect(grown.cashAmount.toNumber()).toBe(200);
    expect(grown.outstandingAmount.toNumber()).toBe(1300);
    expect(grown.paymentMethod).toBe('SPLIT');

    const shrunk = resolveUpdatedSingleSalePayments({
      newTotal: 150,
      oldCash: 200,
      oldMpesa: 100,
      oldPaymentMethod: 'SPLIT',
      isVoided: false,
      hasCustomer: true,
    });
    expect(shrunk.cashAmount.toNumber()).toBe(100);
    expect(shrunk.mpesaAmount.toNumber()).toBe(50);
    expect(shrunk.amountPaid.toNumber()).toBe(150);
    expect(shrunk.outstandingAmount.toNumber()).toBe(0);
  });

  it('zeros all amounts when voided', () => {
    const voided = resolveUpdatedSingleSalePayments({
      newTotal: new Decimal(0),
      oldCash: 500,
      oldMpesa: 700,
      oldPaymentMethod: 'SPLIT',
      isVoided: true,
      hasCustomer: false,
    });
    expect(voided.cashAmount.toNumber()).toBe(0);
    expect(voided.mpesaAmount.toNumber()).toBe(0);
    expect(voided.amountPaid.toNumber()).toBe(0);
    expect(voided.outstandingAmount.toNumber()).toBe(0);
  });
});

