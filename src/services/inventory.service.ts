import { InventoryMovementType, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { addMoney, mulMoney, toDecimal, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';

export interface FifoAllocationResult {
  allocations: Array<{
    inventoryBatchId: string;
    quantity: number;
    unitCostPrice: Decimal;
    totalCost: Decimal;
  }>;
  totalCost: Decimal;
  weightedUnitCost: Decimal;
}

/**
 * Locks the product row and consumes stock strictly in FIFO order (oldest purchaseDate first).
 * Updates batch remainingQuantity, product currentStock, and writes inventory_movements.
 */
export async function allocateFifoBatchesTx(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    quantity: number;
    movementType: InventoryMovementType;
    referenceType: string;
    referenceId?: string;
    reason?: string;
    userId?: string;
  }
): Promise<FifoAllocationResult> {
  if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
    throw new ValidationError('Quantity must be a positive integer');
  }

  const lockedRows = await tx.$queryRaw<
    Array<{
      id: string;
      name: string;
      current_stock: number;
      min_stock_alert: number;
      purchase_price: Prisma.Decimal;
    }>
  >`
    SELECT id, name, current_stock, min_stock_alert, purchase_price
    FROM products
    WHERE id = ${params.productId}::uuid
    FOR UPDATE
  `;

  const product = lockedRows[0];
  if (!product) {
    throw new NotFoundError('Product not found');
  }

  if (product.current_stock < params.quantity) {
    throw new ValidationError(
      `Insufficient stock for ${product.name}. Available: ${product.current_stock}, requested: ${params.quantity}`
    );
  }

  const batches = await tx.inventoryBatch.findMany({
    where: {
      productId: params.productId,
      remainingQuantity: { gt: 0 },
    },
    orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
  });

  let remainingToAllocate = params.quantity;
  let runningStock = product.current_stock;
  let totalCost = new Decimal(0);
  const allocations: FifoAllocationResult['allocations'] = [];

  for (const batch of batches) {
    if (remainingToAllocate <= 0) break;
    const takeQty = Math.min(batch.remainingQuantity, remainingToAllocate);
    const unitCost = toDecimal(batch.unitCostPrice);
    const batchCost = mulMoney(unitCost, takeQty);

    await tx.inventoryBatch.update({
      where: { id: batch.id },
      data: { remainingQuantity: { decrement: takeQty } },
    });

    const before = runningStock;
    const after = before - takeQty;
    runningStock = after;

    await tx.inventoryMovement.create({
      data: {
        productId: params.productId,
        inventoryBatchId: batch.id,
        movementType: params.movementType,
        quantityChange: -takeQty,
        quantityBefore: before,
        quantityAfter: after,
        unitCostPrice: unitCost.toFixed(2),
        totalCostValue: batchCost.toFixed(2),
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        reason: params.reason,
        createdByUserId: params.userId,
      },
    });

    allocations.push({
      inventoryBatchId: batch.id,
      quantity: takeQty,
      unitCostPrice: unitCost,
      totalCost: batchCost,
    });
    totalCost = addMoney(totalCost, batchCost);
    remainingToAllocate -= takeQty;
  }

  // Defensive check in case historical data ever lacked batches
  if (remainingToAllocate > 0) {
    throw new ValidationError(
      `Inventory batch mismatch for ${product.name}: missing batch coverage for ${remainingToAllocate} unit(s)`
    );
  }

  const finalStock = product.current_stock - params.quantity;
  await tx.product.update({
    where: { id: params.productId },
    data: { currentStock: finalStock },
  });

  // Low-stock in-app alert if threshold crossed
  if (finalStock <= product.min_stock_alert) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const existingAlert = await tx.notification.findFirst({
      where: {
        eventType: 'LOW_STOCK',
        subject: `Low Stock: ${product.name}`,
        createdAt: { gte: startOfDay },
      },
    });
    if (!existingAlert) {
      await tx.notification.create({
        data: {
          channel: 'IN_APP',
          recipient: 'OWNER',
          eventType: 'LOW_STOCK',
          subject: `Low Stock: ${product.name}`,
          message: `${product.name} stock is low (${finalStock} remaining, alert level ${product.min_stock_alert}).`,
          status: 'SENT',
          provider: 'in_app',
          sentAt: new Date(),
        },
      });
    }
  }

  const weightedUnitCost = totalCost
    .div(params.quantity)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    allocations,
    totalCost,
    weightedUnitCost,
  };
}

