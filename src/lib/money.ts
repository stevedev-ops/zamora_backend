import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = Decimal.Value | Prisma.Decimal;

export function toDecimal(value: MoneyInput): Decimal {
  if (value instanceof Prisma.Decimal) {
    return new Decimal(value.toString());
  }
  return new Decimal(value ?? 0);
}

export function round2(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function addMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return round2(toDecimal(a).plus(toDecimal(b)));
}

export function subMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return round2(toDecimal(a).minus(toDecimal(b)));
}

export function mulMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return round2(toDecimal(a).times(toDecimal(b)));
}

export function divMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) return new Decimal(0);
  return toDecimal(a).div(divisor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function toNumber(value: MoneyInput): number {
  return round2(value).toNumber();
}

export function toFixed2(value: MoneyInput): string {
  return round2(value).toFixed(2);
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return round2(values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0)));
}

export function calculateMarginPercent(profit: MoneyInput, sellingPrice: MoneyInput): number {
  const sp = toDecimal(sellingPrice);
  if (sp.lte(0)) return 0;
  return toDecimal(profit).div(sp).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

export function calculateMarkupPercent(profit: MoneyInput, costPrice: MoneyInput): number {
  const cp = toDecimal(costPrice);
  if (cp.lte(0)) return 0;
  return toDecimal(profit).div(cp).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

