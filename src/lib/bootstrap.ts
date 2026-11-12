import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { prisma } from './prisma';

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

/**
 * Ensures a fresh production database has default store settings,
 * an initial store owner login, and standard liquor categories.
 */
export async function ensureInitialStoreBootstrap(): Promise<void> {
  await prisma.setting.upsert({
    where: { key: 'default' },
    update: {},
    create: {
      key: 'default',
      storeName: 'Zamora Liquor Store',
      storePhone: '+254712000111',
      storeEmail: env.bootstrapOwnerEmail,
      storeAddress: 'Kilimani, Nairobi, Kenya',
      currency: 'KSh',
      receiptFooter: 'Thank you for shopping at Zamora Liquor Store! Drink responsibly.',
      mpesaEnabled: true,
      mpesaType: 'PAYBILL',
      mpesaPaybillOrTill: '522533',
      mpesaAccountReference: 'ZAMORA',
      smsEnabled: true,
      whatsappEnabled: true,
      defaultCreditLimit: 10000,
      lowStockDefaultAlert: 10,
      overdueDaysThreshold: 14,
    },
  });

  const ownerCount = await prisma.user.count({ where: { role: 'OWNER' } });
  if (ownerCount === 0) {
    const email = env.bootstrapOwnerEmail.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(env.bootstrapOwnerPassword, 12);
    await prisma.user.create({
      data: {
        name: env.bootstrapOwnerName,
        email,
        phone: '+254712000111',
        passwordHash,
        role: 'OWNER',
      },
    });
    console.log(`Bootstrapped initial owner account (${email})`);
  }

  const categoryCount = await prisma.category.count();
  if (categoryCount === 0) {
    await prisma.category.createMany({
      data: DEFAULT_CATEGORIES.map((name) => ({
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        isDefault: true,
      })),
      skipDuplicates: true,
    });
  }
}
