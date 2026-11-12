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

export function resolveCalendarDayWindow(params?: {
  date?: string;
  tzOffsetMinutes?: number;
}): { start: Date; end: Date; dateLabel: string } {
  const tzProvided =
    typeof params?.tzOffsetMinutes === 'number' &&
    Number.isFinite(params.tzOffsetMinutes) &&
    params.tzOffsetMinutes >= -840 &&
    params.tzOffsetMinutes <= 840;

  const trimmedDate = params?.date?.trim();
  const match = trimmedDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedDate) : null;

  if (tzProvided) {
    const offsetMin = params!.tzOffsetMinutes!;
    let year: number;
    let monthIdx: number;
    let day: number;
    if (match) {
      year = Number(match[1]);
      monthIdx = Number(match[2]) - 1;
      day = Number(match[3]);
    } else {
      const localNow = new Date(Date.now() - offsetMin * 60_000);
      year = localNow.getUTCFullYear();
      monthIdx = localNow.getUTCMonth();
      day = localNow.getUTCDate();
    }
    const start = new Date(Date.UTC(year, monthIdx, day, 0, 0, 0, 0) + offsetMin * 60_000);
    const end = new Date(Date.UTC(year, monthIdx, day, 23, 59, 59, 999) + offsetMin * 60_000);
    const dateLabel = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(
      2,
      '0'
    )}`;
    return { start, end, dateLabel };
  }

  if (match) {
    const year = Number(match[1]);
    const monthIdx = Number(match[2]) - 1;
    const day = Number(match[3]);
    const start = new Date(year, monthIdx, day, 0, 0, 0, 0);
    const end = new Date(year, monthIdx, day, 23, 59, 59, 999);
    const dateLabel = `${match[1]}-${match[2]}-${match[3]}`;
    return { start, end, dateLabel };
  }

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const dateLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
  return { start, end, dateLabel };
}


