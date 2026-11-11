import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import * as productService from '../src/services/product.service';
import * as customerService from '../src/services/customer.service';
import * as posService from '../src/services/pos.service';
import * as debtService from '../src/services/debt.service';
import * as purchaseService from '../src/services/purchase.service';
import * as expenseService from '../src/services/expense.service';

const DEFAULT_CATEGORIES = [
  'Beer',
  'Spirits',
  'Whisky',
  'Vodka',
  'Gin',
  'Wine',
  'Brandy',
  'Rum',
  'Ciders',
  'Soft drinks',
  'Other',
];

async function main() {
  console.log('Seeding Zamora Liquor Store database...');

  // 1. Default Store Settings
  await prisma.setting.upsert({
    where: { key: 'default' },
    update: {},
    create: {
      key: 'default',
      storeName: 'Zamora Liquor Store',
      storePhone: '+254712000111',
      storeEmail: 'owner@zamoraliquor.com',
      storeAddress: 'Kilimani, Nairobi, Kenya',
      currency: 'KSh',
      receiptFooter: 'Thank you for shopping at Zamora Liquor Store! Drink responsibly.',
      mpesaEnabled: true,
      mpesaPaybillOrTill: '522533',
      mpesaAccountReference: 'ZAMORA',
      smsEnabled: true,
      whatsappEnabled: true,
      defaultCreditLimit: 10000,
      lowStockDefaultAlert: 10,
      overdueDaysThreshold: 14,
    },
  });

  // 2. Store Owner User
  const ownerEmail = 'owner@zamoraliquor.com';
  let owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (!owner) {
    const passwordHash = await bcrypt.hash('OwnerPass123!', 12);
    owner = await prisma.user.create({
      data: {
        name: 'Store Owner',
        email: ownerEmail,
        phone: '+254712000111',
        passwordHash,
        role: 'OWNER',
      },
    });
  }

  // 3. Default Liquor Categories
  const categoryMap = new Map<string, string>();
  for (const name of DEFAULT_CATEGORIES) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cat = await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { name, slug, isDefault: true },
    });
    categoryMap.set(name, cat.id);
  }

  // Only seed sample products/customers/transactions if catalog is empty
  const productCount = await prisma.product.count();
  if (productCount > 0) {
    console.log('Sample data already seeded. Skipping duplicate sample records.');
    return;
  }

  // 4. Sample Suppliers
  const eablDistributor = await prisma.supplier.create({
    data: {
      name: 'Sample EABL Nairobi Distributors',
      phone: '+254720111222',
      email: 'orders@sample-eabl.example',
      address: 'Industrial Area, Nairobi',
      notes: 'Primary beer and spirits distributor (Sample)',
    },
  });

  const wineSpiritsDistributor = await prisma.supplier.create({
    data: {
      name: 'Sample Rift Valley Wines & Spirits',
      phone: '+254733444555',
      email: 'sales@sample-rvws.example',
      address: 'Westlands, Nairobi',
      notes: 'Imported wines, whiskies & ciders (Sample)',
    },
  });

  // 5. Sample Products (with opening stock batches)
  const tusker = await productService.createProduct(
    {
      name: 'Tusker Lager (Sample)',
      brand: 'EABL',
      categoryId: categoryMap.get('Beer')!,
      supplierId: eablDistributor.id,
      barcode: '6161100100012',
      bottleSize: '500ml',
      purchasePrice: 180,
      sellingPrice: 250,
      initialStock: 50,
      minStockAlert: 15,
    },
    owner.id
  );

  const guinness = await productService.createProduct(
    {
      name: 'Guinness Foreign Extra Stout (Sample)',
      brand: 'Guinness',
      categoryId: categoryMap.get('Beer')!,
      supplierId: eablDistributor.id,
      barcode: '6161100100029',
      bottleSize: '500ml',
      purchasePrice: 215,
      sellingPrice: 300,
      initialStock: 40,
      minStockAlert: 12,
    },
    owner.id
  );

  const chromeGin = await productService.createProduct(
    {
      name: 'Chrome Gin (Sample)',
      brand: 'Chrome',
      categoryId: categoryMap.get('Gin')!,
      supplierId: eablDistributor.id,
      barcode: '6161100100036',
      bottleSize: '750ml',
      purchasePrice: 360,
      sellingPrice: 500,
      initialStock: 25,
      minStockAlert: 8,
    },
    owner.id
  );

  const johnnieRed = await productService.createProduct(
    {
      name: 'Johnnie Walker Red Label (Sample)',
      brand: 'Johnnie Walker',
      categoryId: categoryMap.get('Whisky')!,
      supplierId: wineSpiritsDistributor.id,
      barcode: '5000267014203',
      bottleSize: '750ml',
      purchasePrice: 1750,
      sellingPrice: 2300,
      initialStock: 14,
      minStockAlert: 5,
    },
    owner.id
  );

  const smirnoff = await productService.createProduct(
    {
      name: 'Smirnoff Red Vodka (Sample)',
      brand: 'Smirnoff',
      categoryId: categoryMap.get('Vodka')!,
      supplierId: eablDistributor.id,
      barcode: '5000281004501',
      bottleSize: '750ml',
      purchasePrice: 1150,
      sellingPrice: 1550,
      initialStock: 18,
      minStockAlert: 6,
    },
    owner.id
  );

  const captainMorgan = await productService.createProduct(
    {
      name: 'Captain Morgan Spiced Gold (Sample)',
      brand: 'Captain Morgan',
      categoryId: categoryMap.get('Rum')!,
      supplierId: eablDistributor.id,
      barcode: '5000299223017',
      bottleSize: '750ml',
      purchasePrice: 1050,
      sellingPrice: 1450,
      initialStock: 12,
      minStockAlert: 5,
    },
    owner.id
  );

  const savanna = await productService.createProduct(
    {
      name: 'Savanna Dry Cider (Sample)',
      brand: 'Savanna',
      categoryId: categoryMap.get('Ciders')!,
      supplierId: wineSpiritsDistributor.id,
      barcode: '6001108001234',
      bottleSize: '330ml',
      purchasePrice: 195,
      sellingPrice: 280,
      initialStock: 8,
      minStockAlert: 12, // Intentionally low stock for alert visibility!
    },
    owner.id
  );

  const fourCousins = await productService.createProduct(
    {
      name: 'Four Cousins Sweet Red (Sample)',
      brand: 'Four Cousins',
      categoryId: categoryMap.get('Wine')!,
      supplierId: wineSpiritsDistributor.id,
      barcode: '6009645210011',
      bottleSize: '750ml',
      purchasePrice: 920,
      sellingPrice: 1300,
      initialStock: 16,
      minStockAlert: 5,
    },
    owner.id
  );

  const viceroy = await productService.createProduct(
    {
      name: 'Viceroy 5 Year Brandy (Sample)',
      brand: 'Viceroy',
      categoryId: categoryMap.get('Brandy')!,
      supplierId: wineSpiritsDistributor.id,
      barcode: '6001108009876',
      bottleSize: '750ml',
      purchasePrice: 1100,
      sellingPrice: 1500,
      initialStock: 10,
      minStockAlert: 4,
    },
    owner.id
  );

  const cocaCola = await productService.createProduct(
    {
      name: 'Coca-Cola PET (Sample)',
      brand: 'Coca-Cola',
      categoryId: categoryMap.get('Soft drinks')!,
      supplierId: eablDistributor.id,
      barcode: '5449000000996',
      bottleSize: '500ml',
      purchasePrice: 55,
      sellingPrice: 80,
      initialStock: 60,
      minStockAlert: 15,
    },
    owner.id
  );

  // 6. Record a sample restock purchase (different batch cost to showcase FIFO!)
  await purchaseService.createSupplierPurchase(
    {
      supplierId: eablDistributor.id,
      notes: 'Sample restock batch with updated Tusker supplier cost',
      items: [
        { productId: tusker.id, quantity: 24, unitCostPrice: 190 },
        { productId: guinness.id, quantity: 24, unitCostPrice: 220 },
      ],
    },
    owner.id
  );

  // 7. Sample Customers
  const john = await customerService.createCustomer(
    {
      fullName: 'John Kamau (Sample)',
      phone: '+254711222333',
      email: 'john.sample@example.com',
      creditLimit: 15000,
      notes: 'Regular weekend customer (Sample)',
    },
    owner.id
  );

  const peter = await customerService.createCustomer(
    {
      fullName: 'Peter Otieno (Sample)',
      phone: '+254722333444',
      email: 'peter.sample@example.com',
      creditLimit: 12000,
      notes: 'Bar account customer (Sample)',
    },
    owner.id
  );

  const grace = await customerService.createCustomer(
    {
      fullName: 'Grace Wanjiku (Sample)',
      phone: '+254733555666',
      creditLimit: 8000,
      notes: 'Wine & cider regular (Sample)',
    },
    owner.id
  );

  // 8. Sample Sales (Cash, M-Pesa, Credit, Split)
  await posService.createSale(
    {
      items: [
        { productId: johnnieRed.id, quantity: 1 },
        { productId: cocaCola.id, quantity: 2 },
      ],
      paymentMethod: 'CASH',
    },
    owner.id
  );

  await posService.createSale(
    {
      customerId: grace.id,
      items: [
        { productId: fourCousins.id, quantity: 2 },
        { productId: savanna.id, quantity: 2 },
      ],
      paymentMethod: 'MPESA',
      mpesaReference: 'UBK49201XY',
    },
    owner.id
  );

  // John buys on Split (pays 600, adds 1,000 to debt -> matches prompt example!)
  await posService.createSale(
    {
      customerId: john.id,
      items: [
        { productId: tusker.id, quantity: 2 },
        { productId: guinness.id, quantity: 2 },
        { productId: chromeGin.id, quantity: 1 },
      ],
      paymentMethod: 'SPLIT',
      cashAmount: 600,
      mpesaAmount: 0,
    },
    owner.id
  );

  // John buys additional drinks on pure Credit
  await posService.createSale(
    {
      customerId: john.id,
      items: [
        { productId: smirnoff.id, quantity: 1 },
        { productId: captainMorgan.id, quantity: 1 },
      ],
      paymentMethod: 'CREDIT',
    },
    owner.id
  );

  // John makes a partial M-Pesa repayment
  await debtService.recordDebtRepayment(
    {
      customerId: john.id,
      amount: 1000,
      method: 'MPESA',
      mpesaReference: 'UBK55123AB',
      notes: 'Partial debt repayment (Sample)',
    },
    owner.id
  );

  // Peter buys on Credit
  await posService.createSale(
    {
      customerId: peter.id,
      items: [
        { productId: viceroy.id, quantity: 1 },
        { productId: tusker.id, quantity: 4 },
      ],
      paymentMethod: 'CREDIT',
    },
    owner.id
  );

  // 9. Sample Business Expenses
  await expenseService.createExpense(
    {
      category: 'RENT',
      title: 'Shop Monthly Rent (Sample)',
      amount: 35000,
      paymentMethod: 'BANK_TRANSFER',
      payee: 'Kilimani Commercial Properties',
    },
    owner.id
  );

  await expenseService.createExpense(
    {
      category: 'ELECTRICITY',
      title: 'Kenya Power Cold Room & Chiller Bill (Sample)',
      amount: 4800,
      paymentMethod: 'MPESA',
      payee: 'Kenya Power',
    },
    owner.id
  );

  await expenseService.createExpense(
    {
      category: 'LICENCES',
      title: 'County Liquor Permit Renewal Installment (Sample)',
      amount: 5000,
      paymentMethod: 'MPESA',
      payee: 'Nairobi City County',
    },
    owner.id
  );

  console.log('Seed completed successfully!');
  console.log('Owner Login -> Email: owner@zamoraliquor.com | Password: OwnerPass123!');
  console.log(`John Portal URL: ${john.portalUrl}`);
  console.log(`Peter Portal URL: ${peter.portalUrl}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

