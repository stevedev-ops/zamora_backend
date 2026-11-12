import { Prisma } from '@prisma/client';
import { ValidationError } from '../lib/errors';
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

const CORE_BACKUP_TABLES = ['categories', 'products', 'customers', 'sales'] as const;

const ALL_BACKUP_TABLES = [
  'settings',
  'sequenceCounters',
  'categories',
  'suppliers',
  'products',
  'supplierPurchases',
  'supplierPurchaseItems',
  'inventoryBatches',
  'inventoryMovements',
  'customers',
  'customerAccounts',
  'creditLimits',
  'sales',
  'saleShares',
  'saleItems',
  'saleItemBatchAllocations',
  'payments',
  'debtTransfers',
  'debtTransactions',
  'expenses',
  'clarificationRequests',
  'mpesaTransactions',
  'notifications',
  'customerPortalTokens',
] as const;

type BackupTableName = (typeof ALL_BACKUP_TABLES)[number];
type BackupRow = Record<string, unknown>;

export interface NormalizedBackupSnapshot {
  version: string;
  exportedAt: string | null;
  data: Record<BackupTableName, BackupRow[]>;
  counts: {
    settings: number;
    sequenceCounters: number;
    categories: number;
    suppliers: number;
    products: number;
    supplierPurchases: number;
    supplierPurchaseItems: number;
    inventoryBatches: number;
    inventoryMovements: number;
    customers: number;
    customerAccounts: number;
    creditLimits: number;
    sales: number;
    saleShares: number;
    saleItems: number;
    saleItemBatchAllocations: number;
    payments: number;
    debtTransfers: number;
    debtTransactions: number;
    expenses: number;
    clarificationRequests: number;
    mpesaTransactions: number;
    notifications: number;
    customerPortalTokens: number;
    totalRecords: number;
  };
}

function isPlainRecord(value: unknown): value is BackupRow {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`Invalid timestamp in backup data: ${String(value)}`);
  }
  return parsed;
}

function asOptionalDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return asDate(value);
}

function remapRequiredUserId(
  value: unknown,
  validUserIds: Set<string>,
  fallbackUserId: string
): string {
  return typeof value === 'string' && validUserIds.has(value) ? value : fallbackUserId;
}

function remapOptionalUserId(
  value: unknown,
  validUserIds: Set<string>,
  fallbackUserId: string
): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && validUserIds.has(value) ? value : fallbackUserId;
}

/**
 * Validates an uploaded JSON backup payload and returns normalized table arrays plus counts.
 */
