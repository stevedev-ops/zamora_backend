import { CustomerStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { normalizePhone } from '../lib/phone';
import { toDecimal, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { generateSecureToken } from '../lib/crypto';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { env } from '../config/env';
import { formatMpesaPaymentSummary } from '../lib/mpesaDisplay';
import { lockCustomerAccountTx } from './debt.service';
import {
  buildWhatsAppShareUrl,
  dispatchNotification,
  ensureActiveCustomerPortalLink,
} from '../integrations/notifications';

export type AgingFilterBucket = 'ALL' | '0_7' | '8_30' | '30_PLUS';

export function getCustomerAgingDays(
  lastTransactionAt: Date | string | null | undefined,
  registeredAt: Date | string
): number {
  const ref = lastTransactionAt || registeredAt;
  const diffMs = Date.now() - new Date(ref).getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function getCustomerAgingBucket(days: number): '0_7' | '8_30' | '30_PLUS' {
  if (days <= 7) return '0_7';
  if (days <= 30) return '8_30';
  return '30_PLUS';
}

export async function listCustomers(params?: {
  search?: string;
  status?: CustomerStatus;
  hasDebt?: boolean;
  aging?: AgingFilterBucket;
}) {
  const search = params?.search?.trim();
  const normalizedPhone = search ? normalizePhone(search) : undefined;

  const customers = await prisma.customer.findMany({
    where: {
      ...(params?.status ? { status: params.status } : {}),
      ...(params?.hasDebt ? { account: { currentBalance: { gt: 0 } } } : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { accountNumber: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              ...(normalizedPhone ? [{ phone: { contains: normalizedPhone, mode: 'insensitive' as const } }] : []),
            ],
          }
        : {}),
    },
    include: {
      account: true,
      portalTokens: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { fullName: 'asc' },
  });

  const rows = customers.map((c) => {
    const lastTx = c.account?.lastTransactionAt ?? null;
    const agingDays = getCustomerAgingDays(lastTx, c.registeredAt);
    const agingBucket = getCustomerAgingBucket(agingDays);
    return {
      id: c.id,
      accountNumber: c.accountNumber,
      fullName: c.fullName,
      phone: c.phone,
      email: c.email,
      status: c.status,
      notes: c.notes,
      registeredAt: c.registeredAt,
      currentDebt: toNumber(c.account?.currentBalance ?? 0),
      creditLimit: toNumber(c.account?.creditLimit ?? 0),
      totalPurchases: toNumber(c.account?.totalPurchases ?? 0),
      totalPayments: toNumber(c.account?.totalPayments ?? 0),
      totalTransferredIn: toNumber(c.account?.totalTransferredIn ?? 0),
      totalTransferredOut: toNumber(c.account?.totalTransferredOut ?? 0),
      lastTransactionAt: lastTx,
      agingDays,
      agingBucket,
      portalUrl: c.portalTokens[0]
        ? `${env.publicPortalBaseUrl}/${c.portalTokens[0].token}`
        : null,
    };
  });

  if (params?.aging && params.aging !== 'ALL') {
    return rows.filter((r) => r.agingBucket === params.aging);
  }
  return rows;
}

export async function getCustomerProfile(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      account: true,
      creditLimits: { orderBy: { createdAt: 'desc' }, take: 20 },
      sales: {
        include: {
          items: true,
        },
        orderBy: { soldAt: 'desc' },
        take: 50,
      },
      payments: {
        orderBy: { paidAt: 'desc' },
        take: 50,
      },
      debtTransactions: {
        include: {
          sale: { include: { items: true } },
          payment: true,
          debtTransfer: {
            include: {
              fromCustomer: { select: { id: true, fullName: true, accountNumber: true } },
              toCustomer: { select: { id: true, fullName: true, accountNumber: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      },
    },
  });

  if (!customer) throw new NotFoundError('Customer not found');

  const [portalUrl, settings] = await Promise.all([
    ensureActiveCustomerPortalLink(customer.id),
    prisma.setting.findUnique({ where: { key: 'default' } }),
  ]);
  const currentDebt = toNumber(customer.account?.currentBalance ?? 0);
  const currency = settings?.currency || 'KSh';
  const mpesaInfo = settings ? formatMpesaPaymentSummary(settings, customer.accountNumber) : null;
  const shareMessage = `Hello ${customer.fullName}, your ${
    settings?.storeName || 'Zamora Liquor Store'
  } account (${customer.accountNumber}) current balance is ${currency} ${currentDebt.toFixed(2)}.${
    mpesaInfo ? ` Pay via ${mpesaInfo}.` : ''
  } View your itemized statement securely here: ${portalUrl}`;

  return {
    id: customer.id,
    accountNumber: customer.accountNumber,
    fullName: customer.fullName,
    phone: customer.phone,
    email: customer.email,
    status: customer.status,
    notes: customer.notes,
    registeredAt: customer.registeredAt,
    account: {
      currentBalance: currentDebt,
      creditLimit: toNumber(customer.account?.creditLimit ?? 0),
      totalPurchases: toNumber(customer.account?.totalPurchases ?? 0),
      totalPayments: toNumber(customer.account?.totalPayments ?? 0),
      totalTransferredIn: toNumber(customer.account?.totalTransferredIn ?? 0),
      totalTransferredOut: toNumber(customer.account?.totalTransferredOut ?? 0),
      lastTransactionAt: customer.account?.lastTransactionAt ?? null,
    },
    portalUrl,
    whatsappShareUrl: buildWhatsAppShareUrl(customer.phone, shareMessage),
    creditLimitHistory: customer.creditLimits.map((cl) => ({
      ...cl,
      limitAmount: toNumber(cl.limitAmount),
      previousLimit: toNumber(cl.previousLimit),
    })),
    sales: customer.sales.map((s) => ({
      ...s,
      subtotal: toNumber(s.subtotal),
      discountAmount: toNumber(s.discountAmount),
      totalAmount: toNumber(s.totalAmount),
      cashAmount: toNumber(s.cashAmount),
      mpesaAmount: toNumber(s.mpesaAmount),
      amountPaid: toNumber(s.amountPaid),
      outstandingAmount: toNumber(s.outstandingAmount),
      totalCost: toNumber(s.totalCost),
      grossProfit: toNumber(s.grossProfit),
      items: s.items.map((i) => ({
        ...i,
        unitSellingPrice: toNumber(i.unitSellingPrice),
        unitCostPrice: toNumber(i.unitCostPrice),
        lineTotal: toNumber(i.lineTotal),
        lineCost: toNumber(i.lineCost),
        lineProfit: toNumber(i.lineProfit),
      })),
    })),
    payments: customer.payments.map((p) => ({
      ...p,
      amount: toNumber(p.amount),
    })),
    debtTransactions: customer.debtTransactions.map((t) => ({
      ...t,
      amount: toNumber(t.amount),
      runningBalance: toNumber(t.runningBalance),
      sale: t.sale
        ? {
            ...t.sale,
            totalAmount: toNumber(t.sale.totalAmount),
            amountPaid: toNumber(t.sale.amountPaid),
            outstandingAmount: toNumber(t.sale.outstandingAmount),
            items: t.sale.items.map((i) => ({
              ...i,
              unitSellingPrice: toNumber(i.unitSellingPrice),
              lineTotal: toNumber(i.lineTotal),
            })),
          }
        : null,
    })),
  };
}

export async function createCustomer(
  input: {
    fullName: string;
    phone: string;
    email?: string | null;
    creditLimit?: number;
    notes?: string | null;
  },
  userId: string,
  ipAddress?: string
) {
  const phone = normalizePhone(input.phone);
  if (!phone || phone.length < 9) {
    throw new ValidationError('Valid phone number is required');
  }

  const existing = await prisma.customer.findUnique({ where: { phone } });
  if (existing) {
    throw new ConflictError(`A customer with phone ${phone} already exists (${existing.fullName})`);
  }

  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const initialLimit = toDecimal(input.creditLimit ?? settings?.defaultCreditLimit ?? 5000);
  if (initialLimit.lt(0)) throw new ValidationError('Credit limit cannot be negative');

  return prisma.$transaction(async (tx) => {
    const accountNumber = await nextSequenceNumber(tx, 'customer_account', 'CUST', 4);
    const customer = await tx.customer.create({
      data: {
        accountNumber,
        fullName: input.fullName.trim(),
        phone,
        email: input.email?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });

    await tx.customerAccount.create({
      data: {
        customerId: customer.id,
        currentBalance: '0.00',
        creditLimit: initialLimit.toFixed(2),
      },
    });

    await tx.creditLimit.create({
      data: {
        customerId: customer.id,
        limitAmount: initialLimit.toFixed(2),
        previousLimit: '0.00',
        reason: 'Initial customer registration',
        isActive: true,
        setByUserId: userId,
      },
    });

    const portalToken = generateSecureToken(24);
    await tx.customerPortalToken.create({
      data: {
        customerId: customer.id,
        token: portalToken,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CUSTOMER_CREATED',
      entityType: 'Customer',
      entityId: customer.id,
      metadata: { accountNumber, fullName: customer.fullName, phone },
      ipAddress,
    });

    return {
      ...customer,
      currentDebt: 0,
      creditLimit: initialLimit.toNumber(),
      portalUrl: `${env.publicPortalBaseUrl}/${portalToken}`,
    };
  });
}

export async function updateCustomer(
  id: string,
  input: {
    fullName?: string;
    phone?: string;
    email?: string | null;
    status?: CustomerStatus;
    notes?: string | null;
  },
  userId: string,
  ipAddress?: string
) {
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Customer not found');

  const newPhone = input.phone ? normalizePhone(input.phone) : existing.phone;
  if (newPhone !== existing.phone) {
    const dup = await prisma.customer.findUnique({ where: { phone: newPhone } });
    if (dup) throw new ConflictError(`Phone ${newPhone} belongs to another customer`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
        ...(input.phone !== undefined ? { phone: newPhone } : {}),
        ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CUSTOMER_UPDATED',
      entityType: 'Customer',
      entityId: id,
      ipAddress,
    });

    return updated;
  });
}

export async function deleteCustomer(
  id: string,
  userId: string,
  ipAddress?: string
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.customer.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!existing) throw new NotFoundError('Customer not found');

    let currentBalance = toDecimal(existing.account?.currentBalance ?? 0);
    if (existing.account) {
      const locked = await lockCustomerAccountTx(tx, id);
      currentBalance = toDecimal(locked.current_balance);
    }

    if (currentBalance.gt(0)) {
      throw new ValidationError(
        `Cannot delete ${existing.fullName} because they have an outstanding debt of KSh ${currentBalance.toFixed(
          2
        )}. Clear or settle their debt first.`
      );
    }
    if (!currentBalance.isZero()) {
      throw new ValidationError(
        `Cannot delete ${existing.fullName} while account balance is non-zero (KSh ${currentBalance.toFixed(2)}).`
      );
    }

    const pendingTransfers = await tx.debtTransfer.count({
      where: { fromCustomerId: id, status: 'PENDING_ACCEPTANCE' },
    });
    if (pendingTransfers > 0) {
      throw new ValidationError(
        `Cannot delete ${existing.fullName} while they have a pending outgoing debt transfer.`
      );
    }

    await tx.clarificationRequest.deleteMany({ where: { customerId: id } });
    await tx.debtTransaction.updateMany({
      where: { customerId: id, reversedTransactionId: { not: null } },
      data: { reversedTransactionId: null },
    });
    await tx.debtTransaction.updateMany({
      where: {
        reversedTransactionId: { not: null },
        reversedTransaction: { customerId: id },
      },
      data: { reversedTransactionId: null },
    });
    await tx.debtTransaction.deleteMany({ where: { customerId: id } });
    await tx.debtTransfer.deleteMany({
      where: { OR: [{ fromCustomerId: id }, { toCustomerId: id }] },
    });

    await tx.sale.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await tx.payment.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await tx.notification.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await tx.mpesaTransaction.updateMany({ where: { customerId: id }, data: { customerId: null } });

    await tx.customer.delete({ where: { id } });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CUSTOMER_DELETED',
      entityType: 'Customer',
      entityId: id,
      metadata: {
        accountNumber: existing.accountNumber,
        fullName: existing.fullName,
        phone: existing.phone,
      },
      ipAddress,
    });

    return {
      deleted: true,
      id,
      fullName: existing.fullName,
      accountNumber: existing.accountNumber,
    };
  });
}

