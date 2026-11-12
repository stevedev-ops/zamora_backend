import {
  DebtTransactionType,
  LedgerDirection,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { prisma } from '../lib/prisma';
import { addMoney, subMoney, toDecimal, toFixed2, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { generateNumericOtp, generateSecureToken, hashToken } from '../lib/crypto';
import { recordAuditLog } from '../lib/audit';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { buildDateRangeFilter } from '../lib/dateFilter';
import { env } from '../config/env';
import { dispatchNotification, notifyCustomerDebtEvent } from '../integrations/notifications';

interface LockedAccountRow {
  id: string;
  customer_id: string;
  current_balance: Prisma.Decimal;
  credit_limit: Prisma.Decimal;
}

export async function lockCustomerAccountTx(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<LockedAccountRow> {
  const rows = await tx.$queryRaw<LockedAccountRow[]>`
    SELECT id, customer_id, current_balance, credit_limit
    FROM customer_accounts
    WHERE customer_id = ${customerId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new NotFoundError('Customer debt account not found');
  }
  return rows[0];
}

export async function appendLedgerEntryTx(
  tx: Prisma.TransactionClient,
  params: {
    customerId: string;
    transactionType: DebtTransactionType;
    direction: LedgerDirection;
    amount: Decimal.Value;
    description: string;
    reason?: string;
    saleId?: string;
    paymentId?: string;
    debtTransferId?: string;
    reversedTransactionId?: string;
    idempotencyKey?: string;
    userId?: string;
    accountStatsIncrement?: {
      totalPurchases?: Decimal.Value;
      totalPayments?: Decimal.Value;
      totalTransferredIn?: Decimal.Value;
      totalTransferredOut?: Decimal.Value;
    };
  }
) {
  const amountDec = toDecimal(params.amount);
  if (amountDec.lte(0)) {
    throw new ValidationError('Ledger transaction amount must be greater than zero');
  }

  const account = await lockCustomerAccountTx(tx, params.customerId);
  const currentBalance = toDecimal(account.current_balance);

  const newBalance =
    params.direction === 'DEBIT'
      ? addMoney(currentBalance, amountDec)
      : subMoney(currentBalance, amountDec);

  if (newBalance.lt(0)) {
    throw new ValidationError(
      `Operation would result in negative debt balance (${newBalance.toFixed(2)}). Current balance is ${currentBalance.toFixed(2)}.`
    );
  }

  const referenceNumber = await nextSequenceNumber(tx, 'debt_transaction', 'LED', 5);

  const ledgerEntry = await tx.debtTransaction.create({
    data: {
      referenceNumber,
      customerId: params.customerId,
      customerAccountId: account.id,
      transactionType: params.transactionType,
      direction: params.direction,
      amount: amountDec.toFixed(2),
      runningBalance: newBalance.toFixed(2),
      description: params.description,
      reason: params.reason,
      saleId: params.saleId,
      paymentId: params.paymentId,
      debtTransferId: params.debtTransferId,
      reversedTransactionId: params.reversedTransactionId,
      idempotencyKey: params.idempotencyKey,
      createdByUserId: params.userId,
    },
  });

  const inc = params.accountStatsIncrement;
  await tx.customerAccount.update({
    where: { id: account.id },
    data: {
      currentBalance: newBalance.toFixed(2),
      lastTransactionAt: new Date(),
      ...(inc?.totalPurchases
        ? { totalPurchases: { increment: toNumber(inc.totalPurchases) } }
        : {}),
      ...(inc?.totalPayments ? { totalPayments: { increment: toNumber(inc.totalPayments) } } : {}),
      ...(inc?.totalTransferredIn
        ? { totalTransferredIn: { increment: toNumber(inc.totalTransferredIn) } }
        : {}),
      ...(inc?.totalTransferredOut
        ? { totalTransferredOut: { increment: toNumber(inc.totalTransferredOut) } }
        : {}),
    },
  });

  return {
    ledgerEntry,
    previousBalance: currentBalance,
    newBalance,
  };
}

export async function recordDebtRepayment(
  input: {
    customerId: string;
    amount: number;
    method: PaymentMethod;
    mpesaReference?: string;
    mpesaCheckoutRequestId?: string;
    notes?: string;
    idempotencyKey?: string;
  },
  userId?: string,
  ipAddress?: string
) {
  if (input.idempotencyKey) {
    const existingPayment = await prisma.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { customer: { include: { account: true } } },
    });
    if (existingPayment) {
      return {
        payment: { ...existingPayment, amount: toNumber(existingPayment.amount) },
        newBalance: toNumber(existingPayment.customer?.account?.currentBalance ?? 0),
        deduplicated: true,
      };
    }
  }

  const amountDec = toDecimal(input.amount);
  if (amountDec.lte(0)) {
    throw new ValidationError('Payment amount must be greater than zero');
  }

  if (input.method === 'MPESA' && !input.mpesaReference?.trim() && !input.mpesaCheckoutRequestId) {
    throw new ValidationError('M-Pesa transaction reference is required for M-Pesa payments');
  }

  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundError('Customer not found');

    const account = await lockCustomerAccountTx(tx, input.customerId);
    const currentBal = toDecimal(account.current_balance);
    if (amountDec.gt(currentBal)) {
      throw new ValidationError(
        `Payment amount (${amountDec.toFixed(2)}) exceeds outstanding debt (${currentBal.toFixed(2)})`
      );
    }

    const paymentRef = await nextSequenceNumber(tx, 'payment', 'PAY', 5);
    const payment = await tx.payment.create({
      data: {
        referenceNumber: paymentRef,
        customerId: input.customerId,
        paymentType: 'DEBT_REPAYMENT',
        amount: amountDec.toFixed(2),
        method: input.method,
        mpesaReference: input.mpesaReference?.trim() || null,
        mpesaCheckoutRequestId: input.mpesaCheckoutRequestId || null,
        notes: input.notes?.trim() || null,
        idempotencyKey: input.idempotencyKey || null,
        receivedByUserId: userId || null,
      },
    });

    const ledgerRes = await appendLedgerEntryTx(tx, {
      customerId: input.customerId,
      transactionType: 'PAYMENT',
      direction: 'CREDIT',
      amount: amountDec,
      description: `Debt repayment via ${input.method}${
        input.mpesaReference ? ` (Ref: ${input.mpesaReference.trim()})` : ''
      } [${paymentRef}]`,
      reason: input.notes?.trim() || undefined,
      paymentId: payment.id,
      userId,
      accountStatsIncrement: { totalPayments: amountDec },
    });

    await recordAuditLog(tx, {
      actorType: userId ? 'OWNER' : 'SYSTEM',
      actorId: userId || input.customerId,
      userId,
      action: 'DEBT_REPAYMENT_RECORDED',
      entityType: 'Payment',
      entityId: payment.id,
      metadata: {
        customerId: input.customerId,
        amount: amountDec.toNumber(),
        method: input.method,
        mpesaReference: input.mpesaReference,
        newBalance: ledgerRes.newBalance.toNumber(),
      },
      ipAddress,
    });

    return {
      customer,
      payment,
      ledgerEntry: ledgerRes.ledgerEntry,
      newBalance: ledgerRes.newBalance,
    };
  });

  await notifyCustomerDebtEvent({
    customerId: result.customer.id,
    customerName: result.customer.fullName,
    customerPhone: result.customer.phone,
    eventType: 'PAYMENT_RECEIVED',
    subject: `Payment Received (${result.payment.referenceNumber})`,
    messageBody: `payment of KSh ${toFixed2(result.payment.amount)} (${result.payment.method}) has been received (Ref: ${result.payment.referenceNumber}).`,
    newBalance: result.newBalance.toFixed(2),
  });

  return {
    payment: { ...result.payment, amount: toNumber(result.payment.amount) },
    ledgerEntry: {
      ...result.ledgerEntry,
      amount: toNumber(result.ledgerEntry.amount),
      runningBalance: toNumber(result.ledgerEntry.runningBalance),
    },
    newBalance: result.newBalance.toNumber(),
  };
}

export async function initiateDebtTransfer(
  input: {
    fromCustomerId: string;
    toCustomerId: string;
    amount: number;
    reason: string;
    idempotencyKey?: string;
  },
  userId: string,
  ipAddress?: string
) {
  if (input.fromCustomerId === input.toCustomerId) {
    throw new ValidationError('Original customer and receiving customer must be different');
  }

  const amountDec = toDecimal(input.amount);
  if (amountDec.lte(0)) {
    throw new ValidationError('Transfer amount must be greater than zero');
  }
  if (!input.reason?.trim()) {
    throw new ValidationError('A reason for the debt transfer is required');
  }

  if (input.idempotencyKey) {
    const existing = await prisma.debtTransfer.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        fromCustomer: { select: { id: true, fullName: true, accountNumber: true } },
        toCustomer: { select: { id: true, fullName: true, accountNumber: true } },
      },
    });
    if (existing) {
      return { transfer: { ...existing, amount: toNumber(existing.amount) }, deduplicated: true };
    }
  }

  const rawToken = generateSecureToken(24);
  const rawOtp = generateNumericOtp(6);
  const confirmationTokenHash = hashToken(rawToken);
  const otpHash = hashToken(rawOtp);
  const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const created = await prisma.$transaction(async (tx) => {
    const fromCustomer = await tx.customer.findUnique({ where: { id: input.fromCustomerId } });
    const toCustomer = await tx.customer.findUnique({ where: { id: input.toCustomerId } });
    if (!fromCustomer || !toCustomer) {
      throw new NotFoundError('Both original and receiving customers must exist');
    }

    const fromAccount = await lockCustomerAccountTx(tx, input.fromCustomerId);
    const currentDebt = toDecimal(fromAccount.current_balance);

    // Ensure pending transfers + this transfer do not exceed current debt
    const pendingAgg = await tx.debtTransfer.aggregate({
      where: { fromCustomerId: input.fromCustomerId, status: 'PENDING_ACCEPTANCE' },
      _sum: { amount: true },
    });
    const pendingTotal = toDecimal(pendingAgg._sum.amount ?? 0);
    const availableToTransfer = subMoney(currentDebt, pendingTotal);

    if (amountDec.gt(currentDebt) || amountDec.gt(availableToTransfer)) {
      throw new ValidationError(
        `Transfer amount (${amountDec.toFixed(2)}) exceeds ${fromCustomer.fullName}'s available transferable debt (${availableToTransfer.toFixed(2)})`
      );
    }

    const referenceNumber = await nextSequenceNumber(tx, 'debt_transfer', 'TRF', 5);

    const transfer = await tx.debtTransfer.create({
      data: {
        referenceNumber,
        fromCustomerId: input.fromCustomerId,
        toCustomerId: input.toCustomerId,
        amount: amountDec.toFixed(2),
        reason: input.reason.trim(),
        status: 'PENDING_ACCEPTANCE',
        confirmationTokenHash,
        otpHash,
        otpExpiresAt,
        idempotencyKey: input.idempotencyKey || null,
        initiatedByUserId: userId,
      },
      include: {
        fromCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        toCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'DEBT_TRANSFER_INITIATED',
      entityType: 'DebtTransfer',
      entityId: transfer.id,
      metadata: {
        referenceNumber,
        fromCustomerId: input.fromCustomerId,
        toCustomerId: input.toCustomerId,
        amount: amountDec.toNumber(),
        reason: input.reason.trim(),
      },
      ipAddress,
    });

    return transfer;
  });

  const confirmationUrl = `${env.frontendUrl}/transfer-confirm/${rawToken}`;
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const storeName = settings?.storeName || 'Zamora Liquor Store';
  const currency = settings?.currency || 'KSh';

  await dispatchNotification({
    customerId: created.toCustomer.id,
    channel: 'SMS',
    recipient: created.toCustomer.phone,
    eventType: 'DEBT_TRANSFER_REQUEST',
    subject: `Debt Transfer Request (${created.referenceNumber})`,
    message: `${storeName}: ${created.fromCustomer.fullName} requested to transfer ${currency} ${toFixed2(
      created.amount
    )} debt to your account (${created.reason}). Confirm with OTP ${rawOtp} at ${confirmationUrl}`,
  });

  return {
    transfer: {
      ...created,
      amount: toNumber(created.amount),
    },
    confirmationUrl,
    ...(env.exposeDevOtp ? { devOtp: rawOtp, devConfirmationToken: rawToken } : {}),
  };
}

