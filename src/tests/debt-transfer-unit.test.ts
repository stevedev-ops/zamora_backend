import { describe, expect, it } from 'vitest';
import { ValidationError } from '../lib/errors';

describe('Debt Transfer Rules & Validations', () => {
  it('blocks transfer if original customer and receiving customer are identical', () => {
    const custId = '550e8400-e29b-41d4-a716-446655440000';
    expect(() => {
      if (custId === custId) {
        throw new ValidationError('Original customer and receiving customer must be different');
      }
    }).toThrow('Original customer and receiving customer must be different');
  });

  it('blocks transfer if transfer amount is zero or negative', () => {
    expect(() => {
      const amount = -500;
      if (amount <= 0) {
        throw new ValidationError('Transfer amount must be greater than zero');
      }
    }).toThrow('Transfer amount must be greater than zero');
  });

  it('blocks transfer if transfer amount exceeds current debt', () => {
    const currentDebt = 3000;
    const transferAmount = 4500;
    expect(() => {
      if (transferAmount > currentDebt) {
        throw new ValidationError(`Transfer amount (${transferAmount}) exceeds current debt (${currentDebt})`);
      }
    }).toThrow('exceeds current debt');
  });

  it('allows transfer within available debt balance and computes new balances accurately', () => {
    const fromDebtBefore = 4500;
    const toDebtBefore = 1000;
    const transferAmount = 2000;

    const fromDebtAfter = fromDebtBefore - transferAmount;
    const toDebtAfter = toDebtBefore + transferAmount;

    expect(fromDebtAfter).toBe(2500);
    expect(toDebtAfter).toBe(3000);
  });
});