/**
 * Restores units back to their original FIFO batches when reducing/removing items on a credit tab/sale.
 */
export async function restoreBatchAllocationsTx(
  tx: Prisma.TransactionClient,
  params: {
    saleItemId: string;
    productId: string;
    returnQty: number;
    fallbackUnitCost: Decimal.Value;
    referenceId: string;
    reason?: string;
    userId?: string;
  }
) {
  if (!Number.isInteger(params.returnQty) || params.returnQty <= 0) {
    throw new ValidationError('Return quantity must be a positive integer');
  }

  const lockedRows = await tx.$queryRaw<Array<{ id: string; current_stock: number }>>`
    SELECT id, current_stock
    FROM products
    WHERE id = ${params.productId}::uuid
    FOR UPDATE
  `;
  const product = lockedRows[0];
  if (!product) throw new NotFoundError('Product not found');

  const allocations = await tx.saleItemBatchAllocation.findMany({
    where: { saleItemId: params.saleItemId },
    orderBy: { id: 'desc' },
  });

  let remainingToReturn = params.returnQty;
  let runningStock = product.current_stock;
  let restoredCost = new Decimal(0);

  for (const alloc of [...allocations].reverse()) {
    if (remainingToReturn <= 0) break;
    const giveBack = Math.min(alloc.quantity, remainingToReturn);
    const unitCost = toDecimal(alloc.unitCostPrice);
    const giveBackCost = mulMoney(unitCost, giveBack);

    await tx.inventoryBatch.update({
      where: { id: alloc.inventoryBatchId },
      data: { remainingQuantity: { increment: giveBack } },
    });

    const before = runningStock;
    const after = before + giveBack;
    runningStock = after;

    await tx.inventoryMovement.create({
      data: {
        productId: params.productId,
        inventoryBatchId: alloc.inventoryBatchId,
        movementType: 'RETURN_IN',
        quantityChange: giveBack,
        quantityBefore: before,
        quantityAfter: after,
        unitCostPrice: unitCost.toFixed(2),
        totalCostValue: giveBackCost.toFixed(2),
        referenceType: 'SALE_EDIT',
        referenceId: params.referenceId,
        reason: params.reason ?? `Returned on edit of ${params.referenceId}`,
        createdByUserId: params.userId,
      },
    });

    if (giveBack === alloc.quantity) {
      await tx.saleItemBatchAllocation.delete({ where: { id: alloc.id } });
    } else {
      const remQty = alloc.quantity - giveBack;
      const remCost = mulMoney(unitCost, remQty);
      await tx.saleItemBatchAllocation.update({
        where: { id: alloc.id },
        data: { quantity: remQty, totalCost: remCost.toFixed(2) },
      });
    }

    restoredCost = addMoney(restoredCost, giveBackCost);
    remainingToReturn -= giveBack;
  }

  if (runningStock !== product.current_stock) {
    await tx.product.update({
      where: { id: params.productId },
      data: { currentStock: runningStock },
    });
  }

  if (remainingToReturn > 0) {
    await addStockBatchTx(tx, {
      productId: params.productId,
      quantity: remainingToReturn,
      unitCostPrice: params.fallbackUnitCost,
      movementType: 'RETURN_IN',
      referenceType: 'SALE_EDIT',
      referenceId: params.referenceId,
      reason: params.reason ?? `Returned on edit of ${params.referenceId}`,
      userId: params.userId,
    });
    restoredCost = addMoney(restoredCost, mulMoney(params.fallbackUnitCost, remainingToReturn));
  }

  return { restoredCost };
}

/**
 * Adds a stock batch (from purchase, opening stock, positive adjustment, or customer return)
 * and updates product stock + movement history atomically.
 */