export async function finalizeDebtTransferAcceptance(params: {
  transferId?: string;
  confirmationToken?: string;
  otp?: string;
  bypassOtpForPortalCustomerId?: string;
  acceptedMethod: 'CONFIRMATION_LINK' | 'OTP_OWNER' | 'PORTAL';
  userId?: string;
  ipAddress?: string;
}) {
  const result = await prisma.$transaction(async (tx) => {
    const whereClause = params.transferId
      ? { id: params.transferId }
      : { confirmationTokenHash: hashToken(params.confirmationToken || '') };

    const transfer = await tx.debtTransfer.findFirst({
      where: whereClause,
      include: {
        fromCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        toCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      },
    });

    if (!transfer) {
      throw new NotFoundError('Debt transfer request not found');
    }

    if (transfer.status !== 'PENDING_ACCEPTANCE') {
      throw new ConflictError(`Transfer is already ${transfer.status.toLowerCase()}`);
    }

    if (transfer.otpExpiresAt.getTime() < Date.now()) {
      await tx.debtTransfer.update({
        where: { id: transfer.id },
        data: { status: 'EXPIRED' },
      });
      throw new ValidationError('Debt transfer confirmation OTP/link has expired');
    }

    // Verify authorization: either receiving customer's verified portal session, or valid OTP
    const isPortalAuthorized =
      params.bypassOtpForPortalCustomerId &&
      params.bypassOtpForPortalCustomerId === transfer.toCustomerId;

    if (!isPortalAuthorized) {
      if (!params.otp?.trim()) {
        throw new ValidationError('Receiving customer OTP confirmation is required');
      }
      if (transfer.otpAttempts >= 5) {
        throw new ValidationError('Maximum OTP verification attempts exceeded');
      }
      const otpMatches = hashToken(params.otp.trim()) === transfer.otpHash;
      if (!otpMatches) {
        await tx.debtTransfer.update({
          where: { id: transfer.id },
          data: { otpAttempts: { increment: 1 } },
        });
        throw new ValidationError('Invalid confirmation OTP');
      }
    }

    // Lock both customer accounts in deterministic UUID order to avoid deadlocks
    const [firstId, secondId] =
      transfer.fromCustomerId < transfer.toCustomerId
        ? [transfer.fromCustomerId, transfer.toCustomerId]
        : [transfer.toCustomerId, transfer.fromCustomerId];

    await lockCustomerAccountTx(tx, firstId);
    await lockCustomerAccountTx(tx, secondId);

    const fromAccount = await tx.customerAccount.findUniqueOrThrow({
      where: { customerId: transfer.fromCustomerId },
    });

    const amountDec = toDecimal(transfer.amount);
    if (amountDec.gt(toDecimal(fromAccount.currentBalance))) {
      throw new ValidationError(
        `Transfer cannot be finalized because ${transfer.fromCustomer.fullName}'s current debt (${toFixed2(
          fromAccount.currentBalance
        )}) is now lower than the transfer amount (${amountDec.toFixed(2)})`
      );
    }

    // Reduce original customer's debt
    const outLedger = await appendLedgerEntryTx(tx, {
      customerId: transfer.fromCustomerId,
      transactionType: 'TRANSFER_OUT',
      direction: 'CREDIT',
      amount: amountDec,
      description: `Debt transferred to ${transfer.toCustomer.fullName} (${transfer.toCustomer.accountNumber}) [${transfer.referenceNumber}]`,
      reason: transfer.reason,
      debtTransferId: transfer.id,
      userId: params.userId,
      accountStatsIncrement: { totalTransferredOut: amountDec },
    });

    // Increase receiving customer's debt
    const inLedger = await appendLedgerEntryTx(tx, {
      customerId: transfer.toCustomerId,
      transactionType: 'TRANSFER_IN',
      direction: 'DEBIT',
      amount: amountDec,
      description: `Debt transferred from ${transfer.fromCustomer.fullName} (${transfer.fromCustomer.accountNumber}) [${transfer.referenceNumber}]`,
      reason: transfer.reason,
      debtTransferId: transfer.id,
      userId: params.userId,
      accountStatsIncrement: { totalTransferredIn: amountDec },
    });

    const updatedTransfer = await tx.debtTransfer.update({
      where: { id: transfer.id },
      data: {
        status: 'COMPLETED',
        acceptedAt: new Date(),
        acceptedMethod: params.acceptedMethod,
      },
      include: {
        fromCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
        toCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      },
    });

    await recordAuditLog(tx, {
      actorType: params.userId ? 'OWNER' : 'CUSTOMER_PORTAL',
      actorId: params.userId || transfer.toCustomerId,
      userId: params.userId,
      action: 'DEBT_TRANSFER_COMPLETED',
      entityType: 'DebtTransfer',
      entityId: transfer.id,
      metadata: {
        referenceNumber: transfer.referenceNumber,
        amount: amountDec.toNumber(),
        acceptedMethod: params.acceptedMethod,
        fromNewBalance: outLedger.newBalance.toNumber(),
        toNewBalance: inLedger.newBalance.toNumber(),
      },
      ipAddress: params.ipAddress,
    });

    return {
      transfer: { ...updatedTransfer, amount: toNumber(updatedTransfer.amount) },
      fromNewBalance: outLedger.newBalance,
      toNewBalance: inLedger.newBalance,
    };
  });

  // Notify both customers with updated balances and portal links
  await Promise.all([
    notifyCustomerDebtEvent({
      customerId: result.transfer.fromCustomer.id,
      customerName: result.transfer.fromCustomer.fullName,
      customerPhone: result.transfer.fromCustomer.phone,
      eventType: 'DEBT_TRANSFER_COMPLETED',
      subject: `Debt Transfer Completed (${result.transfer.referenceNumber})`,
      messageBody: `KSh ${toFixed2(result.transfer.amount)} of your debt was accepted by ${result.transfer.toCustomer.fullName} (${result.transfer.referenceNumber}).`,
      newBalance: result.fromNewBalance.toFixed(2),
    }),
    notifyCustomerDebtEvent({
      customerId: result.transfer.toCustomer.id,
      customerName: result.transfer.toCustomer.fullName,
      customerPhone: result.transfer.toCustomer.phone,
      eventType: 'DEBT_TRANSFER_COMPLETED',
      subject: `Debt Transfer Accepted (${result.transfer.referenceNumber})`,
      messageBody: `you accepted a debt transfer of KSh ${toFixed2(result.transfer.amount)} from ${result.transfer.fromCustomer.fullName} (${result.transfer.referenceNumber}).`,
      newBalance: result.toNewBalance.toFixed(2),
    }),
  ]);

  return {
    transfer: result.transfer,
    fromNewBalance: result.fromNewBalance.toNumber(),
    toNewBalance: result.toNewBalance.toNumber(),
  };
}

