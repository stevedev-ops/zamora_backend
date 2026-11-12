import { ExpenseCategory, PaymentMethod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toDecimal, toNumber } from '../lib/money';
import { nextSequenceNumber } from '../lib/sequences';
import { NotFoundError, ValidationError } from '../lib/errors';
import { recordAuditLog } from '../lib/audit';
import { buildDateRangeFilter } from '../lib/dateFilter';

export async function listExpenses(params?: {
  category?: ExpenseCategory;
  startDate?: string;
  endDate?: string;
  search?: string;
}) {
  const search = params?.search?.trim();
  const expenseDateFilter = buildDateRangeFilter(params?.startDate, params?.endDate);
  const expenses = await prisma.expense.findMany({
    where: {
      ...(params?.category ? { category: params.category } : {}),
      ...(expenseDateFilter ? { expenseDate: expenseDateFilter } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { payee: { contains: search, mode: 'insensitive' } },
              { referenceNumber: { contains: search, mode: 'insensitive' } },
              { notes: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { expenseDate: 'desc' },
  });

  return expenses.map((e) => ({
    ...e,
    amount: toNumber(e.amount),
  }));
}

export async function createExpense(
  input: {
    category: ExpenseCategory;
    title: string;
    amount: number;
    expenseDate?: string;
    paymentMethod: PaymentMethod;
    payee?: string;
    notes?: string;
  },
  userId: string,
  ipAddress?: string
) {
  const amountDec = toDecimal(input.amount);
  if (amountDec.lte(0)) {
    throw new ValidationError('Expense amount must be greater than zero');
  }

  return prisma.$transaction(async (tx) => {
    const referenceNumber = await nextSequenceNumber(tx, 'expense', 'EXP', 5);
    const expense = await tx.expense.create({
      data: {
        referenceNumber,
        category: input.category,
        title: input.title.trim(),
        amount: amountDec.toFixed(2),
        expenseDate: input.expenseDate ? new Date(input.expenseDate) : new Date(),
        paymentMethod: input.paymentMethod,
        payee: input.payee?.trim() || null,
        notes: input.notes?.trim() || null,
        createdByUserId: userId,
      },
    });

    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'EXPENSE_CREATED',
      entityType: 'Expense',
      entityId: expense.id,
      metadata: { referenceNumber, category: input.category, amount: amountDec.toNumber() },
      ipAddress,
    });

    return { ...expense, amount: toNumber(expense.amount) };
  });
}

export async function updateExpense(
  id: string,
  input: {
    category?: ExpenseCategory;
    title?: string;
    amount?: number;
    expenseDate?: string;
    paymentMethod?: PaymentMethod;
    payee?: string | null;
    notes?: string | null;
  },
  userId: string
) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Expense not found');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.expense.update({
      where: { id },
      data: {
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.amount !== undefined ? { amount: toDecimal(input.amount).toFixed(2) } : {}),
        ...(input.expenseDate !== undefined ? { expenseDate: new Date(input.expenseDate) } : {}),
        ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
        ...(input.payee !== undefined ? { payee: input.payee?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'EXPENSE_UPDATED',
      entityType: 'Expense',
      entityId: id,
    });
    return { ...updated, amount: toNumber(updated.amount) };
  });
}

export async function deleteExpense(id: string, userId: string) {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Expense not found');

  await prisma.$transaction(async (tx) => {
    await tx.expense.delete({ where: { id } });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'EXPENSE_DELETED',
      entityType: 'Expense',
      entityId: id,
      metadata: { referenceNumber: existing.referenceNumber, amount: toNumber(existing.amount) },
    });
  });

  return { deleted: true };
}

