import PDFDocument from 'pdfkit';
import { MoneyInput, toNumber } from '../lib/money';

function buildPdfBuffer(render: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    render(doc);
    doc.end();
  });
}

function fmtMoney(currency: string, val: unknown): string {
  const n = toNumber(val as number | string);
  return `${currency} ${n.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleString('en-KE', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface StoreHeaderInfo {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  currency: string;
  receiptFooter: string;
}

export async function generateSaleReceiptPdf(
  sale: {
    receiptNumber: string;
    soldAt: Date | string;
    paymentMethod: string;
    subtotal: unknown;
    discountAmount: unknown;
    totalAmount: unknown;
    cashAmount: unknown;
    mpesaAmount: unknown;
    mpesaReference?: string | null;
    notes?: string | null;
    amountPaid: unknown;
    outstandingAmount: unknown;
    customer?: { fullName: string; accountNumber: string; phone: string } | null;
    items: Array<{
      productName: string;
      brand: string;
      bottleSize: string;
      quantity: number;
      unitSellingPrice: unknown;
      lineTotal: unknown;
    }>;
  },
  store: StoreHeaderInfo
): Promise<Buffer> {
  return buildPdfBuffer((doc) => {
    const cur = store.currency || 'KSh';

    doc.fontSize(18).font('Helvetica-Bold').text(store.storeName, { align: 'center' });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#475569')
      .text(`${store.storeAddress} | Tel: ${store.storePhone}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text('SALES RECEIPT', {
      align: 'center',
    });
    doc.moveDown(0.75);

    doc.fontSize(10).font('Helvetica');
    doc.text(`Receipt No: ${sale.receiptNumber}`);
    doc.text(`Date: ${fmtDate(sale.soldAt)}`);
    doc.text(`Payment Method: ${sale.paymentMethod}`);
    if (sale.customer) {
      doc.text(
        `Customer: ${sale.customer.fullName} (${sale.customer.accountNumber}) - ${sale.customer.phone}`
      );
    } else {
      doc.text('Customer: Walk-in Customer');
    }
    if (sale.mpesaReference) {
      doc.text(`M-Pesa Ref: ${sale.mpesaReference}`);
    }
    if (sale.notes) {
      doc.text(`Note: ${sale.notes}`);
    }

    doc.moveDown(0.75);
    // Table Header
    const startY = doc.y;
    doc.rect(40, startY, 515, 22).fill('#0f172a');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
    doc.text('Item', 46, startY + 6, { width: 225 });
    doc.text('Qty', 275, startY + 6, { width: 45, align: 'right' });
    doc.text('Unit Price', 325, startY + 6, { width: 105, align: 'right' });
    doc.text('Total', 435, startY + 6, { width: 112, align: 'right' });

    let y = startY + 26;
    doc.fillColor('#0f172a').font('Helvetica').fontSize(9);

    for (const item of sale.items) {
      if (y > 720) {
        doc.addPage();
        y = 40;
      }
      doc.text(`${item.productName} (${item.brand}, ${item.bottleSize})`, 46, y, { width: 225 });
      doc.text(String(item.quantity), 275, y, { width: 45, align: 'right' });
      doc.text(fmtMoney(cur, item.unitSellingPrice), 325, y, { width: 105, align: 'right' });
      doc.text(fmtMoney(cur, item.lineTotal), 435, y, { width: 112, align: 'right' });
      y += 20;
      doc.moveTo(40, y - 3).lineTo(555, y - 3).strokeColor('#e2e8f0').stroke();
    }

    y += 10;
    const summaryX = 330;
    doc.fontSize(10).font('Helvetica');
    doc.text('Subtotal:', summaryX, y, { width: 100 });
    doc.text(fmtMoney(cur, sale.subtotal), 435, y, { width: 112, align: 'right' });
    y += 16;

    if (toNumber(sale.discountAmount as MoneyInput) > 0) {
      doc.text('Discount:', summaryX, y, { width: 100 });
      doc.text(`-${fmtMoney(cur, sale.discountAmount)}`, 435, y, { width: 112, align: 'right' });
      y += 16;
    }

    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Total:', summaryX, y, { width: 100 });
    doc.text(fmtMoney(cur, sale.totalAmount), 435, y, { width: 112, align: 'right' });
    y += 18;

    doc.font('Helvetica').fontSize(10);
    if (toNumber(sale.cashAmount as MoneyInput) > 0) {
      doc.text('Cash Paid:', summaryX, y, { width: 100 });
      doc.text(fmtMoney(cur, sale.cashAmount), 435, y, { width: 112, align: 'right' });
      y += 16;
    }
    if (toNumber(sale.mpesaAmount as MoneyInput) > 0) {
      doc.text('M-Pesa Paid:', summaryX, y, { width: 100 });
      doc.text(fmtMoney(cur, sale.mpesaAmount), 435, y, { width: 112, align: 'right' });
      y += 16;
    }

    doc.font('Helvetica-Bold');
    doc.text('Total Paid:', summaryX, y, { width: 100 });
    doc.text(fmtMoney(cur, sale.amountPaid), 435, y, { width: 112, align: 'right' });
    y += 16;

    if (toNumber(sale.outstandingAmount as MoneyInput) > 0) {
      doc.fillColor('#dc2626');
      doc.text('Added to Debt:', summaryX, y, { width: 100 });
      doc.text(fmtMoney(cur, sale.outstandingAmount), 435, y, { width: 112, align: 'right' });
      doc.fillColor('#0f172a');
      y += 20;
    }

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(store.receiptFooter, 40, y + 20, {
      align: 'center',
      width: 515,
    });
  });
}