export async function rejectOrCancelDebtTransfer(params: {
  transferId?: string;
  confirmationToken?: string;
  action: 'REJECTED' | 'CANCELLED';
  actorCustomerId?: string;
  userId?: string;
}) {
  const transfer = await prisma.debtTransfer.findFirst({
    where: params.transferId
      ? { id: params.transferId }
      : { confirmationTokenHash: hashToken(params.confirmationToken || '') },
  });

  if (!transfer) throw new NotFoundError('Debt transfer not found');
  if (transfer.status !== 'PENDING_ACCEPTANCE') {
    throw new ConflictError(`Transfer is already ${transfer.status.toLowerCase()}`);
  }
  if (params.actorCustomerId && transfer.toCustomerId !== params.actorCustomerId) {
    throw new ValidationError('Only the receiving customer can decline this transfer');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.debtTransfer.update({
      where: { id: transfer.id },
      data: {
        status: params.action,
        ...(params.action === 'REJECTED' ? { rejectedAt: new Date() } : {}),
      },
    });
    await recordAuditLog(tx, {
      actorType: params.userId ? 'OWNER' : 'CUSTOMER_PORTAL',
      actorId: params.userId || params.actorCustomerId,
      userId: params.userId,
      action: `DEBT_TRANSFER_${params.action}`,
      entityType: 'DebtTransfer',
      entityId: transfer.id,
    });
    return { ...updated, amount: toNumber(updated.amount) };
  });
}

