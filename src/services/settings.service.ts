import { prisma } from '../lib/prisma';
import { toDecimal, toNumber } from '../lib/money';
import { recordAuditLog } from '../lib/audit';
import { MpesaPaymentOptionType, normalizeMpesaType } from '../lib/mpesaDisplay';

export async function getStoreSettings() {
  let settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  if (!settings) {
    settings = await prisma.setting.create({
      data: { key: 'default' },
    });
  }
  return {
    ...settings,
    mpesaType: normalizeMpesaType(settings),
    defaultCreditLimit: toNumber(settings.defaultCreditLimit),
  };
}

export async function updateStoreSettings(
  input: {
    storeName?: string;
    storePhone?: string;
    storeEmail?: string | null;
    storeAddress?: string;
    currency?: string;
    receiptFooter?: string;
    mpesaEnabled?: boolean;
    mpesaType?: MpesaPaymentOptionType;
    mpesaPaybillOrTill?: string | null;
    mpesaAccountReference?: string | null;
    smsEnabled?: boolean;
    whatsappEnabled?: boolean;
    defaultCreditLimit?: number;
    lowStockDefaultAlert?: number;
    overdueDaysThreshold?: number;
    portalRequireOtp?: boolean;
  },
  userId: string,
  ipAddress?: string
) {
  await getStoreSettings();
  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.setting.update({
      where: { key: 'default' },
      data: {
        ...(input.storeName !== undefined ? { storeName: input.storeName.trim() } : {}),
        ...(input.storePhone !== undefined ? { storePhone: input.storePhone.trim() } : {}),
        ...(input.storeEmail !== undefined ? { storeEmail: input.storeEmail?.trim() || null } : {}),
        ...(input.storeAddress !== undefined ? { storeAddress: input.storeAddress.trim() } : {}),
        ...(input.currency !== undefined ? { currency: input.currency.trim() } : {}),
        ...(input.receiptFooter !== undefined ? { receiptFooter: input.receiptFooter.trim() } : {}),
        ...(input.mpesaEnabled !== undefined ? { mpesaEnabled: input.mpesaEnabled } : {}),
        ...(input.mpesaType !== undefined ? { mpesaType: input.mpesaType } : {}),
        ...(input.mpesaPaybillOrTill !== undefined
          ? { mpesaPaybillOrTill: input.mpesaPaybillOrTill?.trim() || null }
          : {}),
        ...(input.mpesaAccountReference !== undefined
          ? { mpesaAccountReference: input.mpesaAccountReference?.trim() || null }
          : {}),
        ...(input.smsEnabled !== undefined ? { smsEnabled: input.smsEnabled } : {}),
        ...(input.whatsappEnabled !== undefined ? { whatsappEnabled: input.whatsappEnabled } : {}),
        ...(input.defaultCreditLimit !== undefined
          ? { defaultCreditLimit: toDecimal(input.defaultCreditLimit).toFixed(2) }
          : {}),
        ...(input.lowStockDefaultAlert !== undefined
          ? { lowStockDefaultAlert: input.lowStockDefaultAlert }
          : {}),
        ...(input.overdueDaysThreshold !== undefined
          ? { overdueDaysThreshold: input.overdueDaysThreshold }
          : {}),
        ...(input.portalRequireOtp !== undefined
          ? { portalRequireOtp: input.portalRequireOtp }
          : {}),
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SETTINGS_UPDATED',
      entityType: 'Setting',
      entityId: s.id,
      ipAddress,
    });
    return s;
  });

  return {
    ...updated,
    mpesaType: normalizeMpesaType(updated),
    defaultCreditLimit: toNumber(updated.defaultCreditLimit),
  };
}

export async function listAuditLogs(limit = 100) {
  return prisma.auditLog.findMany({
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function listNotifications(limit = 100) {
  return prisma.notification.findMany({
    include: {
      customer: { select: { id: true, fullName: true, accountNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function markNotificationRead(id: string) {
  return prisma.notification.update({
    where: { id },
    data: { isRead: true },
  });
}

export async function exportDatabaseSnapshot(userId: string) {
  const [
    categories,
    suppliers,
    products,
    supplierPurchases,
    supplierPurchaseItems,
    inventoryBatches,
    inventoryMovements,
    customers,
    customerAccounts,
    creditLimits,
    sales,
    saleItems,
    payments,
    debtTransfers,
    debtTransactions,
    expenses,
    settings,
  ] = await Promise.all([
    prisma.category.findMany(),
    prisma.supplier.findMany(),
    prisma.product.findMany(),
    prisma.supplierPurchase.findMany(),
    prisma.supplierPurchaseItem.findMany(),
    prisma.inventoryBatch.findMany(),
    prisma.inventoryMovement.findMany(),
    prisma.customer.findMany(),
    prisma.customerAccount.findMany(),
    prisma.creditLimit.findMany(),
    prisma.sale.findMany(),
    prisma.saleItem.findMany(),
    prisma.payment.findMany(),
    prisma.debtTransfer.findMany(),
    prisma.debtTransaction.findMany(),
    prisma.expense.findMany(),
    prisma.setting.findMany(),
  ]);

  await prisma.auditLog.create({
    data: {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'DATABASE_BACKUP_EXPORTED',
      entityType: 'System',
    },
  });

  return {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    data: {
      settings,
      categories,
      suppliers,
      products,
      supplierPurchases,
      supplierPurchaseItems,
      inventoryBatches,
      inventoryMovements,
      customers,
      customerAccounts,
      creditLimits,
      sales,
      saleItems,
      payments,
      debtTransfers,
      debtTransactions,
      expenses,
    },
  };
}