export function validateAndSummarizeBackupPayload(raw: unknown): NormalizedBackupSnapshot {
  if (!isPlainRecord(raw)) {
    throw new ValidationError('Invalid backup file: expected a JSON snapshot object');
  }

  const rawData = raw.data;
  if (!isPlainRecord(rawData)) {
    throw new ValidationError('Invalid backup file: missing "data" snapshot section');
  }

  for (const requiredKey of CORE_BACKUP_TABLES) {
    if (!Array.isArray(rawData[requiredKey])) {
      throw new ValidationError(
        `Invalid backup file: expected "${requiredKey}" to be a list of records`
      );
    }
  }

  const normalizedData = {} as Record<BackupTableName, BackupRow[]>;
  let totalRecords = 0;

  for (const table of ALL_BACKUP_TABLES) {
    const rawTable = rawData[table];
    if (rawTable === undefined) {
      normalizedData[table] = [];
      continue;
    }
    if (!Array.isArray(rawTable)) {
      throw new ValidationError(`Invalid backup file: "${table}" must be an array when present`);
    }
    for (let i = 0; i < rawTable.length; i += 1) {
      if (!isPlainRecord(rawTable[i])) {
        throw new ValidationError(
          `Invalid backup file: "${table}[${i}]" must be a JSON object`
        );
      }
    }
    normalizedData[table] = rawTable;
    totalRecords += rawTable.length;
  }

  return {
    version: typeof raw.version === 'string' ? raw.version : '1.0',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    data: normalizedData,
    counts: {
      settings: normalizedData.settings.length,
      sequenceCounters: normalizedData.sequenceCounters.length,
      categories: normalizedData.categories.length,
      suppliers: normalizedData.suppliers.length,
      products: normalizedData.products.length,
      supplierPurchases: normalizedData.supplierPurchases.length,
      supplierPurchaseItems: normalizedData.supplierPurchaseItems.length,
      inventoryBatches: normalizedData.inventoryBatches.length,
      inventoryMovements: normalizedData.inventoryMovements.length,
      customers: normalizedData.customers.length,
      customerAccounts: normalizedData.customerAccounts.length,
      creditLimits: normalizedData.creditLimits.length,
      sales: normalizedData.sales.length,
      saleShares: normalizedData.saleShares.length,
      saleItems: normalizedData.saleItems.length,
      saleItemBatchAllocations: normalizedData.saleItemBatchAllocations.length,
      payments: normalizedData.payments.length,
      debtTransfers: normalizedData.debtTransfers.length,
      debtTransactions: normalizedData.debtTransactions.length,
      expenses: normalizedData.expenses.length,
      clarificationRequests: normalizedData.clarificationRequests.length,
      mpesaTransactions: normalizedData.mpesaTransactions.length,
      notifications: normalizedData.notifications.length,
      customerPortalTokens: normalizedData.customerPortalTokens.length,
      totalRecords,
    },
  };
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
    saleShares,
    saleItems,
    saleItemBatchAllocations,
    payments,
    debtTransfers,
    debtTransactions,
    expenses,
    settings,
    sequenceCounters,
    clarificationRequests,
    mpesaTransactions,
    notifications,
    customerPortalTokens,
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
    prisma.saleShare.findMany(),
    prisma.saleItem.findMany(),
    prisma.saleItemBatchAllocation.findMany(),
    prisma.payment.findMany(),
    prisma.debtTransfer.findMany(),
    prisma.debtTransaction.findMany(),
    prisma.expense.findMany(),
    prisma.setting.findMany(),
    prisma.sequenceCounter.findMany(),
    prisma.clarificationRequest.findMany(),
    prisma.mpesaTransaction.findMany(),
    prisma.notification.findMany(),
    prisma.customerPortalToken.findMany(),
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
    version: '1.1',
    data: {
      settings,
      sequenceCounters,
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
      saleShares,
      saleItems,
      saleItemBatchAllocations,
      payments,
      debtTransfers,
      debtTransactions,
      expenses,
      clarificationRequests,
      mpesaTransactions,
      notifications,
      customerPortalTokens,
    },
  };
}

/**
 * Atomically replaces operational shop data from a JSON backup snapshot while preserving owner accounts and audit logs.
 */