export async function updateCustomerCreditLimit(
  customerId: string,
  limitAmount: number,
  reason: string,
  userId: string,
  ipAddress?: string
) {
  const limit = toDecimal(limitAmount);
  if (limit.lt(0)) throw new ValidationError('Credit limit cannot be negative');

  return prisma.$transaction(async (tx) => {
    const account = await tx.customerAccount.findUnique({ where: { customerId } });
    if (!account) throw new NotFoundError('Customer account not found');

    const previousLimit = account.creditLimit;

    await tx.creditLimit.updateMany({
      where: { customerId, isActive: true },
      data: { isActive: false },
    });

    const record = await tx.creditLimit.create({
      data: {
        customerId,
        limitAmount: limit.toFixed(2),
        previousLimit,
        reason: reason.trim(),
        isActive: true,
        setByUserId: userId,
      },
    });

    await tx.customerAccount.update({
      where: { customerId },
      data: { creditLimit: limit.toFixed(2) },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CREDIT_LIMIT_UPDATED',
      entityType: 'Customer',
      entityId: customerId,
      metadata: {
        previousLimit: toNumber(previousLimit),
        newLimit: limit.toNumber(),
        reason,
      },
      ipAddress,
    });

    return {
      ...record,
      limitAmount: toNumber(record.limitAmount),
      previousLimit: toNumber(record.previousLimit),
    };
  });
}