export async function addStockBatchTx(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    quantity: number;
    unitCostPrice: Decimal.Value;
    movementType: InventoryMovementType;
    purchaseDate?: Date;
    supplierId?: string | null;
    supplierPurchaseItemId?: string;
    referenceNumber?: string;
    referenceType?: string;
    referenceId?: string;
    reason?: string;
    notes?: string;
    updateProductPurchasePrice?: boolean;
    userId?: string;
  }
) {
  if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
    throw new ValidationError('Quantity added must be a positive integer');
  }

  const unitCost = toDecimal(params.unitCostPrice);
  if (unitCost.lt(0)) {
    throw new ValidationError('Unit cost price cannot be negative');
  }

  const lockedRows = await tx.$queryRaw<Array<{ id: string; current_stock: number }>>`
    SELECT id, current_stock
    FROM products
    WHERE id = ${params.productId}::uuid
    FOR UPDATE
  `;
  const product = lockedRows[0];
  if (!product) throw new NotFoundError('Product not found');

  const batchNumber = await nextSequenceNumber(tx, 'inventory_batch', 'BATCH', 5);
  const totalCost = mulMoney(unitCost, params.quantity);
  const before = product.current_stock;
  const after = before + params.quantity;

  const batch = await tx.inventoryBatch.create({
    data: {
      batchNumber,
      productId: params.productId,
      supplierId: params.supplierId ?? null,
      supplierPurchaseItemId: params.supplierPurchaseItemId ?? null,
      purchaseDate: params.purchaseDate ?? new Date(),
      initialQuantity: params.quantity,
      remainingQuantity: params.quantity,
      unitCostPrice: unitCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      referenceNumber: params.referenceNumber,
      notes: params.notes,
    },
  });

  await tx.product.update({
    where: { id: params.productId },
    data: {
      currentStock: after,
      ...(params.updateProductPurchasePrice ? { purchasePrice: unitCost.toFixed(2) } : {}),
    },
  });

  await tx.inventoryMovement.create({
    data: {
      productId: params.productId,
      inventoryBatchId: batch.id,
      movementType: params.movementType,
      quantityChange: params.quantity,
      quantityBefore: before,
      quantityAfter: after,
      unitCostPrice: unitCost.toFixed(2),
      totalCostValue: totalCost.toFixed(2),
      referenceType: params.referenceType ?? params.movementType,
      referenceId: params.referenceId ?? batch.id,
      reason: params.reason ?? params.notes,
      createdByUserId: params.userId,
    },
  });

  return batch;
}

export async function getInventoryOverview(params?: { search?: string; lowStockOnly?: boolean }) {
  const search = params?.search?.trim();
  const products = await prisma.product.findMany({
    where: {
      status: 'ACTIVE',
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { brand: { contains: search, mode: 'insensitive' } },
              { barcode: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      category: true,
      supplier: true,
      inventoryBatches: {
        where: { remainingQuantity: { gt: 0 } },
        orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
      },
    },
    orderBy: { name: 'asc' },
  });

  const rows = products
    .map((p) => {
      const batchCostValue = p.inventoryBatches.reduce(
        (sum, b) => sum + b.remainingQuantity * toNumber(b.unitCostPrice),
        0
      );
      const potentialRetailValue = p.currentStock * toNumber(p.sellingPrice);
      const isLowStock = p.currentStock <= p.minStockAlert;
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        bottleSize: p.bottleSize,
        barcode: p.barcode,
        categoryName: p.category.name,
        supplierName: p.supplier?.name ?? null,
        currentStock: p.currentStock,
        minStockAlert: p.minStockAlert,
        isLowStock,
        latestPurchasePrice: toNumber(p.purchasePrice),
        sellingPrice: toNumber(p.sellingPrice),
        stockCostValue: Number(batchCostValue.toFixed(2)),
        potentialRetailValue: Number(potentialRetailValue.toFixed(2)),
        potentialProfit: Number((potentialRetailValue - batchCostValue).toFixed(2)),
        activeBatches: p.inventoryBatches.map((b) => ({
          id: b.id,
          batchNumber: b.batchNumber,
          purchaseDate: b.purchaseDate,
          initialQuantity: b.initialQuantity,
          remainingQuantity: b.remainingQuantity,
          unitCostPrice: toNumber(b.unitCostPrice),
          referenceNumber: b.referenceNumber,
        })),
      };
    })
    .filter((r) => (params?.lowStockOnly ? r.isLowStock : true));

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalUnits += r.currentStock;
      acc.totalCostValue += r.stockCostValue;
      acc.totalRetailValue += r.potentialRetailValue;
      if (r.isLowStock) acc.lowStockCount += 1;
      return acc;
    },
    { totalUnits: 0, totalCostValue: 0, totalRetailValue: 0, lowStockCount: 0 }
  );

  return {
    totals: {
      totalUnits: totals.totalUnits,
      totalCostValue: Number(totals.totalCostValue.toFixed(2)),
      totalRetailValue: Number(totals.totalRetailValue.toFixed(2)),
      potentialGrossProfit: Number((totals.totalRetailValue - totals.totalCostValue).toFixed(2)),
      lowStockCount: totals.lowStockCount,
    },
    items: rows,
  };
}

