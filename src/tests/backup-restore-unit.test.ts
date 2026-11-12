import { describe, expect, it } from 'vitest';
import { ValidationError } from '../lib/errors';
import { validateAndSummarizeBackupPayload } from '../services/settings.service';

describe('Database Backup Snapshot Validation & Summary', () => {
  it('accepts a legacy v1.0 snapshot and defaults newer optional tables to empty arrays', () => {
    const legacySnapshot = {
      exportedAt: '2026-10-01T10:00:00.000Z',
      version: '1.0',
      data: {
        settings: [{ id: 's1', key: 'default' }],
        categories: [{ id: 'c1', name: 'Whisky' }],
        suppliers: [],
        products: [{ id: 'p1', name: 'Jameson' }, { id: 'p2', name: 'Tusker' }],
        supplierPurchases: [],
        supplierPurchaseItems: [],
        inventoryBatches: [],
        inventoryMovements: [],
        customers: [{ id: 'cust1', fullName: 'John Doe' }],
        customerAccounts: [{ id: 'acc1', customerId: 'cust1' }],
        creditLimits: [],
        sales: [{ id: 'sale1', receiptNumber: 'SAL-1' }],
        saleItems: [{ id: 'si1', saleId: 'sale1' }],
        payments: [],
        debtTransfers: [],
        debtTransactions: [],
        expenses: [{ id: 'exp1', title: 'Rent' }],
      },
    };

    const parsed = validateAndSummarizeBackupPayload(legacySnapshot);

    expect(parsed.version).toBe('1.0');
    expect(parsed.exportedAt).toBe('2026-10-01T10:00:00.000Z');
    expect(parsed.data.saleShares).toEqual([]);
    expect(parsed.data.saleItemBatchAllocations).toEqual([]);
    expect(parsed.data.sequenceCounters).toEqual([]);
    expect(parsed.counts.products).toBe(2);
    expect(parsed.counts.sales).toBe(1);
    expect(parsed.counts.expenses).toBe(1);
    expect(parsed.counts.totalRecords).toBe(9);
  });

  it('accepts an extended v1.1 snapshot including split shares and batch allocations', () => {
    const extendedSnapshot = {
      exportedAt: '2026-11-12T12:00:00.000Z',
      version: '1.1',
      data: {
        categories: [{ id: 'c1' }],
        products: [{ id: 'p1' }],
        customers: [{ id: 'cust1' }],
        sales: [{ id: 'sale1' }],
        saleShares: [{ id: 'sh1', saleId: 'sale1' }, { id: 'sh2', saleId: 'sale1' }],
        saleItemBatchAllocations: [{ id: 'alloc1', saleItemId: 'si1' }],
        sequenceCounters: [{ name: 'SAL', currentValue: 12 }],
      },
    };

    const parsed = validateAndSummarizeBackupPayload(extendedSnapshot);

    expect(parsed.version).toBe('1.1');
    expect(parsed.counts.saleShares).toBe(2);
    expect(parsed.counts.saleItemBatchAllocations).toBe(1);
    expect(parsed.counts.sequenceCounters).toBe(1);
    expect(parsed.counts.totalRecords).toBe(8);
  });

  it('rejects malformed payloads and invalid record entries with ValidationError', () => {
    expect(() => validateAndSummarizeBackupPayload(null)).toThrow(ValidationError);
    expect(() => validateAndSummarizeBackupPayload({ version: '1.0' })).toThrow(ValidationError);
    expect(() =>
      validateAndSummarizeBackupPayload({
        data: { categories: [], products: [], customers: [] },
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateAndSummarizeBackupPayload({
        data: { categories: [], products: [], customers: [], sales: [], payments: 'bad' },
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateAndSummarizeBackupPayload({
        data: { categories: [123], products: [], customers: [], sales: [] },
      })
    ).toThrow(ValidationError);
  });
});

