import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { normalizeAndValidateSplitShares } from '../services/pos.service';

describe('Multi-Person Bill Split & Per-Share Partial Debt Validation', () => {
  it('supports equal 600 / 600 debt split between two customers on a 1,200 bottle', () => {
    const res = normalizeAndValidateSplitShares(
      [
        {
          customerId: '11111111-1111-4111-8111-111111111111',
          debtAmount: 600,
          notes: 'Shared Kane 1200 with Mike',
        },
        {
          customerId: '22222222-2222-4222-8222-222222222222',
          debtAmount: 600,
          notes: 'Shared Kane 1200 with John',
        },
      ],
      new Decimal(1200)
    );

    expect(res.totalCash.toNumber()).toBe(0);
    expect(res.totalMpesa.toNumber()).toBe(0);
    expect(res.totalPaid.toNumber()).toBe(0);
    expect(res.totalDebt.toNumber()).toBe(1200);
    expect(res.debtByCustomer.get('11111111-1111-4111-8111-111111111111')?.toNumber()).toBe(600);
    expect(res.debtByCustomer.get('22222222-2222-4222-8222-222222222222')?.toNumber()).toBe(600);
  });

  it('supports per-person partial payment + logged debt combined across 2 people on 1,200 bottle', () => {
    // Person A share = 600 (pays 200 Cash now + 400 Debt)
    // Person B share = 600 (pays 100 Cash + 200 M-Pesa now + 300 Debt)
    const res = normalizeAndValidateSplitShares(
      [
        {
          customerId: '11111111-1111-4111-8111-111111111111',
          cashAmount: 200,
          mpesaAmount: 0,
          debtAmount: 400,
          notes: 'Paid 200 cash, 400 debt',
        },
        {
          customerId: '22222222-2222-4222-8222-222222222222',
          cashAmount: 100,
          mpesaAmount: 200,
          debtAmount: 300,
          notes: 'Paid 300, rest debt',
        },
      ],
      new Decimal(1200)
    );

    expect(res.totalCash.toNumber()).toBe(300);
    expect(res.totalMpesa.toNumber()).toBe(200);
    expect(res.totalPaid.toNumber()).toBe(500);
    expect(res.totalDebt.toNumber()).toBe(700);
    expect(res.shares[0].shareTotal.toNumber()).toBe(600);
    expect(res.shares[1].shareTotal.toNumber()).toBe(600);
  });

  it('supports uneven splits like 400 Cash (Walk-in) + 800 Debt (Customer)', () => {
    const res = normalizeAndValidateSplitShares(
      [
        {
          customerId: null,
          payerName: 'Mike',
          cashAmount: 400,
          debtAmount: 0,
        },
        {
          customerId: '22222222-2222-4222-8222-222222222222',
          debtAmount: 800,
          notes: 'Kane 1200 — 400 paid by Mike',
        },
      ],
      new Decimal(1200)
    );

    expect(res.totalPaid.toNumber()).toBe(400);
    expect(res.totalDebt.toNumber()).toBe(800);
    expect(res.shares[0].payerName).toBe('Mike');
  });

  it('rejects mismatched totals and unregistered debtors', () => {
    expect(() =>
      normalizeAndValidateSplitShares(
        [
          { cashAmount: 500, debtAmount: 0 },
          { customerId: '11111111-1111-4111-8111-111111111111', debtAmount: 600 },
        ],
        new Decimal(1200)
      )
    ).toThrow(/must equal sale total/);

    expect(() =>
      normalizeAndValidateSplitShares(
        [
          { cashAmount: 600, debtAmount: 0 },
          { customerId: null, payerName: 'Stranger', debtAmount: 600 },
        ],
        new Decimal(1200)
      )
    ).toThrow(/registered customer/);
  });
});

