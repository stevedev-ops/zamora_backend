import { SalePaymentMethod } from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { addMoney, mulMoney, subMoney, toDecimal, toFixed2, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { buildDateRangeFilter } from '../lib/dateFilter';
import { allocateFifoBatchesTx, restoreBatchAllocationsTx } from './inventory.service';
import { appendLedgerEntryTx, lockCustomerAccountTx } from './debt.service';
import { notifyCustomerDebtEvent } from '../integrations/notifications';

export interface CreateSaleInput {
  customerId?: string | null;
  items: Array<{
    productId: string;
    quantity: number;
  }>;
  discountAmount?: number;
  discountReason?: string;
  paymentMethod: SalePaymentMethod;
  cashAmount?: number;
  mpesaAmount?: number;
  mpesaReference?: string;
  notes?: string;
  allowCreditLimitOverride?: boolean;
  idempotencyKey?: string;
}

export async function createSale(input: CreateSaleInput, userId: string, ipAddress?: string) {
  if (!input.items || input.items.length === 0) {
    throw new ValidationError('At least one product must be added to the sale');
  }

  if (input.idempotencyKey) {
    const existing = await prisma.sale.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        items: true,
        payments: true,
      },
    });
    if (existing) {
      return { ...formatSale(existing), deduplicated: true };
    }
  }

  // Merge duplicate productIds in cart to prevent split lock confusion
  const mergedMap = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new ValidationError('Item quantity must be a positive integer');
    }
    mergedMap.set(item.productId, (mergedMap.get(item.productId) ?? 0) + item.quantity);
  }
  const cartItems = Array.from(mergedMap.entries()).map(([productId, quantity]) => ({
    productId,
    quantity,
  }));

  const discountDec = toDecimal(input.discountAmount ?? 0);
  if (discountDec.lt(0)) {
    throw new ValidationError('Discount cannot be negative');
  }

  const created = await prisma.$transaction(async (tx) => {
    // Load products & compute authoritative selling prices from DB
    const products = await tx.product.findMany({
      where: { id: { in: cartItems.map((c) => c.productId) } },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotal = new Decimal(0);
    for (const line of cartItems) {
      const prod = productMap.get(line.productId);
      if (!prod) throw new NotFoundError(`Product ${line.productId} not found`);
      if (prod.status !== 'ACTIVE') {
        throw new ValidationError(`Product "${prod.name}" is inactive and cannot be sold`);
      }
      const lineTotal = mulMoney(prod.sellingPrice, line.quantity);
      subtotal = addMoney(subtotal, lineTotal);
    }

    if (discountDec.gt(subtotal)) {
      throw new ValidationError('Discount amount cannot exceed subtotal');
    }

    const totalAmount = subMoney(subtotal, discountDec);

    // Compute payment breakdown strictly on backend
    let cashDec = new Decimal(0);
    let mpesaDec = new Decimal(0);

    if (input.paymentMethod === 'CASH') {
      cashDec = totalAmount;
    } else if (input.paymentMethod === 'MPESA') {
      mpesaDec = totalAmount;
    } else if (input.paymentMethod === 'CREDIT') {
      cashDec = new Decimal(0);
      mpesaDec = new Decimal(0);
    } else if (input.paymentMethod === 'SPLIT') {
      cashDec = toDecimal(input.cashAmount ?? 0);
      mpesaDec = toDecimal(input.mpesaAmount ?? 0);
      if (cashDec.lt(0) || mpesaDec.lt(0)) {
        throw new ValidationError('Split payment amounts cannot be negative');
      }
      if (addMoney(cashDec, mpesaDec).gt(totalAmount)) {
        throw new ValidationError('Combined cash and M-Pesa amount exceeds total sale amount');
      }
    }

    const amountPaid = addMoney(cashDec, mpesaDec);
    const outstandingAmount = subMoney(totalAmount, amountPaid);

    // Enforce credit rules
    let customerRecord: {
      id: string;
      fullName: string;
      accountNumber: string;
      phone: string;
      status: string;
    } | null = null;

    if (input.customerId) {
      customerRecord = await tx.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, fullName: true, accountNumber: true, phone: true, status: true },
      });
      if (!customerRecord) throw new NotFoundError('Selected customer not found');
    }

    if (outstandingAmount.gt(0)) {
      if (!customerRecord) {
        throw new ValidationError('Every credit or partially unpaid sale must belong to a registered customer');
      }
      if (customerRecord.status !== 'ACTIVE') {
        throw new ValidationError(
          `Customer ${customerRecord.fullName} is ${customerRecord.status.toLowerCase()} and cannot make credit purchases`
        );
      }

      const lockedAccount = await lockCustomerAccountTx(tx, customerRecord.id);
      const currentBal = toDecimal(lockedAccount.current_balance);
      const creditLimit = toDecimal(lockedAccount.credit_limit);
      const projectedBal = addMoney(currentBal, outstandingAmount);

      if (projectedBal.gt(creditLimit) && !input.allowCreditLimitOverride) {
        throw new ValidationError(
          `Credit limit exceeded for ${customerRecord.fullName}. Current debt: KSh ${currentBal.toFixed(
            2
          )}, Limit: KSh ${creditLimit.toFixed(2)}, Projected: KSh ${projectedBal.toFixed(2)}`
        );
      }
    }

    const receiptNumber = await nextSequenceNumber(tx, 'sale_receipt', 'SALE', 5);

    // Allocate FIFO inventory batches & calculate exact historical COGS
    let totalCost = new Decimal(0);
    const preparedLineItems: Array<{
      productId: string;
      productName: string;
      brand: string;
      bottleSize: string;
      quantity: number;
      unitSellingPrice: Decimal;
      unitCostPrice: Decimal;
      lineTotal: Decimal;
      lineCost: Decimal;
      lineProfit: Decimal;
      allocations: Array<{
        inventoryBatchId: string;
        quantity: number;
        unitCostPrice: Decimal;
        totalCost: Decimal;
      }>;
    }> = [];

    for (const line of cartItems) {
      const prod = productMap.get(line.productId)!;
      const fifo = await allocateFifoBatchesTx(tx, {
        productId: prod.id,
        quantity: line.quantity,
        movementType: 'SALE_OUT',
        referenceType: 'SALE',
        referenceId: receiptNumber,
        reason: `POS Sale ${receiptNumber}`,
        userId,
      });

      const unitSell = toDecimal(prod.sellingPrice);
      const lineTotal = mulMoney(unitSell, line.quantity);
      const lineCost = fifo.totalCost;
      const lineProfit = subMoney(lineTotal, lineCost);
      totalCost = addMoney(totalCost, lineCost);

      preparedLineItems.push({
        productId: prod.id,
        productName: prod.name,
        brand: prod.brand,
        bottleSize: prod.bottleSize,
        quantity: line.quantity,
        unitSellingPrice: unitSell,
        unitCostPrice: fifo.weightedUnitCost,
        lineTotal,
        lineCost,
        lineProfit,
        allocations: fifo.allocations,
      });
    }

    const grossProfit = subMoney(totalAmount, totalCost);

    const sale = await tx.sale.create({
      data: {
        receiptNumber,
        customerId: customerRecord?.id ?? null,
        subtotal: subtotal.toFixed(2),
        discountAmount: discountDec.toFixed(2),
        discountReason: input.discountReason?.trim() || null,
        totalAmount: totalAmount.toFixed(2),
        cashAmount: cashDec.toFixed(2),
        mpesaAmount: mpesaDec.toFixed(2),
        mpesaReference: input.mpesaReference?.trim() || null,
        amountPaid: amountPaid.toFixed(2),
        outstandingAmount: outstandingAmount.toFixed(2),
        totalCost: totalCost.toFixed(2),
        grossProfit: grossProfit.toFixed(2),
        paymentMethod: input.paymentMethod,
        notes: input.notes?.trim() || null,
        idempotencyKey: input.idempotencyKey || null,
        createdByUserId: userId,
      },
    });

    for (const item of preparedLineItems) {
      const saleItem = await tx.saleItem.create({
        data: {
          saleId: sale.id,
          productId: item.productId,
          productName: item.productName,
          brand: item.brand,
          bottleSize: item.bottleSize,
          quantity: item.quantity,
          unitSellingPrice: item.unitSellingPrice.toFixed(2),
          unitCostPrice: item.unitCostPrice.toFixed(2),
          lineTotal: item.lineTotal.toFixed(2),
          lineCost: item.lineCost.toFixed(2),
          lineProfit: item.lineProfit.toFixed(2),
        },
      });

      for (const alloc of item.allocations) {
        await tx.saleItemBatchAllocation.create({
          data: {
            saleItemId: saleItem.id,
            inventoryBatchId: alloc.inventoryBatchId,
            quantity: alloc.quantity,
            unitCostPrice: alloc.unitCostPrice.toFixed(2),
            totalCost: alloc.totalCost.toFixed(2),
          },
        });
      }
    }

    // Record POS Payments (cash & mpesa)
    if (cashDec.gt(0)) {
      const cashPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
      await tx.payment.create({
        data: {
          referenceNumber: cashPayRef,
          customerId: customerRecord?.id ?? null,
          saleId: sale.id,
          paymentType: 'POS_SALE',
          amount: cashDec.toFixed(2),
          method: 'CASH',
          notes: `POS Cash payment for ${receiptNumber}`,
          receivedByUserId: userId,
        },
      });
    }

    if (mpesaDec.gt(0)) {
      const mpesaPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
      await tx.payment.create({
        data: {
          referenceNumber: mpesaPayRef,
          customerId: customerRecord?.id ?? null,
          saleId: sale.id,
          paymentType: 'POS_SALE',
          amount: mpesaDec.toFixed(2),
          method: 'MPESA',
          mpesaReference: input.mpesaReference?.trim() || null,
          notes: `POS M-Pesa payment for ${receiptNumber}`,
          receivedByUserId: userId,
        },
      });
    }

    let newCustomerBalance: Decimal | null = null;
    if (outstandingAmount.gt(0) && customerRecord) {
      const cleanNote = input.notes?.trim();
      const ledgerRes = await appendLedgerEntryTx(tx, {
        customerId: customerRecord.id,
        transactionType: 'CREDIT_SALE',
        direction: 'DEBIT',
        amount: outstandingAmount,
        description: `Credit purchase ${receiptNumber} (Total KSh ${totalAmount.toFixed(
          2
        )}, Paid KSh ${amountPaid.toFixed(2)})${cleanNote ? ` — ${cleanNote}` : ''}`,
        reason: cleanNote || undefined,
        saleId: sale.id,
        userId,
        accountStatsIncrement: {
          totalPurchases: totalAmount,
          totalPayments: amountPaid,
        },
      });
      newCustomerBalance = ledgerRes.newBalance;
    } else if (customerRecord) {
      // Fully paid sale linked to a customer -> update historical purchase/payment totals
      await tx.customerAccount.update({
        where: { customerId: customerRecord.id },
        data: {
          totalPurchases: { increment: totalAmount.toNumber() },
          totalPayments: { increment: amountPaid.toNumber() },
          lastTransactionAt: new Date(),
        },
      });
    }

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SALE_CREATED',
      entityType: 'Sale',
      entityId: sale.id,
      metadata: {
        receiptNumber,
        paymentMethod: input.paymentMethod,
        totalAmount: totalAmount.toNumber(),
        amountPaid: amountPaid.toNumber(),
        outstandingAmount: outstandingAmount.toNumber(),
        totalCost: totalCost.toNumber(),
        grossProfit: grossProfit.toNumber(),
        creditLimitOverridden: Boolean(input.allowCreditLimitOverride),
      },
      ipAddress,
    });

    const fullSale = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        items: true,
        payments: true,
      },
    });

    return { fullSale, customerRecord, newCustomerBalance };
  });

  if (created.newCustomerBalance !== null && created.customerRecord) {
    const noteSuffix = created.fullSale.notes?.trim()
      ? ` Note: ${created.fullSale.notes.trim()}.`
      : '';
    await notifyCustomerDebtEvent({
      customerId: created.customerRecord.id,
      customerName: created.customerRecord.fullName,
      customerPhone: created.customerRecord.phone,
      eventType: 'CREDIT_SALE',
      subject: `Credit Purchase ${created.fullSale.receiptNumber}`,
      messageBody: `a purchase (${created.fullSale.receiptNumber}) of KSh ${toFixed2(
        created.fullSale.totalAmount
      )} was recorded (Paid: KSh ${toFixed2(created.fullSale.amountPaid)}, Added to debt: KSh ${toFixed2(
        created.fullSale.outstandingAmount
      )}).${noteSuffix}`,
      newBalance: created.newCustomerBalance.toFixed(2),
    });
  }

  return formatSale(created.fullSale);
}

