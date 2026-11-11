import { prisma } from '../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';

function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function listCategories() {
  const categories = await prisma.category.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { products: true } } },
  });
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    isDefault: c.isDefault,
    productCount: c._count.products,
    createdAt: c.createdAt,
  }));
}

export async function createCategory(
  input: { name: string; description?: string },
  userId: string,
  ipAddress?: string
) {
  const name = input.name.trim();
  const slug = toSlug(name);
  if (!slug) throw new ValidationError('Invalid category name');

  const existing = await prisma.category.findFirst({
    where: { OR: [{ name: { equals: name, mode: 'insensitive' } }, { slug }] },
  });
  if (existing) {
    throw new ConflictError(`Category "${name}" already exists`);
  }

  return prisma.$transaction(async (tx) => {
    const category = await tx.category.create({
      data: { name, slug, description: input.description?.trim(), isDefault: false },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CATEGORY_CREATED',
      entityType: 'Category',
      entityId: category.id,
      metadata: { name },
      ipAddress,
    });
    return category;
  });
}

export async function updateCategory(
  id: string,
  input: { name?: string; description?: string },
  userId: string
) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw new NotFoundError('Category not found');

  const name = input.name?.trim() || category.name;
  const slug = toSlug(name);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.category.update({
      where: { id },
      data: {
        name,
        slug,
        description: input.description !== undefined ? input.description.trim() : category.description,
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CATEGORY_UPDATED',
      entityType: 'Category',
      entityId: id,
      metadata: { name },
    });
    return updated;
  });
}

export async function deleteCategory(id: string, userId: string) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  });
  if (!category) throw new NotFoundError('Category not found');
  if (category._count.products > 0) {
    throw new ValidationError('Cannot delete a category that still has products assigned');
  }

  await prisma.$transaction(async (tx) => {
    await tx.category.delete({ where: { id } });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'CATEGORY_DELETED',
      entityType: 'Category',
      entityId: id,
      metadata: { name: category.name },
    });
  });

  return { deleted: true };
}