export async function adjustCustomerDebt(
  input: {
    customerId: string;
    adjustmentKind: 'ADD_DEBT' | 'DEDUCT_ERROR' | 'DISCOUNT_OR_WRITEOFF';
    amount: number;
    reason?: string;
    notes?: string;
    idempotencyKey?: string;
  },
  userId: string,
  ipAddress?: string
) {
  const providedNote = input.reason?.trim() || input.notes?.trim() || '';
  if (input.adjustmentKind !== 'ADD_DEBT' && providedNote.length < 3) {
    throw new ValidationError('A reason (at least 3 characters) is required for this debt adjustment');
  }
  const effectiveReason = providedNote || 'Additional debt recorded';
  const amountDec = toDecimal(input.amount);
  if (amountDec.lte(0)) {
    throw new ValidationError('Adjustment amount must be greater than zero');
  }

  if (input.idempotencyKey) {
    const existing = await prisma.debtTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        transaction: {
          ...existing,
          amount: toNumber(existing.amount),
          runningBalance: toNumber(existing.runningBalance),
        },
        deduplicated: true,
      };
    }
  }

  const isDebit = input.adjustmentKind === 'ADD_DEBT';
  const transactionType: DebtTransactionType = isDebit
    ? 'ADJUSTMENT_DEBIT'
    : 'ADJUSTMENT_CREDIT';
  const direction: LedgerDirection = isDebit ? 'DEBIT' : 'CREDIT';

  const labelMap = {
    ADD_DEBT: 'Authorized debt addition',
    DEDUCT_ERROR: 'Authorized error deduction',
    DISCOUNT_OR_WRITEOFF: 'Approved discount / write-off',
  };

  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundError('Customer not found');

    const ledgerRes = await appendLedgerEntryTx(tx, {
      customerId: input.customerId,
      transactionType,
      direction,
      amount: amountDec,
      description: providedNote
        ? `${labelMap[input.adjustmentKind]}: ${providedNote}`
        : labelMap[input.adjustmentKind],
      reason: effectiveReason,
      idempotencyKey: input.idempotencyKey,
      userId,
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'DEBT_ADJUSTMENT',
      entityType: 'DebtTransaction',
      entityId: ledgerRes.ledgerEntry.id,
      metadata: {
        customerId: input.customerId,
        adjustmentKind: input.adjustmentKind,
        amount: amountDec.toNumber(),
        reason: effectiveReason,
        newBalance: ledgerRes.newBalance.toNumber(),
      },
      ipAddress,
    });

    return { customer, ledgerRes };
  });

  await notifyCustomerDebtEvent({
    customerId: result.customer.id,
    customerName: result.customer.fullName,
    customerPhone: result.customer.phone,
    eventType: 'DEBT_ADJUSTMENT',
    subject: `Account Adjustment (${result.ledgerRes.ledgerEntry.referenceNumber})`,
    messageBody: `an account adjustment (${isDebit ? '+' : '-'}KSh ${amountDec.toFixed(2)}) was applied (${effectiveReason}).`,
    newBalance: result.ledgerRes.newBalance.toFixed(2),
  });

  return {
    transaction: {
      ...result.ledgerRes.ledgerEntry,
      amount: toNumber(result.ledgerRes.ledgerEntry.amount),
      runningBalance: toNumber(result.ledgerRes.ledgerEntry.runningBalance),
    },
    newBalance: result.ledgerRes.newBalance.toNumber(),
  };
}

