import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';

export async function resetDatabase() {
  // Truncate all tables cleanly while preserving schema
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      sale_item_batch_allocations,
      sale_items,
      clarification_requests,
      mpesa_transactions,
      debt_transactions,
      debt_transfers,
      payments,
      sales,
      portal_otp_challenges,
      customer_portal_tokens,
      credit_limits,
      customer_accounts,
      customers,
      inventory_movements,
      inventory_batches,
      supplier_purchase_items,
      supplier_purchases,
      products,
      suppliers,
      categories,
      expenses,
      notifications,
      audit_logs,
      password_reset_tokens,
      users,
      settings,
      sequence_counters
    RESTART IDENTITY CASCADE
  `);
}

export async function seedTestFixtures() {
  await prisma.setting.create({
    data: {
      key: 'default',
      storeName: 'Zamora Test Store',
      storePhone: '+254700111222',
      storeAddress: 'Nairobi',
      currency: 'KSh',
      mpesaEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
      defaultCreditLimit: 5000,
    },
  });

  const passwordHash = await bcrypt.hash('TestOwner123!', 10);
  const owner = await prisma.user.create({
    data: {
      name: 'Test Owner',
      email: 'owner@test.local',
      phone: '+254700111222',
      passwordHash,
      role: 'OWNER',
    },
  });

  const beerCategory = await prisma.category.create({
    data: { name: 'Beer', slug: 'beer', isDefault: true },
  });

  const ginCategory = await prisma.category.create({
    data: { name: 'Gin', slug: 'gin', isDefault: true },
  });

  const supplier = await prisma.supplier.create({
    data: {
      name: 'Test Distributor',
      phone: '+254722000111',
      address: 'Industrial Area',
    },
  });

  return { owner, beerCategory, ginCategory, supplier };
}