export async function regenerateCustomerPortalLink(
  customerId: string,
  userId: string,
  ipAddress?: string
) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError('Customer not found');

  return prisma.$transaction(async (tx) => {
    await tx.customerPortalToken.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const rawToken = generateSecureToken(24);
    const portalToken = await tx.customerPortalToken.create({
      data: {
        customerId,
        token: rawToken,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'PORTAL_LINK_REGENERATED',
      entityType: 'Customer',
      entityId: customerId,
      ipAddress,
    });

    return {
      tokenId: portalToken.id,
      expiresAt: portalToken.expiresAt,
      portalUrl: `${env.publicPortalBaseUrl}/${rawToken}`,
    };
  });
}

export async function shareCustomerPortalLink(
  customerId: string,
  channel: 'SMS' | 'WHATSAPP',
  userId: string
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { account: true },
  });
  if (!customer) throw new NotFoundError('Customer not found');

  const portalUrl = await ensureActiveCustomerPortalLink(customer.id);
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const storeName = settings?.storeName || 'Zamora Liquor Store';
  const currency = settings?.currency || 'KSh';
  const balance = toNumber(customer.account?.currentBalance ?? 0).toFixed(2);

  const mpesaInfo = settings ? formatMpesaPaymentSummary(settings, customer.accountNumber) : null;
  const message = `${storeName}: Hello ${customer.fullName} (${customer.accountNumber}), your current debt balance is ${currency} ${balance}.${
    mpesaInfo ? ` Pay via ${mpesaInfo}.` : ''
  } View your itemized statement and receipts here: ${portalUrl}`;

  const notification = await dispatchNotification({
    customerId: customer.id,
    channel,
    recipient: customer.phone,
    eventType: 'PAYMENT_OVERDUE',
    subject: 'Customer Debt Portal Link',
    message,
  });

  await prisma.auditLog.create({
    data: {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'PORTAL_LINK_SHARED',
      entityType: 'Customer',
      entityId: customer.id,
      metadata: { channel, notificationId: notification.id },
    },
  });

  return {
    notificationId: notification.id,
    portalUrl,
    whatsappUrl: buildWhatsAppShareUrl(customer.phone, message),
    status: notification.status,
  };
}