export async function reverseDebtTransaction(
  transactionId: string,
  reason: string,
  userId: string,
  ipAddress?: string
) {
  if (!reason?.trim()) {
    throw new ValidationError('A reason is required to reverse a transaction');
  }

  return prisma.$transaction(async (tx) => {
    const original = await tx.debtTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!original) throw new NotFoundError('Debt transaction not found');
    if (original.isReversed) {
      throw new ConflictError('This transaction has already been reversed');
    }
    if (original.transactionType === 'REVERSAL') {
      throw new ValidationError('A reversal entry cannot itself be reversed');
    }

    const inverseDirection: LedgerDirection =
      original.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';

    const statsFix =
      original.transactionType === 'PAYMENT'
        ? { totalPayments: -toNumber(original.amount) }
        : original.transactionType === 'CREDIT_SALE'
        ? { totalPurchases: -toNumber(original.amount) }
        : undefined;

    await tx.debtTransaction.update({
      where: { id: original.id },
      data: { isReversed: true },
    });

    const reversal = await appendLedgerEntryTx(tx, {
      customerId: original.customerId,
      transactionType: 'REVERSAL',
      direction: inverseDirection,
      amount: original.amount,
      description: `Reversal of ${original.referenceNumber} (${original.transactionType}): ${reason.trim()}`,
      reason: reason.trim(),
      reversedTransactionId: original.id,
      userId,
      accountStatsIncrement: statsFix,
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'DEBT_TRANSACTION_REVERSED',
      entityType: 'DebtTransaction',
      entityId: original.id,
      metadata: {
        originalRef: original.referenceNumber,
        reversalRef: reversal.ledgerEntry.referenceNumber,
        reason: reason.trim(),
        newBalance: reversal.newBalance.toNumber(),
      },
      ipAddress,
    });

    return {
      reversalTransaction: {
        ...reversal.ledgerEntry,
        amount: toNumber(reversal.ledgerEntry.amount),
        runningBalance: toNumber(reversal.ledgerEntry.runningBalance),
      },
      newBalance: reversal.newBalance.toNumber(),
    };
  });
}

