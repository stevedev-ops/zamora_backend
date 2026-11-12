import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { generateNumericOtp, hashToken } from '../lib/crypto';
import { signPortalJwt } from '../lib/jwt';
import { maskPhone } from '../lib/phone';
import { toNumber } from '../lib/money';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../lib/errors';
import { dispatchNotification } from '../integrations/notifications';
import {
  finalizeDebtTransferAcceptance,
  rejectOrCancelDebtTransfer,
} from './debt.service';

async function findValidPortalToken(rawToken: string) {
  const tokenRecord = await prisma.customerPortalToken.findUnique({
    where: { token: rawToken },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          accountNumber: true,
          phone: true,
          status: true,
        },
      },
    },
  });

  if (!tokenRecord || tokenRecord.revokedAt !== null || tokenRecord.expiresAt.getTime() < Date.now()) {
    throw new UnauthorizedError('This customer portal link is invalid, expired, or has been revoked');
  }

  return tokenRecord;
}

export async function getPortalChallenge(rawToken: string) {
  const tokenRecord = await findValidPortalToken(rawToken);
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });

  return {
    valid: true,
    storeName: settings?.storeName || 'Zamora Liquor Store',
    customerFirstName: tokenRecord.customer.fullName.split(' ')[0],
    accountNumber: tokenRecord.customer.accountNumber,
    maskedPhone: maskPhone(tokenRecord.customer.phone),
    mpesaEnabled: settings?.mpesaEnabled ?? true,
    requireOtp: settings?.portalRequireOtp ?? false,
  };
}

export async function openPortalDirect(rawToken: string) {
  const tokenRecord = await findValidPortalToken(rawToken);
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  if (settings?.portalRequireOtp) {
    throw new ValidationError('OTP verification is required to open this portal');
  }

  await prisma.customerPortalToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() },
  });

  const sessionToken = signPortalJwt({
    sub: tokenRecord.customerId,
    portalTokenId: tokenRecord.id,
    accountNumber: tokenRecord.customer.accountNumber,
  });

  return {
    requiresOtp: false,
    sessionToken,
    customer: {
      fullName: tokenRecord.customer.fullName,
      accountNumber: tokenRecord.customer.accountNumber,
    },
  };
}

export async function requestPortalOtp(rawToken: string) {
  const tokenRecord = await findValidPortalToken(rawToken);
  const rawOtp = generateNumericOtp(6);
  const otpHash = hashToken(rawOtp);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const challenge = await prisma.portalOtpChallenge.create({
    data: {
      portalTokenId: tokenRecord.id,
      customerId: tokenRecord.customerId,
      otpHash,
      expiresAt,
    },
  });

  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const storeName = settings?.storeName || 'Zamora Liquor Store';

  await dispatchNotification({
    customerId: tokenRecord.customerId,
    channel: 'SMS',
    recipient: tokenRecord.customer.phone,
    eventType: 'PORTAL_OTP',
    subject: 'Portal Verification Code',
    message: `${storeName}: Your one-time verification code to view your account statement is ${rawOtp}. Valid for 10 minutes.`,
  });

  return {
    challengeId: challenge.id,
    maskedPhone: maskPhone(tokenRecord.customer.phone),
    expiresInMinutes: 10,
    ...(env.exposeDevOtp ? { devOtp: rawOtp } : {}),
  };
}