export interface UpdateSaleItemsInput {
  items: Array<{ productId: string; quantity: number }>;
  discountAmount?: number;
  discountReason?: string;
  notes?: string | null;
  reason?: string;
  allowCreditLimitOverride?: boolean;
}

/**
 * Allows the owner to add, remove, or edit drink quantities on an existing customer sale/tab
 * while preserving FIFO batch inventory accuracy and immutable debt ledger auditability.
 */
export async function updateCreditSaleItems(
  saleId: string,
  input: UpdateSaleItemsInput,
  userId: string,
  ipAddress?: string
) {
  const mergedNewMap = new Map<string, number>();
  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError('Item quantity must be a positive integer');
    }
    mergedNewMap.set(line.productId, (mergedNewMap.get(line.productId) ?? 0) + line.quantity);
  }

  const updatedResult = await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true, status: true } },
        items: { include: { batchAllocations: true } },
      },
    });
    if (!sale) throw new NotFoundError('Sale not found');
    if (sale.status === 'VOIDED') {
      throw new ValidationError('This bill has already been voided and cannot be edited');
    }
    if (!sale.customerId || !sale.customer) {
      throw new ValidationError('Only customer-linked sales/tabs can be edited here');
    }

    const lockedAccount = await lockCustomerAccountTx(tx, sale.customerId);
    const oldTotal = toDecimal(sale.totalAmount);
    const oldAmountPaid = toDecimal(sale.amountPaid);
    const oldOutstanding = toDecimal(sale.outstandingAmount);
    const cleanNote = input.notes !== undefined ? input.notes?.trim() || null : sale.notes;
    const cleanReason = input.reason?.trim() || cleanNote || undefined;

    const oldItemsMap = new Map(sale.items.map((i) => [i.productId, i]));

    // 1. Restore reduced or removed items back to FIFO batches
    for (const oldItem of sale.items) {
      const targetQty = mergedNewMap.get(oldItem.productId) ?? 0;
      if (targetQty < oldItem.quantity) {
        const returnQty = oldItem.quantity - targetQty;
        await restoreBatchAllocationsTx(tx, {
          saleItemId: oldItem.id,
          productId: oldItem.productId,
          returnQty,
          fallbackUnitCost: oldItem.unitCostPrice,
          referenceId: sale.receiptNumber,
          reason: cleanReason || `Tab edited on ${sale.receiptNumber}`,
          userId,
        });

        if (targetQty === 0) {
          await tx.saleItem.delete({ where: { id: oldItem.id } });
        } else {
          const remainingAllocs = await tx.saleItemBatchAllocation.findMany({
            where: { saleItemId: oldItem.id },
          });
          const newLineCost = remainingAllocs.reduce(
            (acc, a) => addMoney(acc, a.totalCost),
            new Decimal(0)
          );
          const unitSell = toDecimal(oldItem.unitSellingPrice);
          const newLineTotal = mulMoney(unitSell, targetQty);
          const newUnitCost = newLineCost.div(targetQty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          const newLineProfit = subMoney(newLineTotal, newLineCost);
          await tx.saleItem.update({
            where: { id: oldItem.id },
            data: {
              quantity: targetQty,
              unitCostPrice: newUnitCost.toFixed(2),
              lineTotal: newLineTotal.toFixed(2),
              lineCost: newLineCost.toFixed(2),
              lineProfit: newLineProfit.toFixed(2),
            },
          });
        }
      }
    }

    // 2. Allocate additional or brand-new drinks via FIFO
    const addedIds = Array.from(mergedNewMap.entries())
      .filter(([pid, qty]) => qty > (oldItemsMap.get(pid)?.quantity ?? 0))
      .map(([pid]) => pid);

    const addedProducts = addedIds.length
      ? await tx.product.findMany({ where: { id: { in: addedIds } } })
      : [];
    const addedProductMap = new Map(addedProducts.map((p) => [p.id, p]));

    for (const [productId, targetQty] of mergedNewMap.entries()) {
      const oldItem = oldItemsMap.get(productId);
      const oldQty = oldItem?.quantity ?? 0;
      if (targetQty <= oldQty) continue;

      const deltaQty = targetQty - oldQty;
      const prod = addedProductMap.get(productId);
      if (!prod) throw new NotFoundError(`Product ${productId} not found`);
      if (prod.status !== 'ACTIVE') {
        throw new ValidationError(`Product "${prod.name}" is inactive and cannot be added`);
      }

      const fifo = await allocateFifoBatchesTx(tx, {
        productId: prod.id,
        quantity: deltaQty,
        movementType: 'SALE_OUT',
        referenceType: 'SALE_EDIT',
        referenceId: sale.receiptNumber,
        reason: cleanReason || `Added drinks to ${sale.receiptNumber}`,
        userId,
      });

      if (oldItem) {
        for (const alloc of fifo.allocations) {
          await tx.saleItemBatchAllocation.create({
            data: {
              saleItemId: oldItem.id,
              inventoryBatchId: alloc.inventoryBatchId,
              quantity: alloc.quantity,
              unitCostPrice: alloc.unitCostPrice.toFixed(2),
              totalCost: alloc.totalCost.toFixed(2),
            },
          });
        }
        const unitSell = toDecimal(oldItem.unitSellingPrice);
        const newLineTotal = mulMoney(unitSell, targetQty);
        const newLineCost = addMoney(oldItem.lineCost, fifo.totalCost);
        const newUnitCost = newLineCost.div(targetQty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const newLineProfit = subMoney(newLineTotal, newLineCost);

        await tx.saleItem.update({
          where: { id: oldItem.id },
          data: {
            quantity: targetQty,
            unitCostPrice: newUnitCost.toFixed(2),
            lineTotal: newLineTotal.toFixed(2),
            lineCost: newLineCost.toFixed(2),
            lineProfit: newLineProfit.toFixed(2),
          },
        });
      } else {
        const unitSell = toDecimal(prod.sellingPrice);
        const lineTotal = mulMoney(unitSell, targetQty);
        const lineCost = fifo.totalCost;
        const lineProfit = subMoney(lineTotal, lineCost);

        const createdItem = await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: prod.id,
            productName: prod.name,
            brand: prod.brand,
            bottleSize: prod.bottleSize,
            quantity: targetQty,
            unitSellingPrice: unitSell.toFixed(2),
            unitCostPrice: fifo.weightedUnitCost.toFixed(2),
            lineTotal: lineTotal.toFixed(2),
            lineCost: lineCost.toFixed(2),
            lineProfit: lineProfit.toFixed(2),
          },
        });
        for (const alloc of fifo.allocations) {
          await tx.saleItemBatchAllocation.create({
            data: {
              saleItemId: createdItem.id,
              inventoryBatchId: alloc.inventoryBatchId,
              quantity: alloc.quantity,
              unitCostPrice: alloc.unitCostPrice.toFixed(2),
              totalCost: alloc.totalCost.toFixed(2),
            },
          });
        }
      }
    }

    // 3. Recompute sale totals & append compensating immutable ledger entry
    const finalItems = await tx.saleItem.findMany({ where: { saleId: sale.id } });
    let newSubtotal = new Decimal(0);
    let newTotalCost = new Decimal(0);
    for (const item of finalItems) {
      newSubtotal = addMoney(newSubtotal, item.lineTotal);
      newTotalCost = addMoney(newTotalCost, item.lineCost);
    }

    const newDiscount =
      mergedNewMap.size === 0
        ? new Decimal(0)
        : toDecimal(input.discountAmount !== undefined ? input.discountAmount : sale.discountAmount);
    if (newDiscount.lt(0)) throw new ValidationError('Discount cannot be negative');
    if (newDiscount.gt(newSubtotal)) {
      throw new ValidationError('Discount amount cannot exceed updated subtotal');
    }

    const newTotal = subMoney(newSubtotal, newDiscount);
    if (newTotal.lt(oldAmountPaid)) {
      throw new ValidationError(
        `Updated total (KSh ${newTotal.toFixed(2)}) cannot be less than already paid amount (KSh ${oldAmountPaid.toFixed(2)}). Use Debt Adjustment or Reversal instead.`
      );
    }

    const newOutstanding = subMoney(newTotal, oldAmountPaid);
    const newGrossProfit = subMoney(newTotal, newTotalCost);
    const debtDelta = subMoney(newOutstanding, oldOutstanding);
    const purchasesDelta = subMoney(newTotal, oldTotal);

    if (debtDelta.gt(0)) {
      const currentBal = toDecimal(lockedAccount.current_balance);
      const creditLimit = toDecimal(lockedAccount.credit_limit);
      const projectedBal = addMoney(currentBal, debtDelta);
      if (projectedBal.gt(creditLimit) && !input.allowCreditLimitOverride) {
        throw new ValidationError(
          `Credit limit exceeded for ${sale.customer.fullName}. Current debt: KSh ${currentBal.toFixed(
            2
          )}, Limit: KSh ${creditLimit.toFixed(2)}, Projected: KSh ${projectedBal.toFixed(2)}`
        );
      }
    }

    await tx.sale.update({
      where: { id: sale.id },
      data: {
        subtotal: newSubtotal.toFixed(2),
        discountAmount: newDiscount.toFixed(2),
        ...(input.discountReason !== undefined ? { discountReason: input.discountReason?.trim() || null } : {}),
        totalAmount: newTotal.toFixed(2),
        outstandingAmount: newOutstanding.toFixed(2),
        totalCost: newTotalCost.toFixed(2),
        grossProfit: newGrossProfit.toFixed(2),
        notes: cleanNote,
        status: mergedNewMap.size === 0 ? 'VOIDED' : 'COMPLETED',
      },
    });

    let newCustomerBalance = toDecimal(lockedAccount.current_balance);
    if (!debtDelta.isZero()) {
      const isIncrease = debtDelta.gt(0);
      const ledgerRes = await appendLedgerEntryTx(tx, {
        customerId: sale.customerId,
        transactionType: isIncrease ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
        direction: isIncrease ? 'DEBIT' : 'CREDIT',
        amount: debtDelta.abs(),
        description:
          mergedNewMap.size === 0
            ? `Voided/removed all drinks on ${sale.receiptNumber}${cleanNote ? ` — ${cleanNote}` : ''}`
            : `Updated drinks on ${sale.receiptNumber} (${
                isIncrease ? '+' : '-'
              }KSh ${debtDelta.abs().toFixed(2)})${cleanNote ? ` — ${cleanNote}` : ''}`,
        reason: cleanReason || 'Customer drink tab updated',
        saleId: sale.id,
        userId,
        accountStatsIncrement: !purchasesDelta.isZero()
          ? { totalPurchases: purchasesDelta.toNumber() }
          : undefined,
      });
      newCustomerBalance = ledgerRes.newBalance;
    }

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SALE_TAB_EDITED',
      entityType: 'Sale',
      entityId: sale.id,
      metadata: {
        receiptNumber: sale.receiptNumber,
        oldTotal: oldTotal.toNumber(),
        newTotal: newTotal.toNumber(),
        debtDelta: debtDelta.toNumber(),
        voided: mergedNewMap.size === 0,
      },
      ipAddress,
    });

    const refreshed = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        items: true,
        payments: true,
      },
    });

    return { sale: formatSale(refreshed), newCustomerBalance: newCustomerBalance.toNumber() };
  });

  return updatedResult;
}

