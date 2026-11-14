import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetDatabase, seedTestFixtures } from './helpers';

const app = createApp();

describe('Zamora Liquor Store - Financial, Inventory, Debt & Profit Rules', () => {
  let ownerToken = '';
  let beerCategoryId = '';
  let supplierId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetDatabase();
    const fixtures = await seedTestFixtures();
    beerCategoryId = fixtures.beerCategory.id;
    supplierId = fixtures.supplier.id;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@test.local', password: 'TestOwner123!' });
    expect(loginRes.status).toBe(200);
    ownerToken = loginRes.body.token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createTestProduct(overrides: Partial<{
    name: string;
    purchasePrice: number;
    sellingPrice: number;
    initialStock: number;
  }> = {}) {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: overrides.name ?? 'Tusker Lager',
        brand: 'EABL',
        categoryId: beerCategoryId,
        supplierId,
        bottleSize: '500ml',
        purchasePrice: overrides.purchasePrice ?? 180,
        sellingPrice: overrides.sellingPrice ?? 250,
        initialStock: overrides.initialStock ?? 50,
        minStockAlert: 10,
      });
    expect(res.status).toBe(201);
    return res.body.product;
  }

  async function createTestCustomer(name: string, phone: string, creditLimit = 10000) {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fullName: name, phone, creditLimit });
    expect(res.status).toBe(201);
    return res.body.customer;
  }

  it('deducts inventory via FIFO and preserves historical cost prices on past sales when purchase costs change', async () => {
    // Batch 1: 10 bottles @ KSh 180
    const tusker = await createTestProduct({
      name: 'Tusker Lager',
      purchasePrice: 180,
      sellingPrice: 250,
      initialStock: 10,
    });

    // Batch 2 via stock purchase: 10 bottles @ KSh 200 (updates current product purchasePrice to 200)
    const purchaseRes = await request(app)
      .post('/api/purchases')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        supplierId,
        items: [{ productId: tusker.id, quantity: 10, unitCostPrice: 200 }],
      });
    expect(purchaseRes.status).toBe(201);

    // Sale 1: sell 12 bottles @ 250 -> FIFO consumes 10 @ 180 (1800) + 2 @ 200 (400) = 2200 COGS
    // Revenue = 3000, Profit = 800
    const sale1Res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        items: [{ productId: tusker.id, quantity: 12 }],
        paymentMethod: 'CASH',
      });
    expect(sale1Res.status).toBe(201);
    expect(sale1Res.body.sale.totalAmount).toBe(3000);
    expect(sale1Res.body.sale.totalCost).toBe(2200);
    expect(sale1Res.body.sale.grossProfit).toBe(800);

    // Verify stock reduced from 20 -> 8
    const prodAfterSale1 = await request(app)
      .get(`/api/products/${tusker.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(prodAfterSale1.body.product.currentStock).toBe(8);

    // Owner updates product purchase price to KSh 230
    const patchRes = await request(app)
      .patch(`/api/products/${tusker.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ purchasePrice: 230 });
    expect(patchRes.status).toBe(200);

    // Verify historical Sale 1 COGS and Gross Profit remain completely unchanged!
    const sale1Check = await request(app)
      .get(`/api/sales/${sale1Res.body.sale.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(sale1Check.body.sale.totalCost).toBe(2200);
    expect(sale1Check.body.sale.grossProfit).toBe(800);
  });

  it('rejects credit sales without a registered customer and enforces credit limits', async () => {
    const product = await createTestProduct({ sellingPrice: 500, purchasePrice: 300, initialStock: 20 });

    const walkInCredit = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: 'CREDIT',
      });
    expect(walkInCredit.status).toBe(422);

    const customer = await createTestCustomer('Low Limit Customer', '+254711000999', 800);

    // Attempt credit sale of 1000 (> 800 limit) without override
    const overLimitRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: 'CREDIT',
      });
    expect(overLimitRes.status).toBe(422);
    expect(overLimitRes.body.error.message).toMatch(/Credit limit exceeded/i);
  });

  it('handles split payments accurately (Cash + M-Pesa + remaining to Debt) and prevents duplicate submissions', async () => {
    const product = await createTestProduct({
      name: 'Chrome Gin',
      purchasePrice: 350,
      sellingPrice: 500,
      initialStock: 30,
    });
    const john = await createTestCustomer('John Kamau', '+254711222333', 10000);

    // Total = 4 * 500 = 2000; Cash 500 + M-Pesa 500 => 1000 added to debt
    const idemKey = 'sale-split-001';
    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 4 }],
        paymentMethod: 'SPLIT',
        cashAmount: 500,
        mpesaAmount: 500,
        mpesaReference: 'UBK1234567',
        idempotencyKey: idemKey,
      });

    expect(saleRes.status).toBe(201);
    expect(saleRes.body.sale.totalAmount).toBe(2000);
    expect(saleRes.body.sale.amountPaid).toBe(1000);
    expect(saleRes.body.sale.outstandingAmount).toBe(1000);
    expect(saleRes.body.sale.grossProfit).toBe(600); // 2000 - (4 * 350 = 1400)

    // Retry with same idempotencyKey -> must deduplicate, NOT double charge or double deduct stock
    const dupRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 4 }],
        paymentMethod: 'SPLIT',
        cashAmount: 500,
        mpesaAmount: 500,
        idempotencyKey: idemKey,
      });
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.sale.deduplicated).toBe(true);

    const johnProfile = await request(app)
      .get(`/api/customers/${john.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(johnProfile.body.customer.account.currentBalance).toBe(1000);

    const prodCheck = await request(app)
      .get(`/api/products/${product.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(prodCheck.body.product.currentStock).toBe(26);
  });

  it('tracks credit accumulation, partial & full repayments, adjustments, and immutable reversals', async () => {
    const product = await createTestProduct({ sellingPrice: 500, purchasePrice: 300, initialStock: 50 });
    const john = await createTestCustomer('John Kamau', '+254711222333', 15000);

    // 1. John buys KSh 3,000 on credit
    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 6 }],
        paymentMethod: 'CREDIT',
      })
      .expect(201);

    // 2. John pays KSh 1,000 -> debt becomes 2,000
    const pay1 = await request(app)
      .post('/api/debt/repayments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ customerId: john.id, amount: 1000, method: 'CASH' });
    expect(pay1.status).toBe(201);
    expect(pay1.body.newBalance).toBe(2000);

    // 3. John buys additional KSh 2,500 on credit -> debt becomes 4,500
    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 5 }],
        paymentMethod: 'CREDIT',
      })
      .expect(201);

    const johnAfterCredit2 = await request(app)
      .get(`/api/customers/${john.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(johnAfterCredit2.body.customer.account.currentBalance).toBe(4500);

    // 4. Overpayment above 4,500 must fail
    const overpay = await request(app)
      .post('/api/debt/repayments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ customerId: john.id, amount: 5000, method: 'CASH' });
    expect(overpay.status).toBe(422);

    // 5. Debt adjustment (discount/write-off of 500) -> debt becomes 4,000
    const adj = await request(app)
      .post('/api/debt/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        adjustmentKind: 'DISCOUNT_OR_WRITEOFF',
        amount: 500,
        reason: 'Loyal customer bottle breakage goodwill',
      });
    expect(adj.status).toBe(201);
    expect(adj.body.newBalance).toBe(4000);

    // 6. Reverse the adjustment -> debt returns to 4,500, original ledger row kept & marked isReversed
    const rev = await request(app)
      .post(`/api/debt/transactions/${adj.body.transaction.id}/reverse`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'Adjustment applied to wrong account' });
    expect(rev.status).toBe(201);
    expect(rev.body.newBalance).toBe(4500);

    // 7. Full repayment of 4,500 -> balance becomes 0
    const fullPay = await request(app)
      .post('/api/debt/repayments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        amount: 4500,
        method: 'MPESA',
        mpesaReference: 'UBK99900ZZ',
      });
    expect(fullPay.status).toBe(201);
    expect(fullPay.body.newBalance).toBe(0);
  });

  it('executes debt transfers immediately without OTP, prevents duplicate submissions, and blocks transfers exceeding debt', async () => {
    const product = await createTestProduct({ sellingPrice: 500, purchasePrice: 300, initialStock: 30 });
    const john = await createTestCustomer('John Kamau', '+254711222333', 10000);
    const peter = await createTestCustomer('Peter Otieno', '+254722333444', 10000);

    // John owes KSh 4,500
    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 9 }],
        paymentMethod: 'CREDIT',
      })
      .expect(201);

    // Transfer exceeding debt (5,000 > 4,500) must fail
    const exceedRes = await request(app)
      .post('/api/debt/transfers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fromCustomerId: john.id,
        toCustomerId: peter.id,
        amount: 5000,
        reason: 'Invalid over-transfer',
      });
    expect(exceedRes.status).toBe(422);

    // Execute valid direct transfer of KSh 2,000 from John to Peter (No OTP required)
    const initRes = await request(app)
      .post('/api/debt/transfers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fromCustomerId: john.id,
        toCustomerId: peter.id,
        amount: 2000,
        reason: 'Peter agreed to cover 4 bottles',
        idempotencyKey: 'test-trf-once-1',
      });
    expect(initRes.status).toBe(201);
    expect(initRes.body.transfer.status).toBe('COMPLETED');
    expect(initRes.body.completed).toBe(true);
    expect(initRes.body.fromNewBalance).toBe(2500);
    expect(initRes.body.toNewBalance).toBe(2000);

    // Balances are updated immediately
    const johnAfter = await request(app)
      .get(`/api/customers/${john.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(johnAfter.body.customer.account.currentBalance).toBe(2500);

    const peterAfter = await request(app)
      .get(`/api/customers/${peter.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(peterAfter.body.customer.account.currentBalance).toBe(2000);

    // Re-sending with same idempotency key deduplicates and does not transfer twice
    const dupRes = await request(app)
      .post('/api/debt/transfers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fromCustomerId: john.id,
        toCustomerId: peter.id,
        amount: 2000,
        reason: 'Peter agreed to cover 4 bottles',
        idempotencyKey: 'test-trf-once-1',
      });
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.deduplicated).toBe(true);

    // Balances remain 2500 and 2000 (transfer only executed once)
    const johnFinal = await request(app)
      .get(`/api/customers/${john.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(johnFinal.body.customer.account.currentBalance).toBe(2500);
  });

  it('recognizes gross profit on credit sales separately from cash collected and computes net operating profit after expenses', async () => {
    const product = await createTestProduct({
      name: 'Tusker Lager',
      purchasePrice: 180,
      sellingPrice: 250,
      initialStock: 20,
    });
    const john = await createTestCustomer('John Kamau', '+254711222333', 10000);

    // Sell 10 bottles @ 250 on CREDIT -> Revenue 2,500, COGS 1,800, Gross Profit 700, Cash Collected 0
    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [{ productId: product.id, quantity: 10 }],
        paymentMethod: 'CREDIT',
      })
      .expect(201);

    // Record expense of KSh 200
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        category: 'TRANSPORT',
        title: 'Boda delivery',
        amount: 200,
        paymentMethod: 'CASH',
      })
      .expect(201);

    const reportRes = await request(app)
      .get('/api/reports?preset=today')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(reportRes.status).toBe(200);

    const pnl = reportRes.body.profitAndLoss;
    expect(pnl.netSalesRevenue).toBe(2500);
    expect(pnl.costOfGoodsSold).toBe(1800);
    expect(pnl.grossProfit).toBe(700);
    expect(pnl.totalOperatingExpenses).toBe(200);
    expect(pnl.netOperatingProfit).toBe(500);
    expect(pnl.cashVsCredit.posTotalCollected).toBe(0);
    expect(pnl.cashVsCredit.creditSalesIssued).toBe(2500);

    // Verify PDF & Excel export endpoints return valid binary files
    const pdfRes = await request(app)
      .get('/api/reports/export/pdf?preset=today')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    expect(pdfRes.body.subarray(0, 5).toString()).toBe('%PDF-');

    const excelRes = await request(app)
      .get('/api/reports/export/excel?preset=today')
      .set('Authorization', `Bearer ${ownerToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    expect(excelRes.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(Buffer.isBuffer(excelRes.body)).toBe(true);
    expect((excelRes.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('supports owner password reset flow', async () => {
    const reqReset = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'owner@test.local' });
    expect(reqReset.status).toBe(200);
    const resetToken = reqReset.body.devResetToken;
    expect(resetToken).toBeTruthy();

    const doReset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, newPassword: 'NewStrongPassword1!' });
    expect(doReset.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@test.local', password: 'TestOwner123!' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@test.local', password: 'NewStrongPassword1!' });
    expect(newLogin.status).toBe(200);
  });

  it('supports editing, adding, and removing drinks on a credit sale (Pen action) with FIFO stock & ledger delta, plus optional debt notes', async () => {
    const tusker = await createTestProduct({
      name: 'Tusker Edit Test',
      purchasePrice: 180,
      sellingPrice: 250,
      initialStock: 20,
    });
    const guinness = await createTestProduct({
      name: 'Guinness Edit Test',
      purchasePrice: 200,
      sellingPrice: 300,
      initialStock: 10,
    });
    const steve = await createTestCustomer('Steve Mwangi', '+254744888999', 20000);

    // 1. Initial credit sale with optional note
    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: steve.id,
        items: [{ productId: tusker.id, quantity: 2 }],
        paymentMethod: 'CREDIT',
        notes: 'Bought for Steve',
      });
    expect(saleRes.status).toBe(201);
    const saleId = saleRes.body.sale.id;
    expect(saleRes.body.sale.notes).toBe('Bought for Steve');
    expect(saleRes.body.sale.totalAmount).toBe(500);
    expect(saleRes.body.sale.outstandingAmount).toBe(500);

    // 2. Pen action: edit Tusker qty 2 -> 3 and add 1x Guinness
    const addRes = await request(app)
      .patch(`/api/sales/${saleId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        items: [
          { productId: tusker.id, quantity: 3 },
          { productId: guinness.id, quantity: 1 },
        ],
        notes: 'Bought for Steve - added night cap',
        reason: 'Customer took extra drinks on tab',
      });
    expect(addRes.status).toBe(200);
    expect(addRes.body.sale.totalAmount).toBe(1050);
    expect(addRes.body.sale.notes).toBe('Bought for Steve - added night cap');
    expect(addRes.body.newCustomerBalance).toBe(1050);

    const tuskerAfterAdd = await prisma.product.findUnique({ where: { id: tusker.id } });
    const guinnessAfterAdd = await prisma.product.findUnique({ where: { id: guinness.id } });
    expect(tuskerAfterAdd?.currentStock).toBe(17);
    expect(guinnessAfterAdd?.currentStock).toBe(9);

    // 3. Pen action: remove Tusker completely, keep only 1x Guinness
    const removeRes = await request(app)
      .patch(`/api/sales/${saleId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        items: [{ productId: guinness.id, quantity: 1 }],
        reason: 'Removed Tusker returned unopened',
      });
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.sale.totalAmount).toBe(300);
    expect(removeRes.body.newCustomerBalance).toBe(300);

    const tuskerAfterRemove = await prisma.product.findUnique({ where: { id: tusker.id } });
    expect(tuskerAfterRemove?.currentStock).toBe(20);

    // 4. Add debt with blank note/reason succeeds, and with optional note succeeds
    const blankAddDebt = await request(app)
      .post('/api/debt/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: steve.id,
        adjustmentKind: 'ADD_DEBT',
        amount: 150,
      });
    expect(blankAddDebt.status).toBe(201);
    expect(blankAddDebt.body.newBalance).toBe(450);

    const notedAddDebt = await request(app)
      .post('/api/debt/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: steve.id,
        adjustmentKind: 'ADD_DEBT',
        amount: 250,
        notes: 'Bought for Steve',
      });
    expect(notedAddDebt.status).toBe(201);
    expect(notedAddDebt.body.newBalance).toBe(700);
    expect(notedAddDebt.body.transaction.description).toContain('Bought for Steve');

    // 5. Deduct error without reason is still rejected
    const badDeduct = await request(app)
      .post('/api/debt/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: steve.id,
        adjustmentKind: 'DEDUCT_ERROR',
        amount: 50,
      });
    expect([400, 422]).toContain(badDeduct.status);
  });
});