export async function verifyPortalOtp(rawToken: string, otp: string) {
  const tokenRecord = await findValidPortalToken(rawToken);

  const challenge = await prisma.portalOtpChallenge.findFirst({
    where: {
      portalTokenId: tokenRecord.id,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!challenge) {
    throw new ValidationError('No active verification code found. Please request a new OTP.');
  }

  if (challenge.attempts >= 5) {
    throw new ValidationError('Too many incorrect OTP attempts. Please request a new OTP.');
  }

  const matches = hashToken(otp.trim()) === challenge.otpHash;
  if (!matches) {
    await prisma.portalOtpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    throw new ValidationError('Incorrect OTP code');
  }

  await prisma.$transaction([
    prisma.portalOtpChallenge.update({
      where: { id: challenge.id },
      data: { verifiedAt: new Date() },
    }),
    prisma.customerPortalToken.update({
      where: { id: tokenRecord.id },
      data: { lastUsedAt: new Date() },
    }),
  ]);

  const sessionToken = signPortalJwt({
    sub: tokenRecord.customerId,
    portalTokenId: tokenRecord.id,
    accountNumber: tokenRecord.customer.accountNumber,
  });

  return {
    sessionToken,
    customer: {
      fullName: tokenRecord.customer.fullName,
      accountNumber: tokenRecord.customer.accountNumber,
    },
  };
}

/**
 * Strictly customer-scoped portal dashboard.
 * NEVER selects or exposes owner purchase prices, costs, margins, profits, or internal notes.
 */
export async function getCustomerPortalDashboard(
  customerId: string,
  filters?: { startDate?: string; endDate?: string }
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      accountNumber: true,
      fullName: true,
      phone: true,
      email: true,
      registeredAt: true,
      account: {
        select: {
          currentBalance: true,
          totalPurchases: true,
          totalPayments: true,
          totalTransferredIn: true,
          totalTransferredOut: true,
          lastTransactionAt: true,
        },
      },
    },
  });

  if (!customer) throw new NotFoundError('Customer account not found');

  const settings = await prisma.setting.findUnique({
    where: { key: 'default' },
    select: {
      storeName: true,
      storePhone: true,
      storeAddress: true,
      currency: true,
      receiptFooter: true,
      mpesaEnabled: true,
      mpesaPaybillOrTill: true,
      mpesaAccountReference: true,
    },
  });

  const dateFilter =
    filters?.startDate || filters?.endDate
      ? {
          createdAt: {
            ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
            ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
          },
        }
      : {};

  const transactions = await prisma.debtTransaction.findMany({
    where: {
      customerId,
      ...dateFilter,
    },
    select: {
      id: true,
      referenceNumber: true,
      transactionType: true,
      direction: true,
      amount: true,
      runningBalance: true,
      description: true,
      reason: true,
      isReversed: true,
      createdAt: true,
      sale: {
        select: {
          id: true,
          receiptNumber: true,
          soldAt: true,
          subtotal: true,
          discountAmount: true,
          totalAmount: true,
          cashAmount: true,
          mpesaAmount: true,
          amountPaid: true,
          outstandingAmount: true,
          paymentMethod: true,
          notes: true,
          items: {
            select: {
              id: true,
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
        select: {
          id: true,
          referenceNumber: true,
          method: true,
          mpesaReference: true,
          paidAt: true,
        },
      },
      debtTransfer: {
        select: {
          id: true,
          referenceNumber: true,
          reason: true,
          fromCustomer: { select: { fullName: true, accountNumber: true } },
          toCustomer: { select: { fullName: true, accountNumber: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const pendingIncomingTransfers = await prisma.debtTransfer.findMany({
    where: {
      toCustomerId: customerId,
      status: 'PENDING_ACCEPTANCE',
      otpExpiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      referenceNumber: true,
      amount: true,
      reason: true,
      createdAt: true,
      otpExpiresAt: true,
      fromCustomer: { select: { fullName: true, accountNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const clarificationRequests = await prisma.clarificationRequest.findMany({
    where: { customerId },
    select: {
      id: true,
      debtTransactionId: true,
      saleId: true,
      message: true,
      status: true,
      ownerResponse: true,
      resolvedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    store: {
      storeName: settings?.storeName || 'Zamora Liquor Store',
      storePhone: settings?.storePhone || '',
      storeAddress: settings?.storeAddress || '',
      currency: settings?.currency || 'KSh',
      receiptFooter: settings?.receiptFooter || '',
      mpesaEnabled: settings?.mpesaEnabled ?? true,
      mpesaPaybillOrTill: settings?.mpesaPaybillOrTill || null,
      mpesaAccountReference: settings?.mpesaAccountReference || null,
    },
    customer: {
      accountNumber: customer.accountNumber,
      fullName: customer.fullName,
      phone: customer.phone,
      email: customer.email,
      registeredAt: customer.registeredAt,
    },
    summary: {
      currentBalance: toNumber(customer.account?.currentBalance ?? 0),
      totalPurchases: toNumber(customer.account?.totalPurchases ?? 0),
      totalPayments: toNumber(customer.account?.totalPayments ?? 0),
      totalTransferredIn: toNumber(customer.account?.totalTransferredIn ?? 0),
      totalTransferredOut: toNumber(customer.account?.totalTransferredOut ?? 0),
      lastTransactionAt: customer.account?.lastTransactionAt ?? null,
    },
    pendingIncomingTransfers: pendingIncomingTransfers.map((t) => ({
      ...t,
      amount: toNumber(t.amount),
    })),
    clarificationRequests,
    transactions: transactions.map((t) => ({
      id: t.id,
      referenceNumber: t.referenceNumber,
      transactionType: t.transactionType,
      direction: t.direction,
      amount: toNumber(t.amount),
      runningBalance: toNumber(t.runningBalance),
      description: t.description,
      reason: t.reason,
      isReversed: t.isReversed,
      createdAt: t.createdAt,
      sale: t.sale
        ? {
            id: t.sale.id,
            receiptNumber: t.sale.receiptNumber,
            soldAt: t.sale.soldAt,
            subtotal: toNumber(t.sale.subtotal),
            discountAmount: toNumber(t.sale.discountAmount),
            totalAmount: toNumber(t.sale.totalAmount),
            cashAmount: toNumber(t.sale.cashAmount),
            mpesaAmount: toNumber(t.sale.mpesaAmount),
            amountPaid: toNumber(t.sale.amountPaid),
            outstandingAmount: toNumber(t.sale.outstandingAmount),
            paymentMethod: t.sale.paymentMethod,
            notes: t.sale.notes,
            items: t.sale.items.map((i) => ({
              id: i.id,
              productName: i.productName,
              brand: i.brand,
              bottleSize: i.bottleSize,
              quantity: i.quantity,
              unitSellingPrice: toNumber(i.unitSellingPrice),
              lineTotal: toNumber(i.lineTotal),
            })),
          }
        : null,
      payment: t.payment,
      debtTransfer: t.debtTransfer,
    })),
  };
}

export async function getCustomerPortalSaleReceipt(customerId: string, saleId: string) {
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: {
      id: true,
      customerId: true,
      receiptNumber: true,
      soldAt: true,
      subtotal: true,
      discountAmount: true,
      totalAmount: true,
      cashAmount: true,
      mpesaAmount: true,
      mpesaReference: true,
      amountPaid: true,
      outstandingAmount: true,
      paymentMethod: true,
      notes: true,
      customer: {
        select: { fullName: true, accountNumber: true, phone: true },
      },
      items: {
        select: {
          id: true,
          productName: true,
          brand: true,
          bottleSize: true,
          quantity: true,
          unitSellingPrice: true,
          lineTotal: true,
        },
      },
    },
  });

  if (!sale) throw new NotFoundError('Receipt not found');
  if (sale.customerId !== customerId) {
    throw new ForbiddenError('You can only view your own receipts');
  }

  return {
    id: sale.id,
    receiptNumber: sale.receiptNumber,
    soldAt: sale.soldAt,
    paymentMethod: sale.paymentMethod,
    mpesaReference: sale.mpesaReference,
    subtotal: toNumber(sale.subtotal),
    discountAmount: toNumber(sale.discountAmount),
    totalAmount: toNumber(sale.totalAmount),
    cashAmount: toNumber(sale.cashAmount),
    mpesaAmount: toNumber(sale.mpesaAmount),
    amountPaid: toNumber(sale.amountPaid),
    outstandingAmount: toNumber(sale.outstandingAmount),
    notes: sale.notes,
    customer: sale.customer,
    items: sale.items.map((i) => ({
      id: i.id,
      productName: i.productName,
      brand: i.brand,
      bottleSize: i.bottleSize,
      quantity: i.quantity,
      unitSellingPrice: toNumber(i.unitSellingPrice),
      lineTotal: toNumber(i.lineTotal),
    })),
  };
}

export async function submitClarificationRequest(
  customerId: string,
  input: { debtTransactionId?: string; saleId?: string; message: string }
) {
  if (!input.message?.trim()) {
    throw new ValidationError('Please describe what needs clarification');
  }

  if (input.debtTransactionId) {
    const txRow = await prisma.debtTransaction.findUnique({
      where: { id: input.debtTransactionId },
      select: { customerId: true },
    });
    if (!txRow || txRow.customerId !== customerId) {
      throw new ForbiddenError('Transaction does not belong to your account');
    }
  }

  if (input.saleId) {
    const saleRow = await prisma.sale.findUnique({
      where: { id: input.saleId },
      select: { customerId: true },
    });
    if (!saleRow || saleRow.customerId !== customerId) {
      throw new ForbiddenError('Sale does not belong to your account');
    }
  }

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });

  const request = await prisma.clarificationRequest.create({
    data: {
      customerId,
      debtTransactionId: input.debtTransactionId || null,
      saleId: input.saleId || null,
      message: input.message.trim(),
    },
  });

  await dispatchNotification({
    customerId,
    channel: 'IN_APP',
    recipient: 'OWNER',
    eventType: 'CLARIFICATION_REQUEST',
    subject: `Clarification Request from ${customer.fullName} (${customer.accountNumber})`,
    message: input.message.trim(),
  });

  return request;
}

export async function respondToTransferInPortal(
  customerId: string,
  transferId: string,
  action: 'ACCEPT' | 'REJECT',
  ipAddress?: string
) {
  const transfer = await prisma.debtTransfer.findUnique({ where: { id: transferId } });
  if (!transfer || transfer.toCustomerId !== customerId) {
    throw new ForbiddenError('You are not authorized to respond to this debt transfer');
  }

  if (action === 'ACCEPT') {
    return finalizeDebtTransferAcceptance({
      transferId,
      bypassOtpForPortalCustomerId: customerId,
      acceptedMethod: 'PORTAL',
      ipAddress,
    });
  }

  return rejectOrCancelDebtTransfer({
    transferId,
    action: 'REJECTED',
    actorCustomerId: customerId,
  });
}

export async function getPublicTransferConfirmationInfo(rawToken: string) {
  const transfer = await prisma.debtTransfer.findUnique({
    where: { confirmationTokenHash: hashToken(rawToken) },
    select: {
      id: true,
      referenceNumber: true,
      amount: true,
      reason: true,
      status: true,
      otpExpiresAt: true,
      createdAt: true,
      fromCustomer: { select: { fullName: true, accountNumber: true } },
      toCustomer: { select: { fullName: true, accountNumber: true, phone: true } },
    },
  });

  if (!transfer) {
    throw new NotFoundError('Debt transfer confirmation link not found');
  }

  return {
    id: transfer.id,
    referenceNumber: transfer.referenceNumber,
    amount: toNumber(transfer.amount),
    reason: transfer.reason,
    status: transfer.status,
    expired: transfer.otpExpiresAt.getTime() < Date.now(),
    createdAt: transfer.createdAt,
    fromCustomer: transfer.fromCustomer,
    toCustomer: {
      fullName: transfer.toCustomer.fullName,
      accountNumber: transfer.toCustomer.accountNumber,
      maskedPhone: maskPhone(transfer.toCustomer.phone),
    },
  };
}

export async function respondToTransferByPublicToken(
  rawToken: string,
  action: 'ACCEPT' | 'REJECT',
  otp?: string,
  ipAddress?: string
) {
  if (action === 'ACCEPT') {
    return finalizeDebtTransferAcceptance({
      confirmationToken: rawToken,
      otp,
      acceptedMethod: 'CONFIRMATION_LINK',
      ipAddress,
    });
  }

  const transfer = await prisma.debtTransfer.findUnique({
    where: { confirmationTokenHash: hashToken(rawToken) },
  });
  if (!transfer) throw new NotFoundError('Transfer request not found');

  if (!otp?.trim() || hashToken(otp.trim()) !== transfer.otpHash) {
    throw new ValidationError('Valid OTP confirmation is required to decline this transfer');
  }

  return rejectOrCancelDebtTransfer({
    confirmationToken: rawToken,
    action: 'REJECTED',
    actorCustomerId: transfer.toCustomerId,
  });
}

