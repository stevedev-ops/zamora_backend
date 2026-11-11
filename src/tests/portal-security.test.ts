import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetDatabase, seedTestFixtures } from './helpers';

const app = createApp();

describe('Customer Self-Service Debt Portal - Security, Isolation & Itemized Drinks', () => {
  let ownerToken = '';
  let beerCategoryId = '';
  let ginCategoryId = '';

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetDatabase();
    const fixtures = await seedTestFixtures();
    beerCategoryId = fixtures.beerCategory.id;
    ginCategoryId = fixtures.ginCategory.id;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@test.local', password: 'TestOwner123!' });
    ownerToken = loginRes.body.token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('requires OTP verification, shows exact drinks purchased, never leaks internal costs/profits, and isolates customer data', async () => {
    // Create products with secret purchase prices
    const tuskerRes = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Tusker Lager',
        brand: 'EABL',
        categoryId: beerCategoryId,
        bottleSize: '500ml',
        purchasePrice: 180,
        sellingPrice: 250,
        initialStock: 30,
      });
    const tusker = tuskerRes.body.product;

    const ginRes = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Chrome Gin',
        brand: 'Chrome',
        categoryId: ginCategoryId,
        bottleSize: '750ml',
        purchasePrice: 350,
        sellingPrice: 500,
        initialStock: 20,
      });
    const gin = ginRes.body.product;

    // Create two customers: John and Peter
    const johnRes = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fullName: 'John Kamau', phone: '+254711222333', creditLimit: 10000 });
    const john = johnRes.body.customer;
    const johnPortalToken = String(john.portalUrl).split('/').pop()!;

    const peterRes = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fullName: 'Peter Otieno', phone: '+254722333444', creditLimit: 10000 });
    const peter = peterRes.body.customer;

    // Record a split purchase for John (2 Tusker = 500 + 1 Chrome Gin = 500 => Total 1,000; Paid 400; Debt 600)
    const johnSaleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: john.id,
        items: [
          { productId: tusker.id, quantity: 2 },
          { productId: gin.id, quantity: 1 },
        ],
        paymentMethod: 'SPLIT',
        cashAmount: 400,
        mpesaAmount: 0,
      });
    expect(johnSaleRes.status).toBe(201);

    // Record a credit purchase for Peter
    const peterSaleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: peter.id,
        items: [{ productId: gin.id, quantity: 2 }],
        paymentMethod: 'CREDIT',
      });
    expect(peterSaleRes.status).toBe(201);
    const peterSaleId = peterSaleRes.body.sale.id;

    // 1. Challenge endpoint exposes masked phone only, no financial totals
    const challengeRes = await request(app).get(`/api/portal/${johnPortalToken}/challenge`);
    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.maskedPhone).toContain('****');
    expect(challengeRes.body.currentBalance).toBeUndefined();

    // 2. Unauthenticated access to portal dashboard is rejected
    const unauthDash = await request(app).get('/api/portal/me/dashboard');
    expect(unauthDash.status).toBe(401);

    // 3. Request OTP & verify with wrong OTP first
    const otpReq = await request(app).post(`/api/portal/${johnPortalToken}/request-otp`);
    expect(otpReq.status).toBe(200);
    const devOtp = otpReq.body.devOtp;

    const badVerify = await request(app)
      .post(`/api/portal/${johnPortalToken}/verify-otp`)
      .send({ otp: '999999' });
    expect(badVerify.status).toBe(422);

    // 4. Verify with valid OTP -> obtain scoped portal session JWT
    const verifyRes = await request(app)
      .post(`/api/portal/${johnPortalToken}/verify-otp`)
      .send({ otp: devOtp });
    expect(verifyRes.status).toBe(200);
    const portalJwt = verifyRes.body.sessionToken;

    // 5. Portal dashboard shows John's exact drinks purchased & NEVER exposes owner costs/margins
    const dashRes = await request(app)
      .get('/api/portal/me/dashboard')
      .set('x-portal-session', portalJwt);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.summary.currentBalance).toBe(600);
    expect(dashRes.body.transactions.length).toBe(1);

    const creditTx = dashRes.body.transactions[0];
    expect(creditTx.sale).toBeTruthy();
    expect(creditTx.sale.items).toHaveLength(2);
    expect(creditTx.sale.items[0]).toMatchObject({
      productName: expect.any(String),
      brand: expect.any(String),
      bottleSize: expect.any(String),
      quantity: expect.any(Number),
      unitSellingPrice: expect.any(Number),
      lineTotal: expect.any(Number),
    });

    // Assert NO internal owner fields exist anywhere in serialized JSON
    const serialized = JSON.stringify(dashRes.body);
    expect(serialized).not.toContain('unitCostPrice');
    expect(serialized).not.toContain('lineCost');
    expect(serialized).not.toContain('lineProfit');
    expect(serialized).not.toContain('totalCost');
    expect(serialized).not.toContain('grossProfit');
    expect(serialized).not.toContain('purchasePrice');

    // 6. John CANNOT access Peter's sale receipt
    const crossCustomerRes = await request(app)
      .get(`/api/portal/me/sales/${peterSaleId}`)
      .set('x-portal-session', portalJwt);
    expect(crossCustomerRes.status).toBe(403);

    // 7. John CANNOT access owner administrative endpoints with portal JWT
    const ownerEndpointRes = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${portalJwt}`);
    expect(ownerEndpointRes.status).toBe(401);

    // 8. John can download his own PDF statement
    const stmtPdf = await request(app)
      .get('/api/portal/me/statement.pdf')
      .set('x-portal-session', portalJwt);
    expect(stmtPdf.status).toBe(200);
    expect(stmtPdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    // 9. Revoking / regenerating John's portal link immediately invalidates the old portal session
    await request(app)
      .post(`/api/customers/${john.id}/portal-link/regenerate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const afterRevokeRes = await request(app)
      .get('/api/portal/me/dashboard')
      .set('x-portal-session', portalJwt);
    expect(afterRevokeRes.status).toBe(401);
  });

  it('supports M-Pesa STK Push simulation and callback repayment directly from portal', async () => {
    const product = (
      await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Guinness',
          brand: 'Guinness',
          categoryId: beerCategoryId,
          bottleSize: '500ml',
          purchasePrice: 200,
          sellingPrice: 300,
          initialStock: 10,
        })
    ).body.product;

    const cust = (
      await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ fullName: 'Grace Wanjiku', phone: '+254733555666', creditLimit: 5000 })
    ).body.customer;
    const token = String(cust.portalUrl).split('/').pop()!;

    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: cust.id,
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: 'CREDIT',
      })
      .expect(201);

    const otpReq = await request(app).post(`/api/portal/${token}/request-otp`);
    const verify = await request(app)
      .post(`/api/portal/${token}/verify-otp`)
      .send({ otp: otpReq.body.devOtp });
    const portalJwt = verify.body.sessionToken;

    // Customer initiates M-Pesa STK push for KSh 600 of KSh 900 debt
    const stk = await request(app)
      .post('/api/portal/me/mpesa/stkpush')
      .set('x-portal-session', portalJwt)
      .send({ phoneNumber: '0733555666', amount: 600 });
    expect(stk.status).toBe(201);

    // Simulate Daraja callback
    const cb = await request(app)
      .post('/api/mpesa/simulate-callback')
      .send({ checkoutRequestId: stk.body.checkoutRequestId });
    expect(cb.status).toBe(200);
    expect(cb.body.status).toBe('SUCCESS');

    const dashAfter = await request(app)
      .get('/api/portal/me/dashboard')
      .set('x-portal-session', portalJwt);
    expect(dashAfter.body.summary.currentBalance).toBe(300);
  });

  it('opens portal link directly without OTP when portalRequireOtp is false, shows seller sale notes, and enforces OTP when enabled', async () => {
    const product = (
      await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'White Cap',
          brand: 'EABL',
          categoryId: beerCategoryId,
          bottleSize: '500ml',
          purchasePrice: 170,
          sellingPrice: 250,
          initialStock: 12,
        })
    ).body.product;

    const cust = (
      await request(app)
        .post('/api/customers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          fullName: 'Direct Portal Tester',
          phone: '+254755111222',
          creditLimit: 5000,
          notes: 'Internal only CRM note',
        })
    ).body.customer;
    const token = String(cust.portalUrl).split('/').pop()!;

    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customerId: cust.id,
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: 'CREDIT',
        notes: 'Bought for Steve',
      })
      .expect(201);

    const ch = await request(app).get(`/api/portal/${token}/challenge`);
    expect(ch.status).toBe(200);
    expect(ch.body.requireOtp).toBe(false);
    expect(ch.body.currentBalance).toBeUndefined();

    const openRes = await request(app).post(`/api/portal/${token}/open`);
    expect(openRes.status).toBe(200);
    expect(openRes.body.requiresOtp).toBe(false);
    const portalJwt = openRes.body.sessionToken;
    expect(portalJwt).toBeTruthy();

    const dashRes = await request(app)
      .get('/api/portal/me/dashboard')
      .set('x-portal-session', portalJwt);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.summary.currentBalance).toBe(500);
    expect(dashRes.body.transactions[0].sale.notes).toBe('Bought for Steve');
    expect(JSON.stringify(dashRes.body)).not.toContain('Internal only CRM note');
    expect(JSON.stringify(dashRes.body)).not.toContain('unitCostPrice');

    // Enabling OTP requirement in settings locks /open
    await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ portalRequireOtp: true })
      .expect(200);

    const chLocked = await request(app).get(`/api/portal/${token}/challenge`);
    expect(chLocked.body.requireOtp).toBe(true);

    const openBlocked = await request(app).post(`/api/portal/${token}/open`);
    expect(openBlocked.status).toBe(422);

    // Restore default
    await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ portalRequireOtp: false })
      .expect(200);
  });
});

