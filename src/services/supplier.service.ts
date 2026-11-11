import { SupplierStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { normalizePhone } from '../lib/phone';
import { NotFoundError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { toNumber } from '../lib/money';

export async function listSuppliers(params?: { search?: string; status?: SupplierStatus }) {
  const search = params?.search?.trim();
  const suppliers = await prisma.supplier.findMany({
    where: {
      ...(params?.status ? { status: params.status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { address: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      _count: { select: { products: true, purchases: true } },
      purchases: {
        select: { totalCost: true, purchaseDate: true },
        orderBy: { purchaseDate: 'desc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  return suppliers.map((s) => {
    const totalPurchased = s.purchases.reduce((sum, p) => sum + toNumber(p.totalCost), 0);
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      email: s.email,
      address: s.address,
      notes: s.notes,
      status: s.status,
      productCount: s._count.products,
      purchaseCount: s._count.purchases,
      totalPurchased,
      lastPurchaseDate: s.purchases[0]?.purchaseDate ?? null,
      createdAt: s.createdAt,
    };
  });
}

export async function getSupplierDetail(id: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: {
      products: {
        include: { category: true },
        orderBy: { name: 'asc' },
      },
      purchases: {
        include: {
          items: {
            include: { product: { select: { id: true, name: true, brand: true, bottleSize: true } } },
          },
        },
        orderBy: { purchaseDate: 'desc' },
      },
    },
  });

  if (!supplier) throw new NotFoundError('Supplier not found');

  // Build product price history from this supplier
  const priceHistoryMap = new Map<
    string,
    {
      productId: string;
      productName: string;
      bottleSize: string;
      history: Array<{ date: Date; referenceNumber: string; quantity: number; unitCostPrice: number }>;
    }
  >();

  for (const purchase of supplier.purchases) {
    for (const item of purchase.items) {
      const existing = priceHistoryMap.get(item.productId) ?? {
        productId: item.productId,
        productName: item.product.name,
        bottleSize: item.product.bottleSize,
        history: [],
      };
      existing.history.push({
        date: purchase.purchaseDate,
        referenceNumber: purchase.referenceNumber,
        quantity: item.quantity,
        unitCostPrice: toNumber(item.unitCostPrice),
      });
      priceHistoryMap.set(item.productId, existing);
    }
  }

  return {
    ...supplier,
    purchases: supplier.purchases.map((p) => ({
      ...p,
      totalCost: toNumber(p.totalCost),
      items: p.items.map((i) => ({
        ...i,
        unitCostPrice: toNumber(i.unitCostPrice),
        totalCost: toNumber(i.totalCost),
      })),
    })),
    products: supplier.products.map((p) => ({
      ...p,
      purchasePrice: toNumber(p.purchasePrice),
      sellingPrice: toNumber(p.sellingPrice),
    })),
    priceHistory: Array.from(priceHistoryMap.values()),
  };
}

export async function createSupplier(
  input: { name: string; phone: string; email?: string; address?: string; notes?: string },
  userId: string,
  ipAddress?: string
) {
  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: {
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SUPPLIER_CREATED',
      entityType: 'Supplier',
      entityId: supplier.id,
      metadata: { name: supplier.name },
      ipAddress,
    });
    return supplier;
  });
}

export async function updateSupplier(
  id: string,
  input: {
    name?: string;
    phone?: string;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
    status?: SupplierStatus;
  },
  userId: string,
  ipAddress?: string
) {
  const existing = await prisma.supplier.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Supplier not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.phone !== undefined ? { phone: normalizePhone(input.phone) } : {}),
        ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
        ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'SUPPLIER_UPDATED',
      entityType: 'Supplier',
      entityId: id,
      ipAddress,
    });
    return updated;
  });
}