export async function generatePaymentReceiptPdf(
  payment: {
    referenceNumber: string;
    paidAt: Date | string;
    amount: unknown;
    method: string;
    mpesaReference?: string | null;
    notes?: string | null;
  },
  customer: { fullName: string; accountNumber: string; phone: string; currentBalance: unknown },
  store: StoreHeaderInfo
): Promise<Buffer> {
  return buildPdfBuffer((doc) => {
    const cur = store.currency || 'KSh';
    doc.fontSize(18).font('Helvetica-Bold').text(store.storeName, { align: 'center' });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#475569')
      .text(`${store.storeAddress} | Tel: ${store.storePhone}`, { align: 'center' });
    doc.moveDown(0.5);
    doc
      .fillColor('#059669')
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('PAYMENT CONFIRMATION RECEIPT', { align: 'center' });
    doc.moveDown(1);

    doc.fillColor('#0f172a').fontSize(10).font('Helvetica');
    doc.text(`Receipt Reference: ${payment.referenceNumber}`);
    doc.text(`Payment Date: ${fmtDate(payment.paidAt)}`);
    doc.text(`Customer: ${customer.fullName} (${customer.accountNumber})`);
    doc.text(`Phone: ${customer.phone}`);
    doc.text(`Payment Method: ${payment.method}`);
    if (payment.mpesaReference) {
      doc.text(`M-Pesa Reference: ${payment.mpesaReference}`);
    }
    if (payment.notes) {
      doc.text(`Notes: ${payment.notes}`);
    }
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#059669');
    doc.text(`Amount Paid: ${fmtMoney(cur, payment.amount)}`);
    doc.fillColor('#0f172a').fontSize(11);
    doc.text(`Remaining Outstanding Balance: ${fmtMoney(cur, customer.currentBalance)}`);

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(store.receiptFooter, {
      align: 'center',
    });
  });
}