export async function listSales(params?: {
  customerId?: string;
  paymentMethod?: SalePaymentMethod;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
}) {
  const search = params?.search?.trim();
  const soldAtFilter = buildDateRangeFilter(params?.startDate, params?.endDate);
  const sales = await prisma.sale.findMany({
    where: {
      ...(params?.customerId ? { customerId: params.customerId } : {}),
      ...(params?.paymentMethod ? { paymentMethod: params.paymentMethod } : {}),
      ...(soldAtFilter ? { soldAt: soldAtFilter } : {}),
      ...(search
        ? {
            OR: [
              { receiptNumber: { contains: search, mode: 'insensitive' } },
              { customer: { fullName: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      items: true,
      payments: true,
    },
    orderBy: { soldAt: 'desc' },
    take: params?.limit ?? 100,
  });

  return sales.map(formatSale);
}

export async function getSaleById(id: string) {
  const sale = await prisma.sale.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      items: true,
      payments: true,
    },
  });
  if (!sale) throw new NotFoundError('Sale not found');
  return formatSale(sale);
}

function formatSale(sale: {
  id: string;
  receiptNumber: string;
  customerId: string | null;
  subtotal: unknown;
  discountAmount: unknown;
  discountReason: string | null;
  totalAmount: unknown;
  cashAmount: unknown;
  mpesaAmount: unknown;
  mpesaReference: string | null;
  amountPaid: unknown;
  outstandingAmount: unknown;
  totalCost: unknown;
  grossProfit: unknown;
  paymentMethod: SalePaymentMethod;
  status: string;
  notes: string | null;
  soldAt: Date;
  createdAt: Date;
  customer?: { id: string; fullName: string; accountNumber: string; phone: string } | null;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    brand: string;
    bottleSize: string;
    quantity: number;
    unitSellingPrice: unknown;
    unitCostPrice: unknown;
    lineTotal: unknown;
    lineCost: unknown;
    lineProfit: unknown;
  }>;
  payments?: Array<{
    id: string;
    referenceNumber: string;
    amount: unknown;
    method: string;
    mpesaReference: string | null;
    paidAt: Date;
  }>;
}) {
  return {
    id: sale.id,
    receiptNumber: sale.receiptNumber,
    customerId: sale.customerId,
    customer: sale.customer ?? null,
    subtotal: toNumber(sale.subtotal as number),
    discountAmount: toNumber(sale.discountAmount as number),
    discountReason: sale.discountReason,
    totalAmount: toNumber(sale.totalAmount as number),
    cashAmount: toNumber(sale.cashAmount as number),
    mpesaAmount: toNumber(sale.mpesaAmount as number),
    mpesaReference: sale.mpesaReference,
    amountPaid: toNumber(sale.amountPaid as number),
    outstandingAmount: toNumber(sale.outstandingAmount as number),
    totalCost: toNumber(sale.totalCost as number),
    grossProfit: toNumber(sale.grossProfit as number),
    paymentMethod: sale.paymentMethod,
    status: sale.status,
    notes: sale.notes,
    soldAt: sale.soldAt,
    createdAt: sale.createdAt,
    items: sale.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      brand: i.brand,
      bottleSize: i.bottleSize,
      quantity: i.quantity,
      unitSellingPrice: toNumber(i.unitSellingPrice as number),
      unitCostPrice: toNumber(i.unitCostPrice as number),
      lineTotal: toNumber(i.lineTotal as number),
      lineCost: toNumber(i.lineCost as number),
      lineProfit: toNumber(i.lineProfit as number),
    })),
    payments: (sale.payments ?? []).map((p) => ({
      id: p.id,
      referenceNumber: p.referenceNumber,
      amount: toNumber(p.amount as number),
      method: p.method,
      mpesaReference: p.mpesaReference,
      paidAt: p.paidAt,
    })),
  };
}

