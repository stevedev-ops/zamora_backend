import { Response } from 'express';
import { ValidationError } from '../lib/errors';
import { ExcelSheetDefinition, generateExcelWorkbook } from './excel';
import { generateTabularReportPdf, StoreHeaderInfo, TabularPdfColumn } from './pdf';

export type ExportFormat = 'pdf' | 'excel' | 'csv';

export interface ExportColumn<T> {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right';
  money?: boolean;
  format?: (row: T) => string | number | boolean | null | undefined;
}

export interface TableExportSpec<T> {
  format: ExportFormat;
  filenameBase: string;
  title: string;
  subtitle?: string;
  filterSummary?: string;
  summaryRows?: Array<{ label: string; value: string }>;
  columns: ExportColumn<T>[];
  rows: T[];
  extraExcelSheets?: ExcelSheetDefinition[];
  store: StoreHeaderInfo;
}

export function parseExportFormat(raw?: string): ExportFormat {
  const val = (raw || 'pdf').toLowerCase().trim();
  if (val === 'pdf') return 'pdf';
  if (val === 'excel' || val === 'xlsx') return 'excel';
  if (val === 'csv') return 'csv';
  throw new ValidationError('Invalid export format. Use pdf, excel, or csv.');
}

export function exportFmtMoney(currency: string, val: unknown): string {
  const num = Number(val ?? 0);
  return `${currency} ${num.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function exportFmtDate(val: Date | string | null | undefined): string {
  if (!val) return '';
  return new Date(val).toISOString().slice(0, 10);
}

export function exportFmtDateTime(val: Date | string | null | undefined): string {
  if (!val) return '';
  const d = new Date(val);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function resolveDisplayValue<T extends Record<string, unknown>>(
  col: ExportColumn<T>,
  row: T
): string {
  const raw = col.format ? col.format(row) : row[col.key];
  if (raw === null || raw === undefined) return '';
  if (col.money && typeof raw === 'number' && Number.isFinite(raw)) {
    return raw.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(raw);
}

export function buildCsvBuffer<T extends Record<string, unknown>>(
  columns: ExportColumn<T>[],
  rows: T[]
): Buffer {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvCell(resolveDisplayValue(c, row))).join(',')
  );
  // UTF-8 BOM helps Microsoft Excel recognize UTF-8 characters properly
  const content = `\uFEFF${[headerLine, ...lines].join('\r\n')}\r\n`;
  return Buffer.from(content, 'utf8');
}

export async function sendTableExport<T extends Record<string, unknown>>(
  res: Response,
  spec: TableExportSpec<T>
): Promise<void> {
  const dateSuffix = new Date().toISOString().slice(0, 10);

  if (spec.format === 'csv') {
    const buffer = buildCsvBuffer(spec.columns, spec.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${spec.filenameBase}-${dateSuffix}.csv"`
    );
    res.send(buffer);
    return;
  }

  if (spec.format === 'excel') {
    const mainRows = spec.rows.map((row) => {
      const mapped: Record<string, string | number | boolean | null | undefined> = {};
      for (const col of spec.columns) {
        const raw = col.format ? col.format(row) : (row[col.key] as string | number | boolean | null | undefined);
        mapped[col.key] = raw;
      }
      return mapped;
    });

    const sheets: ExcelSheetDefinition[] = [
      {
        name: spec.title.slice(0, 31),
        columns: spec.columns.map((c) => ({
          header: c.header,
          key: c.key,
          width: c.width ?? Math.max(14, c.header.length + 4),
        })),
        rows: mainRows,
      },
      ...(spec.summaryRows && spec.summaryRows.length > 0
        ? [
            {
              name: 'Summary',
              columns: [
                { header: 'Metric', key: 'metric', width: 32 },
                { header: 'Value', key: 'value', width: 28 },
              ],
              rows: [
                ...(spec.filterSummary ? [{ metric: 'Filters Applied', value: spec.filterSummary }] : []),
                ...spec.summaryRows.map((s) => ({ metric: s.label, value: s.value })),
              ],
            },
          ]
        : []),
      ...(spec.extraExcelSheets || []),
    ];

    const buffer = await generateExcelWorkbook(sheets);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${spec.filenameBase}-${dateSuffix}.xlsx"`
    );
    res.send(buffer);
    return;
  }

  const pdfColumns: TabularPdfColumn[] = spec.columns.map((c) => ({
    header: c.header,
    weight: c.width ?? Math.max(12, c.header.length + 2),
    align: c.align ?? (c.money ? 'right' : 'left'),
  }));

  const pdfRows = spec.rows.map((row) =>
    spec.columns.map((c) => resolveDisplayValue(c, row))
  );

  const buffer = await generateTabularReportPdf({
    title: spec.title,
    subtitle: spec.subtitle,
    filterSummary: spec.filterSummary,
    summaryRows: spec.summaryRows ?? [],
    columns: pdfColumns,
    rows: pdfRows,
    store: spec.store,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${spec.filenameBase}-${dateSuffix}.pdf"`
  );
  res.send(buffer);
}
