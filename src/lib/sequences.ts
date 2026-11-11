import { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Prisma.TransactionClient | PrismaClient;

export async function nextSequenceNumber(
  tx: TxClient,
  sequenceName: string,
  prefix: string,
  padLength = 5
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ current_value: number }>>`
    INSERT INTO sequence_counters (name, current_value, updated_at)
    VALUES (${sequenceName}, 1, NOW())
    ON CONFLICT (name)
    DO UPDATE SET current_value = sequence_counters.current_value + 1, updated_at = NOW()
    RETURNING current_value
  `;
  const val = rows[0]?.current_value ?? 1;
  return `${prefix}-${String(val).padStart(padLength, '0')}`;
}

