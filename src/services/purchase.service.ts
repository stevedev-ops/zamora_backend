import { prisma } from '../lib/prisma';
import { addMoney, mulMoney, toDecimal, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { buildDateRangeFilter } from '../lib/dateFilter';
import { addStockBatchTx } from './inventory.service';
import Decimal from 'decimal.js';

export async function listSupplierPurchases(params?: {
  supplierId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}) {
  const search = params?.search?.trim();
  const purchaseDateFilter = buildDateRangeFilter(params?.startDate, params?.endDate);
  const purchases = await prisma.supplierPurchase.findMany({
    where: {
      ...(params?.supplierId ? { supplierId: params.supplierId } : {}),
      ...(purchaseDateFilter ? { purchaseDate: purchaseDateFilter } : {}),
      ...(search
        ? {
            OR: [
              { referenceNumber: { contains: search, mode: 'insensitive' } },
              { notes: { contains: search, mode: 'insensitive' } },
              { supplier: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      supplier: { select: { id: true, name: true, phone: true } },
      items: {
        include: {
          product: { select: { id: true, name: true, brand: true, bottleSize: true } },
        },
      },
    },
    orderBy: { purchaseDate: 'desc' },
  });

  return purchases.map((p) => ({
    ...p,
    totalCost: toNumber(p.totalCost),
    items: p.items.map((i) => ({
      ...i,
      unitCostPrice: toNumber(i.unitCostPrice),
      totalCost: toNumber(i.totalCost),
    })),
  }));
}

export async function getSupplierPurchaseById(id: string) {
  const purchase = await prisma.supplierPurchase.findUnique({
    where: { id },
    include: {
      supplier: true,
      items: {
        include: {
          product: { select: { id: true, name: true, brand: true, bottleSize: true } },
          inventoryBatch: { select: { id: true, batchNumber: true, remainingQuantity: true } },
        },
      },
    },
  });
  if (!purchase) throw new NotFoundError('Stock purchase not found');

  return {
    ...purchase,
    totalCost: toNumber(purchase.totalCost),
    items: purchase.items.map((i) => ({
      ...i,
      unitCostPrice: toNumber(i.unitCostPrice),
      totalCost: toNumber(i.totalCost),
    })),
  };
}

export async function createSupplierPurchase(
  input: {
    supplierId: string;
    purchaseDate?: string;
    referenceNumber?: string;
    notes?: string;
    idempotencyKey?: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitCostPrice: number;
    }>;
  },
  userId: string,
  ipAddress?: string
) {
  if (!input.items || input.items.length === 0) {
    throw new ValidationError('At least one product line item is required');
  }

  if (input.idempotencyKey) {
    const existing = await prisma.supplierPurchase.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { supplier: true, items: { include: { product: true } } },
    });
    if (existing) {
      return {
        ...existing,
        totalCost: toNumber(existing.totalCost),
        items: existing.items.map((i) => ({
          ...i,
          unitCostPrice: toNumber(i.unitCostPrice),
          totalCost: toNumber(i.totalCost),
        })),
      };
    }
  }

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundError('Supplier not found');

    const purchaseDate = input.purchaseDate ? new Date(input.purchaseDate) : new Date();
    const referenceNumber =
      input.referenceNumber?.trim() || (await nextSequenceNumber(tx, 'supplier_purchase', 'PO', 5));

    let totalCost = new Decimal(0);
    const preparedItems = input.items.map((item) => {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new ValidationError('Purchase quantity must be a positive integer');
      }
      const unitCost = toDecimal(item.unitCostPrice);
      if (unitCost.lt(0)) {
        throw new ValidationError('Unit cost price cannot be negative');
      }
      const lineTotal = mulMoney(unitCost, item.quantity);
      totalCost = addMoney(totalCost, lineTotal);
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitCostPrice: unitCost,
        totalCost: lineTotal,
      };
    });

    const purchase = await tx.supplierPurchase.create({
      data: {
        referenceNumber,
        supplierId: input.supplierId,
        purchaseDate,
        totalCost: totalCost.toFixed(2),
        notes: input.notes?.trim() || null,
        idempotencyKey: input.idempotencyKey || null,
        createdByUserId: userId,
      },
    });

    for (const line of preparedItems) {
      const purchaseItem = await tx.supplierPurchaseItem.create({
        data: {
          supplierPurchaseId: purchase.id,
          productId: line.productId,
          quantity: line.quantity,
          unitCostPrice: line.unitCostPrice.toFixed(2),
          totalCost: line.totalCost.toFixed(2),
        },
      });

      // Create FIFO batch & update product's latest purchasePrice (historical sales stay untouched!)
      await addStockBatchTx(tx, {
        productId: line.productId,
        quantity: line.quantity,
        unitCostPrice: line.unitCostPrice,
        movementType: 'PURCHASE_IN',
        purchaseDate,
        supplierId: input.supplierId,
        supplierPurchaseItemId: purchaseItem.id,
        referenceNumber,
        referenceType: 'SUPPLIER_PURCHASE',
        referenceId: purchase.id,
        reason: `Stock purchase from ${supplier.name} (${referenceNumber})`,
        updateProductPurchasePrice: true,
        userId,
      });
    }

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SUPPLIER_PURCHASE_CREATED',
      entityType: 'SupplierPurchase',
      entityId: purchase.id,
      metadata: {
        referenceNumber,
        supplierName: supplier.name,
        totalCost: totalCost.toNumber(),
        itemCount: preparedItems.length,
      },
      ipAddress,
    });

    const created = await tx.supplierPurchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: {
        supplier: true,
        items: {
          include: {
            product: { select: { id: true, name: true, brand: true, bottleSize: true } },
            inventoryBatch: { select: { id: true, batchNumber: true } },
          },
        },
      },
    });

    return {
      ...created,
      totalCost: toNumber(created.totalCost),
      items: created.items.map((i) => ({
        ...i,
        unitCostPrice: toNumber(i.unitCostPrice),
        totalCost: toNumber(i.totalCost),
      })),
    };
  });
}

