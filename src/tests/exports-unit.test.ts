import { Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  buildCsvBuffer,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';
import { generateTabularReportPdf, StoreHeaderInfo } from '../integrations/pdf';
import { buildDateRangeFilter } from '../lib/dateFilter';
import { getCustomerAgingBucket, getCustomerAgingDays } from '../services/customer.service';

const testStore: StoreHeaderInfo = {
  storeName: 'Zamora Liquor Store',
  storePhone: '+254700000000',
  storeAddress: 'Nairobi, Kenya',
  currency: 'KSh',
  receiptFooter: 'Drink responsibly.',
  mpesaEnabled: true,
  mpesaPaybillOrTill: '7654321',
  mpesaAccountReference: null,
};

describe('Exports, Filters & Aging Utilities', () => {
  it('parses pdf, excel/xlsx, and csv formats and rejects unknown formats', () => {
    expect(parseExportFormat('pdf')).toBe('pdf');
    expect(parseExportFormat('EXCEL')).toBe('excel');
    expect(parseExportFormat('xlsx')).toBe('excel');
    expect(parseExportFormat('csv')).toBe('csv');
    expect(() => parseExportFormat('docx')).toThrow();
  });

  it('builds UTF-8 BOM CSV with quoted commas and formatted money values', () => {
    const csv = buildCsvBuffer(
      [
        { header: 'Customer', key: 'name' },
        { header: 'Note', key: 'note' },
        { header: 'Debt (KSh)', key: 'debt', money: true },
      ],
      [{ name: 'Alice', note: 'VIP, "Regular"', debt: 1250.5 }]
    ).toString('utf8');

    expect(csv.startsWith('\uFEFFCustomer,Note,Debt (KSh)')).toBe(true);
    expect(csv).toContain('"VIP, ""Regular"""');
    expect(csv).toContain('"1,250.50"');
  });

  it('generates valid multi-column PDF and Excel export responses via sendTableExport', async () => {
    const createMockRes = () => {
      const headers: Record<string, string> = {};
      let body: Buffer | undefined;
      return {
        headers,
        getBody: () => body,
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        send: (b: Buffer) => {
          body = b;
        },
      };
    };

    const sampleRows = [
      { account: 'CUST-0001', name: 'John Doe', debt: 4500 },
      { account: 'CUST-0002', name: 'Jane Roe', debt: 900 },
    ];
    const baseSpec = {
      filenameBase: 'zamora-debtors',
      title: 'Debtors List',
      filterSummary: 'Only Customers With Debt | Aging: 30+ Days',
      summaryRows: [{ label: 'Total Outstanding Debt', value: 'KSh 5,400.00' }],
      columns: [
        { header: 'Account #', key: 'account', width: 14 },
        { header: 'Customer', key: 'name', width: 22 },
        { header: 'Debt (KSh)', key: 'debt', width: 14, align: 'right' as const, money: true },
      ],
      rows: sampleRows,
      store: testStore,
    };

    const pdfRes = createMockRes();
    await sendTableExport(pdfRes as unknown as Response, { ...baseSpec, format: 'pdf' });
    expect(pdfRes.headers['Content-Type']).toBe('application/pdf');
    expect(pdfRes.headers['Content-Disposition']).toContain('zamora-debtors-');
    expect(pdfRes.getBody()?.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const excelRes = createMockRes();
    await sendTableExport(excelRes as unknown as Response, { ...baseSpec, format: 'excel' });
    expect(excelRes.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(excelRes.getBody()?.subarray(0, 2).toString('utf8')).toBe('PK');

    const directPdf = await generateTabularReportPdf({
      title: 'Inventory Stock & Valuation',
      filterSummary: 'Low Stock Only',
      summaryRows: [{ label: 'Matching Products', value: '1' }],
      columns: Array.from({ length: 8 }, (_, idx) => ({ header: `Col ${idx + 1}` })),
      rows: [Array.from({ length: 8 }, (_, idx) => `Val ${idx + 1}`)],
      store: testStore,
    });
    expect(directPdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('normalizes YYYY-MM-DD end dates inclusively to end of day', () => {
    const range = buildDateRangeFilter('2026-11-01', '2026-11-12');
    expect(range?.gte?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(range?.lte?.toISOString()).toBe('2026-11-12T23:59:59.999Z');
    expect(buildDateRangeFilter(undefined, undefined)).toBeUndefined();
  });

  it('computes customer debt aging days and buckets consistently with frontend', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000 - 60000);
    expect(getCustomerAgingBucket(getCustomerAgingDays(daysAgo(2), daysAgo(60)))).toBe('0_7');
    expect(getCustomerAgingBucket(getCustomerAgingDays(daysAgo(15), daysAgo(60)))).toBe('8_30');
    expect(getCustomerAgingBucket(getCustomerAgingDays(null, daysAgo(45)))).toBe('30_PLUS');
  });
});

