import { Prisma, SalePaymentMethod } from '@prisma/client';
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

export interface SplitShareInput {
  customerId?: string | null;
  payerName?: string | null;
  cashAmount?: number;
  mpesaAmount?: number;
  debtAmount?: number;
  notes?: string | null;
}

export interface NormalizedSplitShare {
  customerId: string | null;
  payerName: string | null;
  cashAmount: Decimal;
  mpesaAmount: Decimal;
  paidAmount: Decimal;
  debtAmount: Decimal;
  shareTotal: Decimal;
  notes: string | null;
}

/**
 * Validates multi-person bill split rows and ensures their totals sum strictly to the net sale total.
 */
export function normalizeAndValidateSplitShares(
  rawShares: SplitShareInput[],
  totalAmount: Decimal
) {
  if (!Array.isArray(rawShares) || rawShares.length < 2) {
    throw new ValidationError('Multi-person split requires at least 2 payer shares');
  }
  if (rawShares.length > 10) {
    throw new ValidationError('Maximum 10 split shares are supported per sale');
  }

  let sumTotal = new Decimal(0);
  let totalCash = new Decimal(0);
  let totalMpesa = new Decimal(0);
  let totalDebt = new Decimal(0);
  const debtByCustomer = new Map<string, Decimal>();
  const shares: NormalizedSplitShare[] = [];

  for (let idx = 0; idx < rawShares.length; idx += 1) {
    const raw = rawShares[idx];
    const cash = addMoney(raw.cashAmount ?? 0, 0);
    const mpesa = addMoney(raw.mpesaAmount ?? 0, 0);
    const debt = addMoney(raw.debtAmount ?? 0, 0);

    if (cash.lt(0) || mpesa.lt(0) || debt.lt(0)) {
      throw new ValidationError(`Share #${idx + 1} cannot have negative amounts`);
    }

    const paid = addMoney(cash, mpesa);
    const shareTotal = addMoney(paid, debt);
    if (shareTotal.lte(0)) {
      throw new ValidationError(`Share #${idx + 1} total must be greater than zero`);
    }

    const customerId = raw.customerId?.trim() || null;
    if (debt.gt(0) && !customerId) {
      throw new ValidationError(
        `Share #${idx + 1} has debt (KSh ${debt.toFixed(2)}) and must select a registered customer`
      );
    }

    sumTotal = addMoney(sumTotal, shareTotal);
    totalCash = addMoney(totalCash, cash);
    totalMpesa = addMoney(totalMpesa, mpesa);
    totalDebt = addMoney(totalDebt, debt);

    if (customerId && debt.gt(0)) {
      debtByCustomer.set(customerId, addMoney(debtByCustomer.get(customerId) ?? 0, debt));
    }

    shares.push({
      customerId,
      payerName: raw.payerName?.trim() || null,
      cashAmount: cash,
      mpesaAmount: mpesa,
      paidAmount: paid,
      debtAmount: debt,
      shareTotal,
      notes: raw.notes?.trim() || null,
    });
  }

  if (!sumTotal.eq(totalAmount)) {
    throw new ValidationError(
      `Split shares total (KSh ${sumTotal.toFixed(2)}) must equal sale total (KSh ${totalAmount.toFixed(2)})`
    );
  }

  return {
    shares,
    totalCash,
    totalMpesa,
    totalPaid: addMoney(totalCash, totalMpesa),
    totalDebt,
    debtByCustomer,
  };
}

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
  splitShares?: SplitShareInput[];
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
        shares: {
          include: { customer: { select: { id: true, fullName: true, accountNumber: true } } },
          orderBy: { createdAt: 'asc' },
        },
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

    const hasMultiShares =
      input.paymentMethod === 'SPLIT' &&
      Array.isArray(input.splitShares) &&
      input.splitShares.length >= 2;

    if (input.paymentMethod !== 'SPLIT' && input.splitShares && input.splitShares.length > 0) {
      throw new ValidationError('Multi-person split shares require paymentMethod=SPLIT');
    }

    // Compute payment breakdown strictly on backend
    let cashDec = new Decimal(0);
    let mpesaDec = new Decimal(0);
    let validatedShares: ReturnType<typeof normalizeAndValidateSplitShares> | null = null;

    if (hasMultiShares) {
      validatedShares = normalizeAndValidateSplitShares(input.splitShares!, totalAmount);
      cashDec = validatedShares.totalCash;
      mpesaDec = validatedShares.totalMpesa;
    } else if (input.paymentMethod === 'CASH') {
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

    // Load and validate customers & credit limits
    type CustomerMini = {
      id: string;
      fullName: string;
      accountNumber: string;
      phone: string;
      status: string;
    };
    const customerMap = new Map<string, CustomerMini>();
    const allCustomerIds = new Set<string>();
    if (input.customerId) allCustomerIds.add(input.customerId);
    if (validatedShares) {
      for (const s of validatedShares.shares) {
        if (s.customerId) allCustomerIds.add(s.customerId);
      }
    }

    if (allCustomerIds.size > 0) {
      const custRows = await tx.customer.findMany({
        where: { id: { in: Array.from(allCustomerIds) } },
        select: { id: true, fullName: true, accountNumber: true, phone: true, status: true },
      });
      for (const c of custRows) customerMap.set(c.id, c);
      for (const cid of allCustomerIds) {
        if (!customerMap.has(cid)) {
          throw new NotFoundError('Selected customer not found');
        }
      }
    }

    let customerRecord: CustomerMini | null = input.customerId
      ? customerMap.get(input.customerId) ?? null
      : null;

    if (validatedShares) {
      const debtorIds = Array.from(validatedShares.debtByCustomer.keys()).sort();
      for (const debtorId of debtorIds) {
        const cust = customerMap.get(debtorId)!;
        const addedDebt = validatedShares.debtByCustomer.get(debtorId)!;
        if (cust.status !== 'ACTIVE') {
          throw new ValidationError(
            `Customer ${cust.fullName} is ${cust.status.toLowerCase()} and cannot make credit purchases`
          );
        }
        const lockedAccount = await lockCustomerAccountTx(tx, cust.id);
        const currentBal = toDecimal(lockedAccount.current_balance);
        const creditLimit = toDecimal(lockedAccount.credit_limit);
        const projectedBal = addMoney(currentBal, addedDebt);
        if (projectedBal.gt(creditLimit) && !input.allowCreditLimitOverride) {
          throw new ValidationError(
            `Credit limit exceeded for ${cust.fullName}. Current debt: KSh ${currentBal.toFixed(
              2
            )}, Limit: KSh ${creditLimit.toFixed(2)}, Projected: KSh ${projectedBal.toFixed(2)}`
          );
        }
      }
      if (!customerRecord) {
        if (debtorIds.length === 1) {
          customerRecord = customerMap.get(debtorIds[0]) ?? null;
        } else {
          const firstLinked = validatedShares.shares.find((s) => s.customerId)?.customerId;
          if (firstLinked) customerRecord = customerMap.get(firstLinked) ?? null;
        }
      }
    } else if (outstandingAmount.gt(0)) {
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

    const debtNotifications: Array<{
      customer: CustomerMini;
      newBalance: Decimal;
      totalAmount: Decimal;
      amountPaid: Decimal;
      debtAdded: Decimal;
      note: string | null;
    }> = [];

    if (validatedShares) {
      const resolvedNames = validatedShares.shares.map((s, idx) => {
        const cust = s.customerId ? customerMap.get(s.customerId) : undefined;
        return cust?.fullName || s.payerName || `Person ${idx + 1}`;
      });

      for (let i = 0; i < validatedShares.shares.length; i += 1) {
        const share = validatedShares.shares[i];
        const shareCust = share.customerId ? customerMap.get(share.customerId)! : null;
        const shareLabel = resolvedNames[i];

        await tx.saleShare.create({
          data: {
            saleId: sale.id,
            customerId: share.customerId,
            payerName: shareLabel,
            shareTotal: share.shareTotal.toFixed(2),
            cashAmount: share.cashAmount.toFixed(2),
            mpesaAmount: share.mpesaAmount.toFixed(2),
            paidAmount: share.paidAmount.toFixed(2),
            debtAmount: share.debtAmount.toFixed(2),
            notes: share.notes,
          },
        });

        if (share.cashAmount.gt(0)) {
          const cashPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
          await tx.payment.create({
            data: {
              referenceNumber: cashPayRef,
              customerId: share.customerId,
              saleId: sale.id,
              paymentType: 'POS_SALE',
              amount: share.cashAmount.toFixed(2),
              method: 'CASH',
              notes: `POS Cash share (${shareLabel}) for ${receiptNumber}`,
              receivedByUserId: userId,
            },
          });
        }

        if (share.mpesaAmount.gt(0)) {
          const mpesaPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
          await tx.payment.create({
            data: {
              referenceNumber: mpesaPayRef,
              customerId: share.customerId,
              saleId: sale.id,
              paymentType: 'POS_SALE',
              amount: share.mpesaAmount.toFixed(2),
              method: 'MPESA',
              mpesaReference: input.mpesaReference?.trim() || null,
              notes: `POS M-Pesa share (${shareLabel}) for ${receiptNumber}`,
              receivedByUserId: userId,
            },
          });
        }

        if (share.debtAmount.gt(0) && shareCust) {
          const othersText = validatedShares.shares
            .map((o, oIdx) => {
              if (oIdx === i) return null;
              const oName = resolvedNames[oIdx];
              const parts: string[] = [];
              if (o.paidAmount.gt(0)) parts.push(`paid KSh ${o.paidAmount.toFixed(2)}`);
              if (o.debtAmount.gt(0)) parts.push(`debt KSh ${o.debtAmount.toFixed(2)}`);
              return `${oName} (${parts.join(', ')})`;
            })
            .filter(Boolean)
            .join('; ');

          const explicitNote = [share.notes, input.notes?.trim()].filter(Boolean).join(' — ');
          const effectiveReason =
            explicitNote ||
            (othersText
              ? `Split bill (Total KSh ${totalAmount.toFixed(2)}): ${othersText}`
              : undefined);

          const ledgerRes = await appendLedgerEntryTx(tx, {
            customerId: shareCust.id,
            transactionType: 'CREDIT_SALE',
            direction: 'DEBIT',
            amount: share.debtAmount,
            description: `Shared purchase ${receiptNumber} (Total KSh ${totalAmount.toFixed(
              2
            )}, Your share KSh ${share.shareTotal.toFixed(2)}, Paid KSh ${share.paidAmount.toFixed(
              2
            )})${effectiveReason ? ` — ${effectiveReason}` : ''}`,
            reason: effectiveReason || undefined,
            saleId: sale.id,
            userId,
            accountStatsIncrement: {
              totalPurchases: share.shareTotal,
              totalPayments: share.paidAmount,
            },
          });

          debtNotifications.push({
            customer: shareCust,
            newBalance: ledgerRes.newBalance,
            totalAmount: share.shareTotal,
            amountPaid: share.paidAmount,
            debtAdded: share.debtAmount,
            note: effectiveReason || null,
          });
        } else if (shareCust) {
          await tx.customerAccount.update({
            where: { customerId: shareCust.id },
            data: {
              totalPurchases: { increment: share.shareTotal.toNumber() },
              totalPayments: { increment: share.paidAmount.toNumber() },
              lastTransactionAt: new Date(),
            },
          });
        }
      }
    } else {
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
        debtNotifications.push({
          customer: customerRecord,
          newBalance: ledgerRes.newBalance,
          totalAmount,
          amountPaid,
          debtAdded: outstandingAmount,
          note: cleanNote || null,
        });
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
        splitSharesCount: validatedShares ? validatedShares.shares.length : 0,
      },
      ipAddress,
    });

    const fullSale = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        items: true,
        payments: true,
        shares: {
          include: { customer: { select: { id: true, fullName: true, accountNumber: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return { fullSale, debtNotifications };
  });

  for (const notif of created.debtNotifications) {
    const noteSuffix = notif.note ? ` Note: ${notif.note}.` : '';
    await notifyCustomerDebtEvent({
      customerId: notif.customer.id,
      customerName: notif.customer.fullName,
      customerPhone: notif.customer.phone,
      eventType: 'CREDIT_SALE',
      subject: `Credit Purchase ${created.fullSale.receiptNumber}`,
      messageBody: `a purchase (${created.fullSale.receiptNumber}) share of KSh ${toFixed2(
        notif.totalAmount
      )} was recorded (Paid: KSh ${toFixed2(notif.amountPaid)}, Added to debt: KSh ${toFixed2(
        notif.debtAdded
      )}).${noteSuffix}`,
      newBalance: notif.newBalance.toFixed(2),
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
  cashAmount?: number;
  mpesaAmount?: number;
  mpesaReference?: string | null;
  splitShares?: SplitShareInput[];
}

function deriveSingleSalePaymentMethod(params: {
  total: Decimal;
  cash: Decimal;
  mpesa: Decimal;
  outstanding: Decimal;
}): SalePaymentMethod {
  if (params.total.gt(0)) {
    if (params.outstanding.eq(params.total)) return 'CREDIT';
    if (params.cash.eq(params.total)) return 'CASH';
    if (params.mpesa.eq(params.total)) return 'MPESA';
  }
  return 'SPLIT';
}

/**
 * Computes updated cash/M-Pesa/debt amounts when items are edited on a single-payer or walk-in sale.
 */
export function resolveUpdatedSingleSalePayments(params: {
  newTotal: Decimal.Value;
  oldCash: Decimal.Value;
  oldMpesa: Decimal.Value;
  oldPaymentMethod: SalePaymentMethod;
  isVoided: boolean;
  hasCustomer: boolean;
  explicitCash?: number;
  explicitMpesa?: number;
}) {
  const newTotal = toDecimal(params.newTotal);
  if (params.isVoided || newTotal.isZero()) {
    return {
      cashAmount: new Decimal(0),
      mpesaAmount: new Decimal(0),
      amountPaid: new Decimal(0),
      outstandingAmount: new Decimal(0),
      paymentMethod: params.oldPaymentMethod,
    };
  }

  let cash = new Decimal(0);
  let mpesa = new Decimal(0);

  if (params.explicitCash !== undefined || params.explicitMpesa !== undefined) {
    cash = addMoney(params.explicitCash ?? 0, 0);
    mpesa = addMoney(params.explicitMpesa ?? 0, 0);
    if (cash.lt(0) || mpesa.lt(0)) {
      throw new ValidationError('Cash and M-Pesa amounts cannot be negative');
    }
    const explicitPaid = addMoney(cash, mpesa);
    if (explicitPaid.gt(newTotal)) {
      throw new ValidationError('Combined cash and M-Pesa amount exceeds updated sale total');
    }
    if (!params.hasCustomer && !explicitPaid.eq(newTotal)) {
      throw new ValidationError(
        `Walk-in sale Cash + M-Pesa (KSh ${explicitPaid.toFixed(2)}) must equal updated total (KSh ${newTotal.toFixed(2)})`
      );
    }
  } else {
    const oldCash = toDecimal(params.oldCash);
    const oldMpesa = toDecimal(params.oldMpesa);
    const oldPaid = addMoney(oldCash, oldMpesa);

    if (!params.hasCustomer) {
      if (params.oldPaymentMethod === 'MPESA' || (oldMpesa.gt(0) && oldCash.isZero())) {
        mpesa = newTotal;
      } else if (
        params.oldPaymentMethod === 'CASH' ||
        (oldCash.gt(0) && oldMpesa.isZero()) ||
        oldPaid.isZero()
      ) {
        cash = newTotal;
      } else {
        cash = newTotal.mul(oldCash).div(oldPaid).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        mpesa = subMoney(newTotal, cash);
      }
    } else if (newTotal.gte(oldPaid)) {
      cash = oldCash;
      mpesa = oldMpesa;
    } else if (oldPaid.gt(0)) {
      cash = newTotal.mul(oldCash).div(oldPaid).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      mpesa = subMoney(newTotal, cash);
    }
  }

  const amountPaid = addMoney(cash, mpesa);
  const outstandingAmount = subMoney(newTotal, amountPaid);
  const paymentMethod = deriveSingleSalePaymentMethod({
    total: newTotal,
    cash,
    mpesa,
    outstanding: outstandingAmount,
  });

  return { cashAmount: cash, mpesaAmount: mpesa, amountPaid, outstandingAmount, paymentMethod };
}

async function replaceSalePosPaymentsTx(
  tx: Prisma.TransactionClient,
  params: {
    saleId: string;
    receiptNumber: string;
    userId: string;
    mpesaReference: string | null;
    entries: Array<{
      customerId: string | null;
      cashAmount: Decimal;
      mpesaAmount: Decimal;
      label?: string | null;
    }>;
  }
) {
  await tx.payment.deleteMany({
    where: { saleId: params.saleId, paymentType: 'POS_SALE' },
  });

  for (const entry of params.entries) {
    if (entry.cashAmount.gt(0)) {
      const cashPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
      await tx.payment.create({
        data: {
          referenceNumber: cashPayRef,
          customerId: entry.customerId,
          saleId: params.saleId,
          paymentType: 'POS_SALE',
          amount: entry.cashAmount.toFixed(2),
          method: 'CASH',
          notes: entry.label
            ? `POS Cash share (${entry.label}) for ${params.receiptNumber}`
            : `POS Cash payment for ${params.receiptNumber}`,
          receivedByUserId: params.userId,
        },
      });
    }
    if (entry.mpesaAmount.gt(0)) {
      const mpesaPayRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
      await tx.payment.create({
        data: {
          referenceNumber: mpesaPayRef,
          customerId: entry.customerId,
          saleId: params.saleId,
          paymentType: 'POS_SALE',
          amount: entry.mpesaAmount.toFixed(2),
          method: 'MPESA',
          mpesaReference: params.mpesaReference,
          notes: entry.label
            ? `POS M-Pesa share (${entry.label}) for ${params.receiptNumber}`
            : `POS M-Pesa payment for ${params.receiptNumber}`,
          receivedByUserId: params.userId,
        },
      });
    }
  }
}

async function applyCustomerEditDeltaTx(
  tx: Prisma.TransactionClient,
  params: {
    customerId: string;
    saleId: string;
    receiptNumber: string;
    debtDelta: Decimal;
    purchasesDelta: Decimal;
    paidDelta: Decimal;
    isVoided: boolean;
    cleanNote: string | null;
    cleanReason?: string;
    userId: string;
  }
) {
  if (!params.debtDelta.isZero()) {
    const isIncrease = params.debtDelta.gt(0);
    const ledgerRes = await appendLedgerEntryTx(tx, {
      customerId: params.customerId,
      transactionType: isIncrease ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
      direction: isIncrease ? 'DEBIT' : 'CREDIT',
      amount: params.debtDelta.abs(),
      description: params.isVoided
        ? `Voided/removed all drinks on ${params.receiptNumber}${
            params.cleanNote ? ` — ${params.cleanNote}` : ''
          }`
        : `Updated drinks on ${params.receiptNumber} (${
            isIncrease ? '+' : '-'
          }KSh ${params.debtDelta.abs().toFixed(2)})${
            params.cleanNote ? ` — ${params.cleanNote}` : ''
          }`,
      reason: params.cleanReason || 'Sale drink items updated',
      saleId: params.saleId,
      userId: params.userId,
      accountStatsIncrement: {
        ...(!params.purchasesDelta.isZero()
          ? { totalPurchases: params.purchasesDelta.toNumber() }
          : {}),
        ...(!params.paidDelta.isZero() ? { totalPayments: params.paidDelta.toNumber() } : {}),
      },
    });
    return ledgerRes.newBalance;
  }

  if (!params.purchasesDelta.isZero() || !params.paidDelta.isZero()) {
    const updated = await tx.customerAccount.update({
      where: { customerId: params.customerId },
      data: {
        ...(!params.purchasesDelta.isZero()
          ? { totalPurchases: { increment: params.purchasesDelta.toNumber() } }
          : {}),
        ...(!params.paidDelta.isZero()
          ? { totalPayments: { increment: params.paidDelta.toNumber() } }
          : {}),
        lastTransactionAt: new Date(),
      },
    });
    return toDecimal(updated.currentBalance);
  }

  const acc = await lockCustomerAccountTx(tx, params.customerId);
  return toDecimal(acc.current_balance);
}

/**
 * Allows the owner to add, remove, or edit drink quantities on any completed sale
 * (Walk-in Cash/M-Pesa/Split, Single-Customer Credit/Paid, or Multi-Person Split receipts)
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
        shares: {
          include: {
            customer: { select: { id: true, fullName: true, accountNumber: true, phone: true, status: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!sale) throw new NotFoundError('Sale not found');
    if (sale.status === 'VOIDED') {
      throw new ValidationError('This bill has already been voided and cannot be edited');
    }

    const oldTotal = toDecimal(sale.totalAmount);
    const oldCash = toDecimal(sale.cashAmount);
    const oldMpesa = toDecimal(sale.mpesaAmount);
    const oldAmountPaid = toDecimal(sale.amountPaid);
    const oldOutstanding = toDecimal(sale.outstandingAmount);
    const cleanNote = input.notes !== undefined ? input.notes?.trim() || null : sale.notes;
    const cleanMpesaRef =
      input.mpesaReference !== undefined
        ? input.mpesaReference?.trim() || null
        : sale.mpesaReference;
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
          reason: cleanReason || `Receipt edited on ${sale.receiptNumber}`,
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

    // 3. Recompute sale totals
    const finalItems = await tx.saleItem.findMany({ where: { saleId: sale.id } });
    let newSubtotal = new Decimal(0);
    let newTotalCost = new Decimal(0);
    for (const item of finalItems) {
      newSubtotal = addMoney(newSubtotal, item.lineTotal);
      newTotalCost = addMoney(newTotalCost, item.lineCost);
    }

    const isVoided = mergedNewMap.size === 0;
    const newDiscount = isVoided
      ? new Decimal(0)
      : toDecimal(input.discountAmount !== undefined ? input.discountAmount : sale.discountAmount);
    if (newDiscount.lt(0)) throw new ValidationError('Discount cannot be negative');
    if (newDiscount.gt(newSubtotal)) {
      throw new ValidationError('Discount amount cannot exceed updated subtotal');
    }

    const newTotal = subMoney(newSubtotal, newDiscount);
    const newGrossProfit = subMoney(newTotal, newTotalCost);

    const isMultiShare = (sale.shares?.length ?? 0) > 1;

    let newCash = new Decimal(0);
    let newMpesa = new Decimal(0);
    let newAmountPaid = new Decimal(0);
    let newOutstanding = new Decimal(0);
    let newPaymentMethod: SalePaymentMethod = sale.paymentMethod;
    let updatedCustomerId: string | null = sale.customerId;
    let primaryNewCustomerBalance = 0;

    if (isMultiShare) {
      // Multi-person split receipt editing
      type CustStat = { debt: Decimal; paid: Decimal; total: Decimal };
      const oldStatsByCust = new Map<string, CustStat>();
      for (const sh of sale.shares) {
        if (!sh.customerId) continue;
        const cur = oldStatsByCust.get(sh.customerId) ?? {
          debt: new Decimal(0),
          paid: new Decimal(0),
          total: new Decimal(0),
        };
        cur.debt = addMoney(cur.debt, sh.debtAmount);
        cur.paid = addMoney(cur.paid, sh.paidAmount);
        cur.total = addMoney(cur.total, sh.shareTotal);
        oldStatsByCust.set(sh.customerId, cur);
      }

      const newStatsByCust = new Map<string, CustStat>();

      if (isVoided) {
        await tx.saleShare.updateMany({
          where: { saleId: sale.id },
          data: {
            shareTotal: '0.00',
            cashAmount: '0.00',
            mpesaAmount: '0.00',
            paidAmount: '0.00',
            debtAmount: '0.00',
          },
        });
        await replaceSalePosPaymentsTx(tx, {
          saleId: sale.id,
          receiptNumber: sale.receiptNumber,
          userId,
          mpesaReference: cleanMpesaRef,
          entries: [],
        });

        const sortedOldCustIds = Array.from(oldStatsByCust.keys()).sort();
        for (const cid of sortedOldCustIds) {
          const oldS = oldStatsByCust.get(cid)!;
          const bal = await applyCustomerEditDeltaTx(tx, {
            customerId: cid,
            saleId: sale.id,
            receiptNumber: sale.receiptNumber,
            debtDelta: oldS.debt.negated(),
            purchasesDelta: oldS.total.negated(),
            paidDelta: oldS.paid.negated(),
            isVoided: true,
            cleanNote,
            cleanReason,
            userId,
          });
          if (cid === sale.customerId) primaryNewCustomerBalance = bal.toNumber();
        }
      } else {
        if (!input.splitShares || input.splitShares.length < 2) {
          throw new ValidationError(
            'Multi-person split receipts require updated splitShares summing to the new total'
          );
        }
        const validatedShares = normalizeAndValidateSplitShares(input.splitShares, newTotal);
        newCash = validatedShares.totalCash;
        newMpesa = validatedShares.totalMpesa;
        newAmountPaid = validatedShares.totalPaid;
        newOutstanding = validatedShares.totalDebt;
        newPaymentMethod = 'SPLIT';

        for (const sh of validatedShares.shares) {
          if (!sh.customerId) continue;
          const cur = newStatsByCust.get(sh.customerId) ?? {
            debt: new Decimal(0),
            paid: new Decimal(0),
            total: new Decimal(0),
          };
          cur.debt = addMoney(cur.debt, sh.debtAmount);
          cur.paid = addMoney(cur.paid, sh.paidAmount);
          cur.total = addMoney(cur.total, sh.shareTotal);
          newStatsByCust.set(sh.customerId, cur);
        }

        const allCustIds = Array.from(
          new Set([...oldStatsByCust.keys(), ...newStatsByCust.keys()])
        ).sort();
        const custRows = allCustIds.length
          ? await tx.customer.findMany({
              where: { id: { in: allCustIds } },
              select: { id: true, fullName: true, status: true },
            })
          : [];
        const custNameMap = new Map(custRows.map((c) => [c.id, c]));
        for (const cid of allCustIds) {
          if (!custNameMap.has(cid)) throw new NotFoundError('Selected customer not found');
        }

        for (const cid of allCustIds) {
          const oldS = oldStatsByCust.get(cid) ?? {
            debt: new Decimal(0),
            paid: new Decimal(0),
            total: new Decimal(0),
          };
          const newS = newStatsByCust.get(cid) ?? {
            debt: new Decimal(0),
            paid: new Decimal(0),
            total: new Decimal(0),
          };
          const debtDelta = subMoney(newS.debt, oldS.debt);
          const lockedAccount = await lockCustomerAccountTx(tx, cid);
          if (debtDelta.gt(0)) {
            const custInfo = custNameMap.get(cid)!;
            if (custInfo.status !== 'ACTIVE') {
              throw new ValidationError(
                `Customer ${custInfo.fullName} is ${custInfo.status.toLowerCase()} and cannot make credit purchases`
              );
            }
            const currentBal = toDecimal(lockedAccount.current_balance);
            const creditLimit = toDecimal(lockedAccount.credit_limit);
            const projectedBal = addMoney(currentBal, debtDelta);
            if (projectedBal.gt(creditLimit) && !input.allowCreditLimitOverride) {
              throw new ValidationError(
                `Credit limit exceeded for ${custInfo.fullName}. Current debt: KSh ${currentBal.toFixed(
                  2
                )}, Limit: KSh ${creditLimit.toFixed(2)}, Projected: KSh ${projectedBal.toFixed(2)}`
              );
            }
          }
        }

        await tx.saleShare.deleteMany({ where: { saleId: sale.id } });
        const paymentEntries: Array<{
          customerId: string | null;
          cashAmount: Decimal;
          mpesaAmount: Decimal;
          label: string;
        }> = [];

        for (let i = 0; i < validatedShares.shares.length; i += 1) {
          const sh = validatedShares.shares[i];
          const label =
            (sh.customerId ? custNameMap.get(sh.customerId)?.fullName : null) ||
            sh.payerName ||
            `Person ${i + 1}`;
          await tx.saleShare.create({
            data: {
              saleId: sale.id,
              customerId: sh.customerId,
              payerName: label,
              shareTotal: sh.shareTotal.toFixed(2),
              cashAmount: sh.cashAmount.toFixed(2),
              mpesaAmount: sh.mpesaAmount.toFixed(2),
              paidAmount: sh.paidAmount.toFixed(2),
              debtAmount: sh.debtAmount.toFixed(2),
              notes: sh.notes,
            },
          });
          paymentEntries.push({
            customerId: sh.customerId,
            cashAmount: sh.cashAmount,
            mpesaAmount: sh.mpesaAmount,
            label,
          });
        }

        await replaceSalePosPaymentsTx(tx, {
          saleId: sale.id,
          receiptNumber: sale.receiptNumber,
          userId,
          mpesaReference: cleanMpesaRef,
          entries: paymentEntries,
        });

        for (const cid of allCustIds) {
          const oldS = oldStatsByCust.get(cid) ?? {
            debt: new Decimal(0),
            paid: new Decimal(0),
            total: new Decimal(0),
          };
          const newS = newStatsByCust.get(cid) ?? {
            debt: new Decimal(0),
            paid: new Decimal(0),
            total: new Decimal(0),
          };
          const bal = await applyCustomerEditDeltaTx(tx, {
            customerId: cid,
            saleId: sale.id,
            receiptNumber: sale.receiptNumber,
            debtDelta: subMoney(newS.debt, oldS.debt),
            purchasesDelta: subMoney(newS.total, oldS.total),
            paidDelta: subMoney(newS.paid, oldS.paid),
            isVoided: false,
            cleanNote,
            cleanReason,
            userId,
          });
          if (cid === sale.customerId || primaryNewCustomerBalance === 0) {
            primaryNewCustomerBalance = bal.toNumber();
          }
        }

        const firstDebtor = validatedShares.shares.find((s) => s.customerId && s.debtAmount.gt(0));
        const firstLinked = validatedShares.shares.find((s) => s.customerId);
        if (!updatedCustomerId || !newStatsByCust.has(updatedCustomerId)) {
          updatedCustomerId = firstDebtor?.customerId ?? firstLinked?.customerId ?? null;
        }
      }
    } else {
      // Single-customer OR Walk-in sale (0 or 1 share)
      const resolvedPay = resolveUpdatedSingleSalePayments({
        newTotal,
        oldCash,
        oldMpesa,
        oldPaymentMethod: sale.paymentMethod,
        isVoided,
        hasCustomer: Boolean(sale.customerId),
        explicitCash: input.cashAmount,
        explicitMpesa: input.mpesaAmount,
      });

      newCash = resolvedPay.cashAmount;
      newMpesa = resolvedPay.mpesaAmount;
      newAmountPaid = resolvedPay.amountPaid;
      newOutstanding = resolvedPay.outstandingAmount;
      newPaymentMethod = resolvedPay.paymentMethod;

      if (sale.customerId && sale.customer) {
        const lockedAccount = await lockCustomerAccountTx(tx, sale.customerId);
        const debtDelta = subMoney(newOutstanding, oldOutstanding);
        const purchasesDelta = subMoney(newTotal, oldTotal);
        const paidDelta = subMoney(newAmountPaid, oldAmountPaid);

        if (debtDelta.gt(0)) {
          if (sale.customer.status !== 'ACTIVE') {
            throw new ValidationError(
              `Customer ${sale.customer.fullName} is ${sale.customer.status.toLowerCase()} and cannot make credit purchases`
            );
          }
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

        const newBal = await applyCustomerEditDeltaTx(tx, {
          customerId: sale.customerId,
          saleId: sale.id,
          receiptNumber: sale.receiptNumber,
          debtDelta,
          purchasesDelta,
          paidDelta,
          isVoided,
          cleanNote,
          cleanReason,
          userId,
        });
        primaryNewCustomerBalance = newBal.toNumber();
      }

      if (!newCash.eq(oldCash) || !newMpesa.eq(oldMpesa) || isVoided) {
        await replaceSalePosPaymentsTx(tx, {
          saleId: sale.id,
          receiptNumber: sale.receiptNumber,
          userId,
          mpesaReference: cleanMpesaRef,
          entries: isVoided
            ? []
            : [{ customerId: sale.customerId, cashAmount: newCash, mpesaAmount: newMpesa }],
        });
      }
    }

    await tx.sale.update({
      where: { id: sale.id },
      data: {
        customerId: updatedCustomerId,
        subtotal: newSubtotal.toFixed(2),
        discountAmount: newDiscount.toFixed(2),
        ...(input.discountReason !== undefined
          ? { discountReason: input.discountReason?.trim() || null }
          : {}),
        totalAmount: newTotal.toFixed(2),
        cashAmount: newCash.toFixed(2),
        mpesaAmount: newMpesa.toFixed(2),
        mpesaReference: cleanMpesaRef,
        amountPaid: newAmountPaid.toFixed(2),
        outstandingAmount: newOutstanding.toFixed(2),
        totalCost: newTotalCost.toFixed(2),
        grossProfit: newGrossProfit.toFixed(2),
        paymentMethod: newPaymentMethod,
        notes: cleanNote,
        status: isVoided ? 'VOIDED' : 'COMPLETED',
      },
    });

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
        debtDelta: subMoney(newOutstanding, oldOutstanding).toNumber(),
        isMultiShare,
        walkIn: !sale.customerId && !isMultiShare,
        voided: isVoided,
      },
      ipAddress,
    });

    const refreshed = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: {
        customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        items: true,
        payments: true,
        shares: {
          include: { customer: { select: { id: true, fullName: true, accountNumber: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return { sale: formatSale(refreshed), newCustomerBalance: primaryNewCustomerBalance };
  });

  return updatedResult;
}

export const updateSaleItems = updateCreditSaleItems;

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
      shares: {
        include: { customer: { select: { id: true, fullName: true, accountNumber: true } } },
        orderBy: { createdAt: 'asc' },
      },
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
      shares: {
        include: { customer: { select: { id: true, fullName: true, accountNumber: true } } },
        orderBy: { createdAt: 'asc' },
      },
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
  shares?: Array<{
    id: string;
    customerId: string | null;
    payerName: string | null;
    shareTotal: unknown;
    cashAmount: unknown;
    mpesaAmount: unknown;
    paidAmount: unknown;
    debtAmount: unknown;
    notes: string | null;
    customer?: { id: string; fullName: string; accountNumber: string } | null;
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
    shares: (sale.shares ?? []).map((sh) => ({
      id: sh.id,
      customerId: sh.customerId,
      payerName: sh.customer?.fullName || sh.payerName || 'Walk-in Payer',
      accountNumber: sh.customer?.accountNumber ?? null,
      shareTotal: toNumber(sh.shareTotal as number),
      cashAmount: toNumber(sh.cashAmount as number),
      mpesaAmount: toNumber(sh.mpesaAmount as number),
      paidAmount: toNumber(sh.paidAmount as number),
      debtAmount: toNumber(sh.debtAmount as number),
      notes: sh.notes,
    })),
  };
}

