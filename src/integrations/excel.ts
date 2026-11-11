import ExcelJS from 'exceljs';

export interface ExcelSheetDefinition {
  name: string;
  columns: Array<{ header: string; key: string; width?: number }>;
  rows: Array<Record<string, string | number | boolean | null | undefined>>;
}

export async function generateExcelWorkbook(sheets: ExcelSheetDefinition[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Zamora Liquor Store Management System';
  workbook.created = new Date();

  for (const sheetDef of sheets) {
    const sheet = workbook.addWorksheet(sheetDef.name.slice(0, 31));
    sheet.columns = sheetDef.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width ?? 20,
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F172A' },
    };

    for (const row of sheetDef.rows) {
      sheet.addRow(row);
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

