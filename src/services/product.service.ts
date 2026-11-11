import { ProductStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  calculateMarginPercent,
  calculateMarkupPercent,
  subMoney,
  toDecimal,
  toNumber,
} from '../lib/money';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { addStockBatchTx } from './inventory.service';

function formatProduct(p: {
  id: string;
  name: string;
  brand: string;
  categoryId: string;
  supplierId: string | null;
  imageUrl: string | null;
  barcode: string | null;
  bottleSize: string;
  purchasePrice: unknown;
  sellingPrice: unknown;
  currentStock: number;
  minStockAlert: number;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slug: string };
  supplier?: { id: string; name: string } | null;
}) {
  const purchasePrice = toNumber(p.purchasePrice as number | string);
  const sellingPrice = toNumber(p.sellingPrice as number | string);
  const profitPerUnit = subMoney(sellingPrice, purchasePrice).toNumber();
  const profitMarginPercent = calculateMarginPercent(profitPerUnit, sellingPrice);
  const markupPercent = calculateMarkupPercent(profitPerUnit, purchasePrice);

  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    categoryId: p.categoryId,
    category: p.category ?? null,
    supplierId: p.supplierId,
    supplier: p.supplier ?? null,
    imageUrl: p.imageUrl,
    barcode: p.barcode,
    bottleSize: p.bottleSize,
    purchasePrice,
    sellingPrice,
    profitPerUnit,
    profitMarginPercent,
    markupPercent,
    currentStock: p.currentStock,
    minStockAlert: p.minStockAlert,
    isLowStock: p.currentStock <= p.minStockAlert,
    potentialSalesValue: Number((sellingPrice * p.currentStock).toFixed(2)),
    potentialGrossProfit: Number((profitPerUnit * p.currentStock).toFixed(2)),
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listProducts(params?: {
  search?: string;
  categoryId?: string;
  status?: ProductStatus;
  lowStockOnly?: boolean;
}) {
  const search = params?.search?.trim();
  const products = await prisma.product.findMany({
    where: {
      ...(params?.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params?.status ? { status: params.status } : {}),
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
      category: { select: { id: true, name: true, slug: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  });

  const formatted = products.map(formatProduct);
  return params?.lowStockOnly ? formatted.filter((p) => p.isLowStock) : formatted;
}

export async function getProductDetail(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true, slug: true } },
      supplier: { select: { id: true, name: true } },
      inventoryBatches: {
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        take: 30,
        include: { supplier: { select: { id: true, name: true } } },
      },
      inventoryMovements: {
        orderBy: { createdAt: 'desc' },
        take: 30,
      },
    },
  });

  if (!product) throw new NotFoundError('Product not found');

  return {
    ...formatProduct(product),
    inventoryBatches: product.inventoryBatches.map((b) => ({
      ...b,
      unitCostPrice: toNumber(b.unitCostPrice),
      totalCost: toNumber(b.totalCost),
    })),
    inventoryMovements: product.inventoryMovements.map((m) => ({
      ...m,
      unitCostPrice: toNumber(m.unitCostPrice),
      totalCostValue: toNumber(m.totalCostValue),
    })),
  };
}

export async function createProduct(
  input: {
    name: string;
    brand: string;
    categoryId: string;
    supplierId?: string | null;
    imageUrl?: string | null;
    barcode?: string | null;
    bottleSize: string;
    purchasePrice: number;
    sellingPrice: number;
    initialStock?: number;
    minStockAlert?: number;
    status?: ProductStatus;
  },
  userId: string,
  ipAddress?: string
) {
  const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
  if (!category) throw new NotFoundError('Category not found');

  if (input.supplierId) {
    const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundError('Supplier not found');
  }

  const barcode = input.barcode?.trim() || null;
  if (barcode) {
    const dup = await prisma.product.findUnique({ where: { barcode } });
    if (dup) throw new ConflictError(`Barcode "${barcode}" is already assigned to ${dup.name}`);
  }

  const purchasePrice = toDecimal(input.purchasePrice);
  const sellingPrice = toDecimal(input.sellingPrice);
  if (purchasePrice.lt(0) || sellingPrice.lte(0)) {
    throw new ValidationError('Selling price must be > 0 and purchase price >= 0');
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: input.name.trim(),
        brand: input.brand.trim(),
        categoryId: input.categoryId,
        supplierId: input.supplierId || null,
        imageUrl: input.imageUrl?.trim() || null,
        barcode,
        bottleSize: input.bottleSize.trim(),
        purchasePrice: purchasePrice.toFixed(2),
        sellingPrice: sellingPrice.toFixed(2),
        currentStock: 0,
        minStockAlert: input.minStockAlert ?? 5,
        status: input.status ?? 'ACTIVE',
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    if (input.initialStock && input.initialStock > 0) {
      await addStockBatchTx(tx, {
        productId: product.id,
        quantity: input.initialStock,
        unitCostPrice: purchasePrice,
        movementType: 'OPENING_STOCK',
        supplierId: input.supplierId || null,
        referenceType: 'OPENING_STOCK',
        reason: 'Initial opening stock',
        userId,
      });
    }

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'PRODUCT_CREATED',
      entityType: 'Product',
      entityId: product.id,
      metadata: {
        name: product.name,
        purchasePrice: purchasePrice.toNumber(),
        sellingPrice: sellingPrice.toNumber(),
        initialStock: input.initialStock ?? 0,
      },
      ipAddress,
    });

    const refreshed = await tx.product.findUniqueOrThrow({
      where: { id: product.id },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    return formatProduct(refreshed);
  });
}

export async function updateProduct(
  id: string,
  input: {
    name?: string;
    brand?: string;
    categoryId?: string;
    supplierId?: string | null;
    imageUrl?: string | null;
    barcode?: string | null;
    bottleSize?: string;
    purchasePrice?: number;
    sellingPrice?: number;
    minStockAlert?: number;
    status?: ProductStatus;
  },
  userId: string,
  ipAddress?: string
) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Product not found');

  if (input.barcode !== undefined) {
    const cleanBarcode = input.barcode?.trim() || null;
    if (cleanBarcode && cleanBarcode !== existing.barcode) {
      const dup = await prisma.product.findUnique({ where: { barcode: cleanBarcode } });
      if (dup) throw new ConflictError(`Barcode "${cleanBarcode}" already exists`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.brand !== undefined ? { brand: input.brand.trim() } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.supplierId !== undefined ? { supplierId: input.supplierId || null } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl?.trim() || null } : {}),
        ...(input.barcode !== undefined ? { barcode: input.barcode?.trim() || null } : {}),
        ...(input.bottleSize !== undefined ? { bottleSize: input.bottleSize.trim() } : {}),
        ...(input.purchasePrice !== undefined
          ? { purchasePrice: toDecimal(input.purchasePrice).toFixed(2) }
          : {}),
        ...(input.sellingPrice !== undefined
          ? { sellingPrice: toDecimal(input.sellingPrice).toFixed(2) }
          : {}),
        ...(input.minStockAlert !== undefined ? { minStockAlert: input.minStockAlert } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'PRODUCT_UPDATED',
      entityType: 'Product',
      entityId: id,
      metadata: {
        previousPurchasePrice: toNumber(existing.purchasePrice),
        newPurchasePrice: toNumber(updated.purchasePrice),
        previousSellingPrice: toNumber(existing.sellingPrice),
        newSellingPrice: toNumber(updated.sellingPrice),
        status: updated.status,
      },
      ipAddress,
    });

    return formatProduct(updated);
  });
}

