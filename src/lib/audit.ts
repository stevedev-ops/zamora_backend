import { AuditActorType, Prisma, PrismaClient } from '@prisma/client';

type TxClient = Prisma.TransactionClient | PrismaClient;

export interface AuditInput {
  actorType: AuditActorType;
  actorId?: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function recordAuditLog(tx: TxClient, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
      ipAddress: input.ipAddress,
    },
  });
}