export async function generateCustomerStatementPdf(
  statement: {
    customer: {
      fullName: string;
      accountNumber: string;
      phone: string;
      email?: string | null;
    };
    summary: {
      currentBalance: unknown;
      totalPurchases: unknown;
      totalPayments: unknown;
      totalTransferredIn: unknown;
      totalTransferredOut: unknown;
      lastTransactionAt?: Date | string | null;
    };
    transactions: Array<{
      createdAt: Date | string;
      referenceNumber: string;
      transactionType: string;
      direction: string;
      amount: unknown;
      runningBalance: unknown;
      description: string;
      sale?: {
        receiptNumber: string;
        totalAmount: unknown;
        amountPaid: unknown;
        outstandingAmount: unknown;
        items: Array<{
          productName: string;
          brand: string;
          bottleSize: string;
          quantity: number;
          unitSellingPrice: unknown;
          lineTotal: unknown;
        }>;
      } | null;
    }>;
  },
  store: StoreHeaderInfo
): Promise<Buffer> {
  return buildPdfBuffer((doc) => {
    const cur = store.currency || 'KSh';

    doc.fontSize(18).font('Helvetica-Bold').text(store.storeName, { align: 'center' });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#475569')
      .text(`${store.storeAddress} | Tel: ${store.storePhone}`, { align: 'center' });
    doc.moveDown(0.5);
    doc
      .fillColor('#0f172a')
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('CUSTOMER ACCOUNT STATEMENT', { align: 'center' });
    doc.moveDown(0.75);

    doc.fontSize(10).font('Helvetica');
    doc.text(`Customer: ${statement.customer.fullName}`);
    doc.text(`Account Number: ${statement.customer.accountNumber}`);
    doc.text(`Phone: ${statement.customer.phone}`);
    doc.text(`Generated: ${fmtDate(new Date())}`);
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Current Outstanding Debt: ${fmtMoney(cur, statement.summary.currentBalance)}`);
    doc.font('Helvetica').fontSize(9);
    doc.text(
      `Total Purchases: ${fmtMoney(cur, statement.summary.totalPurchases)} | Total Payments: ${fmtMoney(
        cur,
        statement.summary.totalPayments
      )} | Transferred In: ${fmtMoney(cur, statement.summary.totalTransferredIn)} | Transferred Out: ${fmtMoney(
        cur,
        statement.summary.totalTransferredOut
      )}`
    );
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Chronological Account Ledger');
    doc.moveDown(0.4);

    for (const tx of statement.transactions) {
      if (doc.y > 710) doc.addPage();
      const sign = tx.direction === 'DEBIT' ? '+' : '-';
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a');
      doc.text(
        `${fmtDate(tx.createdAt)}  |  ${tx.referenceNumber}  |  ${tx.transactionType}  |  ${sign}${fmtMoney(
          cur,
          tx.amount
        )}  |  Bal: ${fmtMoney(cur, tx.runningBalance)}`
      );
      doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`   ${tx.description}`);

      if (tx.sale && tx.sale.items.length > 0) {
        doc
          .fontSize(8.5)
          .fillColor('#0f172a')
          .text(
            `   Items on ${tx.sale.receiptNumber} (Total ${fmtMoney(
              cur,
              tx.sale.totalAmount
            )}, Paid ${fmtMoney(cur, tx.sale.amountPaid)}, Added to Debt ${fmtMoney(
              cur,
              tx.sale.outstandingAmount
            )}):`
          );
        for (const item of tx.sale.items) {
          if (doc.y > 740) doc.addPage();
          doc.text(
            `     - ${item.productName} (${item.brand}, ${item.bottleSize}) x${
              item.quantity
            } @ ${fmtMoney(cur, item.unitSellingPrice)} = ${fmtMoney(cur, item.lineTotal)}`
          );
        }
      }
      doc.moveDown(0.4);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#e2e8f0').stroke();
      doc.moveDown(0.4);
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(store.receiptFooter, {
      align: 'center',
    });
  });
}

export async function generateFinancialReportPdf(
  title: string,
  periodLabel: string,
  summaryRows: Array<{ label: string; value: string }>,
  tableHeaders: string[],
  tableRows: string[][],
  store: StoreHeaderInfo
): Promise<Buffer> {
  return buildPdfBuffer((doc) => {
    doc.fontSize(17).font('Helvetica-Bold').text(store.storeName, { align: 'center' });
    doc.fontSize(13).fillColor('#0f172a').text(title, { align: 'center' });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#475569')
      .text(`Period: ${periodLabel} | Generated: ${fmtDate(new Date())}`, { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f172a').text('Summary');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9.5);
    for (const row of summaryRows) {
      doc.text(`${row.label}: ${row.value}`);
    }

    if (tableHeaders.length > 0 && tableRows.length > 0) {
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(11).text('Details');
      doc.moveDown(0.4);
      const colWidth = Math.floor(515 / tableHeaders.length);

      let y = doc.y;
      doc.rect(40, y, 515, 20).fill('#0f172a');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
      tableHeaders.forEach((h, i) => {
        doc.text(h, 44 + i * colWidth, y + 5, { width: colWidth - 6 });
      });
      y += 24;

      doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5);
      for (const r of tableRows) {
        if (y > 740) {
          doc.addPage();
          y = 40;
        }
        r.forEach((cell, i) => {
          doc.text(cell ?? '', 44 + i * colWidth, y, { width: colWidth - 6 });
        });
        y += 18;
      }
    }
  });
}