export async function restoreDatabaseSnapshot(
  rawPayload: unknown,
  actingUserId: string,
  ipAddress?: string
) {
  const snapshot = validateAndSummarizeBackupPayload(rawPayload);
  const { data, counts } = snapshot;

  await prisma.$transaction(
    async (tx) => {
      const existingUsers = await tx.user.findMany({ select: { id: true } });
      const validUserIds = new Set(existingUsers.map((u) => u.id));

      // Clear child tables first and break self-referencing reversal FKs before deletion.
      await tx.portalOtpChallenge.deleteMany();
      await tx.clarificationRequest.deleteMany();
      await tx.mpesaTransaction.deleteMany();
      await tx.notification.deleteMany();
      await tx.customerPortalToken.deleteMany();
      await tx.debtTransaction.updateMany({ data: { reversedTransactionId: null } });
      await tx.debtTransaction.deleteMany();
      await tx.debtTransfer.deleteMany();
      await tx.payment.deleteMany();
      await tx.saleItemBatchAllocation.deleteMany();
      await tx.saleItem.deleteMany();
      await tx.saleShare.deleteMany();
      await tx.sale.deleteMany();
      await tx.creditLimit.deleteMany();
      await tx.customerAccount.deleteMany();
      await tx.customer.deleteMany();
      await tx.inventoryMovement.deleteMany();
      await tx.inventoryBatch.deleteMany();
      await tx.supplierPurchaseItem.deleteMany();
      await tx.supplierPurchase.deleteMany();
      await tx.product.deleteMany();
      await tx.supplier.deleteMany();
      await tx.category.deleteMany();
      await tx.expense.deleteMany();
      await tx.sequenceCounter.deleteMany();
      await tx.setting.deleteMany();

      if (data.settings.length > 0) {
        await tx.setting.createMany({
          data: data.settings.map((r) => ({
            ...(r as unknown as Prisma.SettingCreateManyInput),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.sequenceCounters.length > 0) {
        await tx.sequenceCounter.createMany({
          data: data.sequenceCounters.map((r) => ({
            ...(r as unknown as Prisma.SequenceCounterCreateManyInput),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.categories.length > 0) {
        await tx.category.createMany({
          data: data.categories.map((r) => ({
            ...(r as unknown as Prisma.CategoryCreateManyInput),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.suppliers.length > 0) {
        await tx.supplier.createMany({
          data: data.suppliers.map((r) => ({
            ...(r as unknown as Prisma.SupplierCreateManyInput),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.products.length > 0) {
        await tx.product.createMany({
          data: data.products.map((r) => ({
            ...(r as unknown as Prisma.ProductCreateManyInput),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.supplierPurchases.length > 0) {
        await tx.supplierPurchase.createMany({
          data: data.supplierPurchases.map((r) => ({
            ...(r as unknown as Prisma.SupplierPurchaseCreateManyInput),
            purchaseDate: asOptionalDate(r.purchaseDate) ?? new Date(),
            createdByUserId: remapRequiredUserId(
              r.createdByUserId,
              validUserIds,
              actingUserId
            ),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.supplierPurchaseItems.length > 0) {
        await tx.supplierPurchaseItem.createMany({
          data: data.supplierPurchaseItems.map((r) => ({
            ...(r as unknown as Prisma.SupplierPurchaseItemCreateManyInput),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.inventoryBatches.length > 0) {
        await tx.inventoryBatch.createMany({
          data: data.inventoryBatches.map((r) => ({
            ...(r as unknown as Prisma.InventoryBatchCreateManyInput),
            purchaseDate: asOptionalDate(r.purchaseDate) ?? new Date(),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.inventoryMovements.length > 0) {
        await tx.inventoryMovement.createMany({
          data: data.inventoryMovements.map((r) => ({
            ...(r as unknown as Prisma.InventoryMovementCreateManyInput),
            createdByUserId: remapOptionalUserId(
              r.createdByUserId,
              validUserIds,
              actingUserId
            ),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.customers.length > 0) {
        await tx.customer.createMany({
          data: data.customers.map((r) => ({
            ...(r as unknown as Prisma.CustomerCreateManyInput),
            registeredAt: asOptionalDate(r.registeredAt) ?? new Date(),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.customerAccounts.length > 0) {
        await tx.customerAccount.createMany({
          data: data.customerAccounts.map((r) => ({
            ...(r as unknown as Prisma.CustomerAccountCreateManyInput),
            lastTransactionAt: asOptionalDate(r.lastTransactionAt),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.creditLimits.length > 0) {
        await tx.creditLimit.createMany({
          data: data.creditLimits.map((r) => ({
            ...(r as unknown as Prisma.CreditLimitCreateManyInput),
            setByUserId: remapRequiredUserId(r.setByUserId, validUserIds, actingUserId),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.sales.length > 0) {
        await tx.sale.createMany({
          data: data.sales.map((r) => ({
            ...(r as unknown as Prisma.SaleCreateManyInput),
            createdByUserId: remapRequiredUserId(
              r.createdByUserId,
              validUserIds,
              actingUserId
            ),
            soldAt: asOptionalDate(r.soldAt) ?? new Date(),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.saleShares.length > 0) {
        await tx.saleShare.createMany({
          data: data.saleShares.map((r) => ({
            ...(r as unknown as Prisma.SaleShareCreateManyInput),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.saleItems.length > 0) {
        await tx.saleItem.createMany({
          data: data.saleItems.map((r) => ({
            ...(r as unknown as Prisma.SaleItemCreateManyInput),
            flaggedAt: asOptionalDate(r.flaggedAt),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.saleItemBatchAllocations.length > 0) {
        await tx.saleItemBatchAllocation.createMany({
          data: data.saleItemBatchAllocations.map(
            (r) => r as unknown as Prisma.SaleItemBatchAllocationCreateManyInput
          ),
        });
      }

      if (data.payments.length > 0) {
        await tx.payment.createMany({
          data: data.payments.map((r) => ({
            ...(r as unknown as Prisma.PaymentCreateManyInput),
            receivedByUserId: remapOptionalUserId(
              r.receivedByUserId,
              validUserIds,
              actingUserId
            ),
            paidAt: asOptionalDate(r.paidAt) ?? new Date(),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.debtTransfers.length > 0) {
        await tx.debtTransfer.createMany({
          data: data.debtTransfers.map((r) => ({
            ...(r as unknown as Prisma.DebtTransferCreateManyInput),
            otpExpiresAt: asDate(r.otpExpiresAt),
            acceptedAt: asOptionalDate(r.acceptedAt),
            rejectedAt: asOptionalDate(r.rejectedAt),
            initiatedByUserId: remapRequiredUserId(
              r.initiatedByUserId,
              validUserIds,
              actingUserId
            ),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      // Pass 1: insert ledger rows without self-referential reversedTransactionId, then link in Pass 2.
      if (data.debtTransactions.length > 0) {
        await tx.debtTransaction.createMany({
          data: data.debtTransactions.map((r) => ({
            ...(r as unknown as Prisma.DebtTransactionCreateManyInput),
            reversedTransactionId: null,
            createdByUserId: remapOptionalUserId(
              r.createdByUserId,
              validUserIds,
              actingUserId
            ),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });

        const restoredIds = new Set(
          data.debtTransactions
            .map((r) => (typeof r.id === 'string' ? r.id : null))
            .filter((id): id is string => Boolean(id))
        );

        for (const r of data.debtTransactions) {
          if (
            typeof r.id === 'string' &&
            typeof r.reversedTransactionId === 'string' &&
            restoredIds.has(r.reversedTransactionId)
          ) {
            await tx.debtTransaction.update({
              where: { id: r.id },
              data: { reversedTransactionId: r.reversedTransactionId },
            });
          }
        }
      }

      if (data.expenses.length > 0) {
        await tx.expense.createMany({
          data: data.expenses.map((r) => ({
            ...(r as unknown as Prisma.ExpenseCreateManyInput),
            expenseDate: asOptionalDate(r.expenseDate) ?? new Date(),
            createdByUserId: remapRequiredUserId(
              r.createdByUserId,
              validUserIds,
              actingUserId
            ),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.clarificationRequests.length > 0) {
        await tx.clarificationRequest.createMany({
          data: data.clarificationRequests.map((r) => ({
            ...(r as unknown as Prisma.ClarificationRequestCreateManyInput),
            resolvedAt: asOptionalDate(r.resolvedAt),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.mpesaTransactions.length > 0) {
        await tx.mpesaTransaction.createMany({
          data: data.mpesaTransactions.map((r) => ({
            ...(r as unknown as Prisma.MpesaTransactionCreateManyInput),
            rawCallback:
              r.rawCallback == null ? undefined : (r.rawCallback as Prisma.InputJsonValue),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
            updatedAt: asOptionalDate(r.updatedAt) ?? new Date(),
          })),
        });
      }

      if (data.notifications.length > 0) {
        await tx.notification.createMany({
          data: data.notifications.map((r) => ({
            ...(r as unknown as Prisma.NotificationCreateManyInput),
            sentAt: asOptionalDate(r.sentAt),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      if (data.customerPortalTokens.length > 0) {
        await tx.customerPortalToken.createMany({
          data: data.customerPortalTokens.map((r) => ({
            ...(r as unknown as Prisma.CustomerPortalTokenCreateManyInput),
            expiresAt: asDate(r.expiresAt),
            revokedAt: asOptionalDate(r.revokedAt),
            lastUsedAt: asOptionalDate(r.lastUsedAt),
            createdAt: asOptionalDate(r.createdAt) ?? new Date(),
          })),
        });
      }

      await recordAuditLog(tx, {
        actorType: 'OWNER',
        actorId: actingUserId,
        userId: actingUserId,
        action: 'DATABASE_BACKUP_RESTORED',
        entityType: 'System',
        metadata: {
          backupVersion: snapshot.version,
          backupExportedAt: snapshot.exportedAt,
          counts,
        },
        ipAddress,
      });
    },
    { timeout: 60000 }
  );

  return {
    restored: true,
    version: snapshot.version,
    exportedAt: snapshot.exportedAt,
    restoredAt: new Date().toISOString(),
    counts,
  };
}

