import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toggleSaleItemFlag } from '../services/customer.service';

const { mockFindUnique, mockUpdate, mockRecordAuditLog } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    saleItem: {
      findUnique: mockFindUnique,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        saleItem: {
          update: mockUpdate,
        },
      }),
  },
}));

vi.mock('../lib/audit', () => ({
  recordAuditLog: mockRecordAuditLog,
}));

describe('toggleSaleItemFlag (* Mark on Drinks)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseItem = {
    id: 'item-1',
    saleId: 'sale-1',
    productName: 'Kane Extra',
    sale: {
      id: 'sale-1',
      receiptNumber: 'RCP-00010',
      status: 'COMPLETED',
      customerId: 'cust-1',
      shares: [{ customerId: 'cust-2' }],
      debtTransactions: [],
    },
  };

  it('allows owner to mark a drink with * and note', async () => {
    mockFindUnique.mockResolvedValue(baseItem);
    mockUpdate.mockResolvedValue({
      id: 'item-1',
      saleId: 'sale-1',
      productName: 'Kane Extra',
      brand: 'Kane',
      bottleSize: '750ml',
      quantity: 1,
      isFlagged: true,
      flagNote: 'Wrong bottle price entered',
      flaggedByType: 'OWNER',
      flaggedAt: new Date('2026-11-12T10:00:00Z'),
    });

    const result = await toggleSaleItemFlag({
      saleItemId: 'item-1',
      isFlagged: true,
      flagNote: '  Wrong bottle price entered  ',
      actorType: 'OWNER',
      actorId: 'owner-1',
      scopeCustomerId: 'cust-1',
    });

    expect(result.isFlagged).toBe(true);
    expect(result.flagNote).toBe('Wrong bottle price entered');
    expect(result.flaggedByType).toBe('OWNER');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-1' },
        data: expect.objectContaining({
          isFlagged: true,
          flagNote: 'Wrong bottle price entered',
          flaggedByType: 'OWNER',
        }),
      })
    );
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'OWNER',
        action: 'SALE_ITEM_FLAGGED',
      })
    );
  });

  it('allows portal customer (including shared-bill customer) to mark and unmark a drink', async () => {
    mockFindUnique.mockResolvedValue(baseItem);
    mockUpdate.mockResolvedValueOnce({
      id: 'item-1',
      saleId: 'sale-1',
      productName: 'Kane Extra',
      brand: 'Kane',
      bottleSize: '750ml',
      quantity: 1,
      isFlagged: true,
      flagNote: null,
      flaggedByType: 'CUSTOMER',
      flaggedAt: new Date('2026-11-12T10:05:00Z'),
    });

    const flagged = await toggleSaleItemFlag({
      saleItemId: 'item-1',
      isFlagged: true,
      actorType: 'CUSTOMER',
      actorId: 'cust-2',
      scopeCustomerId: 'cust-2',
    });
    expect(flagged.isFlagged).toBe(true);
    expect(flagged.flaggedByType).toBe('CUSTOMER');

    mockUpdate.mockResolvedValueOnce({
      id: 'item-1',
      saleId: 'sale-1',
      productName: 'Kane Extra',
      brand: 'Kane',
      bottleSize: '750ml',
      quantity: 1,
      isFlagged: false,
      flagNote: null,
      flaggedByType: null,
      flaggedAt: null,
    });

    const unflagged = await toggleSaleItemFlag({
      saleItemId: 'item-1',
      isFlagged: false,
      actorType: 'CUSTOMER',
      actorId: 'cust-2',
      scopeCustomerId: 'cust-2',
    });
    expect(unflagged.isFlagged).toBe(false);
    expect(mockUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          isFlagged: false,
          flagNote: null,
          flaggedByType: null,
          flaggedAt: null,
        },
      })
    );
  });

  it('blocks a portal customer from marking another customer drink', async () => {
    mockFindUnique.mockResolvedValue(baseItem);

    await expect(
      toggleSaleItemFlag({
        saleItemId: 'item-1',
        isFlagged: true,
        actorType: 'CUSTOMER',
        actorId: 'cust-other',
        scopeCustomerId: 'cust-other',
      })
    ).rejects.toThrow('You can only mark drinks on your own account');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects marking items on voided sales', async () => {
    mockFindUnique.mockResolvedValue({
      ...baseItem,
      sale: { ...baseItem.sale, status: 'VOIDED' },
    });

    await expect(
      toggleSaleItemFlag({
        saleItemId: 'item-1',
        isFlagged: true,
        actorType: 'OWNER',
        actorId: 'owner-1',
      })
    ).rejects.toThrow('Cannot mark a drink on a voided purchase');
  });
});