export async function listDebtTransactions(params?: {
  customerId?: string;
  transactionType?: DebtTransactionType;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
}) {
  const search = params?.search?.trim();
  const createdAtFilter = buildDateRangeFilter(params?.startDate, params?.endDate);
  const rows = await prisma.debtTransaction.findMany({
    where: {
      ...(params?.customerId ? { customerId: params.customerId } : {}),
      ...(params?.transactionType ? { transactionType: params.transactionType } : {}),
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
      ...(search
        ? {
            OR: [
              { referenceNumber: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { customer: { fullName: { contains: search, mode: 'insensitive' } } },
              { customer: { accountNumber: { contains: search, mode: 'insensitive' } } },
              { customer: { phone: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      sale: {
        select: {
          id: true,
          receiptNumber: true,
          status: true,
          notes: true,
          discountAmount: true,
          totalAmount: true,
          amountPaid: true,
          outstandingAmount: true,
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              brand: true,
              bottleSize: true,
              quantity: true,
              unitSellingPrice: true,
              lineTotal: true,
            },
          },
        },
      },
      payment: {
        select: { id: true, referenceNumber: true, method: true, mpesaReference: true },
      },
      debtTransfer: {
        select: {
          id: true,
          referenceNumber: true,
          fromCustomer: { select: { id: true, fullName: true, accountNumber: true } },
          toCustomer: { select: { id: true, fullName: true, accountNumber: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: params?.limit ?? 150,
  });

  return rows.map((r) => ({
    ...r,
    amount: toNumber(r.amount),
    runningBalance: toNumber(r.runningBalance),
    sale: r.sale
      ? {
          ...r.sale,
          discountAmount: toNumber(r.sale.discountAmount),
          totalAmount: toNumber(r.sale.totalAmount),
          amountPaid: toNumber(r.sale.amountPaid),
          outstandingAmount: toNumber(r.sale.outstandingAmount),
          items: r.sale.items.map((i) => ({
            ...i,
            unitSellingPrice: toNumber(i.unitSellingPrice),
            lineTotal: toNumber(i.lineTotal),
          })),
        }
      : null,
  }));
}

export async function listDebtTransfers(params?: { customerId?: string; status?: string }) {
  const rows = await prisma.debtTransfer.findMany({
    where: {
      ...(params?.customerId
        ? {
            OR: [
              { fromCustomerId: params.customerId },
              { toCustomerId: params.customerId },
            ],
          }
        : {}),
      ...(params?.status ? { status: params.status as never } : {}),
    },
    include: {
      fromCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      toCustomer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((r) => ({
    ...r,
    amount: toNumber(r.amount),
  }));
}

export async function listClarificationRequests() {
  return prisma.clarificationRequest.findMany({
    include: {
      customer: { select: { id: true, fullName: true, accountNumber: true, phone: true } },
      debtTransaction: { select: { id: true, referenceNumber: true, amount: true, description: true } },
      sale: { select: { id: true, receiptNumber: true, totalAmount: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function resolveClarificationRequest(
  id: string,
  ownerResponse: string,
  userId: string
) {
  const reqRecord = await prisma.clarificationRequest.findUnique({ where: { id } });
  if (!reqRecord) throw new NotFoundError('Clarification request not found');

  return prisma.clarificationRequest.update({
    where: { id },
    data: {
      status: 'RESOLVED',
      ownerResponse: ownerResponse.trim(),
      resolvedAt: new Date(),
    },
  });
}

export async function sendOverdueDebtReminders(userId: string) {
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const days = settings?.overdueDaysThreshold ?? 14;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const overdueAccounts = await prisma.customerAccount.findMany({
    where: {
      currentBalance: { gt: 0 },
      OR: [{ lastTransactionAt: { lte: cutoff } }, { lastTransactionAt: null }],
    },
    include: { customer: true },
  });

  let sentCount = 0;
  for (const acc of overdueAccounts) {
    if (acc.customer.status !== 'ACTIVE') continue;
    await notifyCustomerDebtEvent({
      customerId: acc.customer.id,
      customerName: acc.customer.fullName,
      customerPhone: acc.customer.phone,
      eventType: 'PAYMENT_OVERDUE',
      subject: 'Payment Reminder',
      messageBody: `this is a friendly reminder that your account balance is overdue.`,
      newBalance: toFixed2(acc.currentBalance),
    });
    sentCount += 1;
  }

  await prisma.auditLog.create({
    data: {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'OVERDUE_REMINDERS_SENT',
      entityType: 'Notification',
      metadata: { sentCount, overdueDaysThreshold: days },
    },
  });

  return { sentCount };
}