export async function listInventoryMovements(params?: {
  productId?: string;
  movementType?: InventoryMovementType;
  limit?: number;
}) {
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      ...(params?.productId ? { productId: params.productId } : {}),
      ...(params?.movementType ? { movementType: params.movementType } : {}),
    },
    include: {
      product: { select: { id: true, name: true, brand: true, bottleSize: true } },
      inventoryBatch: { select: { batchNumber: true } },
      createdByUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: params?.limit ?? 100,
  });

  return movements.map((m) => ({
    ...m,
    unitCostPrice: toNumber(m.unitCostPrice),
    totalCostValue: toNumber(m.totalCostValue),
  }));
}

export async function adjustInventory(
  input: {
    productId: string;
    operation: 'ADD' | 'ADJUST_IN' | 'ADJUST_OUT' | 'DAMAGED' | 'EXPIRED' | 'RETURN_IN' | 'RETURN_OUT';
    quantity: number;
    unitCostPrice?: number;
    reason: string;
    referenceNumber?: string;
  },
  userId: string,
  ipAddress?: string
) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw new NotFoundError('Product not found');

    const isAddition = ['ADD', 'ADJUST_IN', 'RETURN_IN'].includes(input.operation);
    if (isAddition) {
      const movementMap: Record<string, InventoryMovementType> = {
        ADD: 'PURCHASE_IN',
        ADJUST_IN: 'ADJUSTMENT_IN',
        RETURN_IN: 'RETURN_IN',
      };
      const costPrice = input.unitCostPrice ?? toNumber(product.purchasePrice);
      const batch = await addStockBatchTx(tx, {
        productId: input.productId,
        quantity: input.quantity,
        unitCostPrice: costPrice,
        movementType: movementMap[input.operation],
        referenceNumber: input.referenceNumber,
        referenceType: 'MANUAL_ADJUSTMENT',
        reason: input.reason,
        updateProductPurchasePrice: input.operation === 'ADD' && input.unitCostPrice !== undefined,
        userId,
      });

      await recordAuditLog(tx, {
        actorType: 'OWNER',
        actorId: userId,
        userId,
        action: `INVENTORY_${input.operation}`,
        entityType: 'Product',
        entityId: input.productId,
        metadata: { quantity: input.quantity, unitCostPrice: costPrice, reason: input.reason },
        ipAddress,
      });

      return { status: 'OK', batchId: batch.id };
    }

    const outMap: Record<string, InventoryMovementType> = {
      ADJUST_OUT: 'ADJUSTMENT_OUT',
      DAMAGED: 'DAMAGED',
      EXPIRED: 'EXPIRED',
      RETURN_OUT: 'RETURN_OUT',
    };

    const alloc = await allocateFifoBatchesTx(tx, {
      productId: input.productId,
      quantity: input.quantity,
      movementType: outMap[input.operation],
      referenceType: 'MANUAL_ADJUSTMENT',
      referenceId: input.referenceNumber,
      reason: input.reason,
      userId,
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: `INVENTORY_${input.operation}`,
      entityType: 'Product',
      entityId: input.productId,
      metadata: {
        quantity: input.quantity,
        totalCostLost: alloc.totalCost.toNumber(),
        reason: input.reason,
      },
      ipAddress,
    });

    return { status: 'OK', totalCost: alloc.totalCost.toNumber() };
  });
}

