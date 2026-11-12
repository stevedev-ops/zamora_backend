export function parseFilterStartDate(raw?: string): Date | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseFilterEndDate(raw?: string): Date | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T23:59:59.999Z`)
    : new Date(trimmed);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function buildDateRangeFilter(startDate?: string, endDate?: string) {
  const gte = parseFilterStartDate(startDate);
  const lte = parseFilterEndDate(endDate);
  if (!gte && !lte) return undefined;
  return {
    ...(gte ? { gte } : {}),
    ...(lte ? { lte } : {}),
  };
}

