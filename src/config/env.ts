import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const isProd = process.env.NODE_ENV === 'production';

function getEnv(name: string, fallback?: string): string {
  const val = process.env[name];
  if (val !== undefined && val !== '') return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parseOrigins(...values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(',')) {
      const normalized = normalizeUrl(part);
      if (normalized) seen.add(normalized);
    }
  }
  return Array.from(seen);
}

const defaultFrontendUrl = isProd
  ? 'https://zamora-beta.vercel.app'
  : 'http://localhost:5173';
const frontendUrls = parseOrigins(
  process.env.FRONTEND_URL || defaultFrontendUrl,
  process.env.CORS_ORIGINS
);
const primaryFrontendUrl = frontendUrls[0] || defaultFrontendUrl;
const cookieSecure =
  process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === 'true' : isProd;
const rawSameSite = process.env.COOKIE_SAME_SITE?.toLowerCase();
const cookieSameSite: 'lax' | 'strict' | 'none' =
  rawSameSite === 'none' || rawSameSite === 'strict' || rawSameSite === 'lax'
    ? rawSameSite
    : cookieSecure
      ? 'none'
      : 'lax';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT || 4000),
  frontendUrl: primaryFrontendUrl,
  frontendUrls,
  publicPortalBaseUrl: normalizeUrl(
    process.env.PUBLIC_PORTAL_BASE_URL || `${primaryFrontendUrl}/portal`
  ),
  databaseUrl: getEnv(
    'DATABASE_URL',
    'postgresql://zamora_user:zamora_pass@localhost:5432/zamora_liquor?schema=public'
  ),
  jwtSecret: isProd
    ? getEnv('JWT_SECRET')
    : process.env.JWT_SECRET || 'dev-owner-jwt-secret-change-me-in-production-32bytes',
  portalJwtSecret: isProd
    ? getEnv('PORTAL_JWT_SECRET')
    : process.env.PORTAL_JWT_SECRET || 'dev-portal-jwt-secret-change-me-in-production-32bytes',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  portalJwtExpiresIn: process.env.PORTAL_JWT_EXPIRES_IN || '2h',
  cookieSecure,
  cookieSameSite,
  exposeDevOtp: !isProd && process.env.EXPOSE_DEV_OTP !== 'false',
  bootstrapOwnerEmail: process.env.OWNER_EMAIL || 'owner@zamoraliquor.com',
  bootstrapOwnerPassword: process.env.OWNER_PASSWORD || 'OwnerPass123!',
  bootstrapOwnerName: process.env.OWNER_NAME || 'Store Owner',
  smsProvider: process.env.SMS_PROVIDER || 'mock',
  whatsappProvider: process.env.WHATSAPP_PROVIDER || 'mock',
  africastalkingApiKey: process.env.AFRICASTALKING_API_KEY || '',
  africastalkingUsername: process.env.AFRICASTALKING_USERNAME || '',
  africastalkingSenderId: process.env.AFRICASTALKING_SENDER_ID || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  whatsappCloudToken: process.env.WHATSAPP_CLOUD_TOKEN || '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  darajaMode: (process.env.DARAJA_MODE || 'simulation') as 'simulation' | 'sandbox' | 'production',
  darajaConsumerKey: process.env.DARAJA_CONSUMER_KEY || '',
  darajaConsumerSecret: process.env.DARAJA_CONSUMER_SECRET || '',
  darajaShortcode: process.env.DARAJA_SHORTCODE || '174379',
  darajaPasskey: process.env.DARAJA_PASSKEY || '',
  darajaCallbackUrl:
    process.env.DARAJA_CALLBACK_URL ||
    (process.env.RENDER_EXTERNAL_URL
      ? `${normalizeUrl(process.env.RENDER_EXTERNAL_URL)}/api/mpesa/callback`
      : 'http://localhost:4000/api/mpesa/callback'),
};

