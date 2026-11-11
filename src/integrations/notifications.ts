import { NotificationChannel, NotificationEventType, NotificationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { normalizePhone, toWhatsAppNumber } from '../lib/phone';

export interface NotificationDispatchInput {
  customerId?: string;
  channel: NotificationChannel;
  recipient: string;
  eventType: NotificationEventType;
  subject?: string;
  message: string;
}

export interface ProviderSendResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  errorMessage?: string;
}

async function sendViaSmsProvider(recipient: string, message: string): Promise<ProviderSendResult> {
  const provider = env.smsProvider;

  if (provider === 'africastalking' && env.africastalkingApiKey && env.africastalkingUsername) {
    try {
      const form = new URLSearchParams({
        username: env.africastalkingUsername,
        to: normalizePhone(recipient),
        message,
        ...(env.africastalkingSenderId ? { from: env.africastalkingSenderId } : {}),
      });
      const resp = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey: env.africastalkingApiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = (await resp.json()) as {
        SMSMessageData?: { Recipients?: Array<{ messageId?: string; status?: string }> };
      };
      const first = data?.SMSMessageData?.Recipients?.[0];
      return {
        success: resp.ok,
        provider: 'africastalking',
        providerMessageId: first?.messageId,
        errorMessage: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'africastalking',
        errorMessage: err instanceof Error ? err.message : 'SMS send failed',
      };
    }
  }

  if (provider === 'twilio' && env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber) {
    try {
      const form = new URLSearchParams({
        To: normalizePhone(recipient),
        From: env.twilioFromNumber,
        Body: message,
      });
      const authHeader = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString(
        'base64'
      );
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        }
      );
      const data = (await resp.json()) as { sid?: string; message?: string };
      return {
        success: resp.ok,
        provider: 'twilio',
        providerMessageId: data?.sid,
        errorMessage: resp.ok ? undefined : data?.message || `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'twilio',
        errorMessage: err instanceof Error ? err.message : 'Twilio send failed',
      };
    }
  }

  if (!env.isTest) {
    console.info(`[MOCK SMS -> ${recipient}] ${message}`);
  }
  return {
    success: true,
    provider: 'mock',
    providerMessageId: `mock-sms-${Date.now()}`,
  };
}

async function sendViaWhatsAppProvider(
  recipient: string,
  message: string
): Promise<ProviderSendResult> {
  const provider = env.whatsappProvider;

  if (provider === 'whatsapp_cloud' && env.whatsappCloudToken && env.whatsappPhoneNumberId) {
    try {
      const resp = await fetch(
        `https://graph.facebook.com/v19.0/${env.whatsappPhoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.whatsappCloudToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: toWhatsAppNumber(recipient),
            type: 'text',
            text: { body: message },
          }),
        }
      );
      const data = (await resp.json()) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string };
      };
      return {
        success: resp.ok,
        provider: 'whatsapp_cloud',
        providerMessageId: data?.messages?.[0]?.id,
        errorMessage: resp.ok ? undefined : data?.error?.message || `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'whatsapp_cloud',
        errorMessage: err instanceof Error ? err.message : 'WhatsApp send failed',
      };
    }
  }

  if (!env.isTest) {
    console.info(`[MOCK WHATSAPP -> ${recipient}] ${message}`);
  }
  return {
    success: true,
    provider: 'mock',
    providerMessageId: `mock-wa-${Date.now()}`,
  };
}

export async function dispatchNotification(input: NotificationDispatchInput) {
  let result: ProviderSendResult;
  if (input.channel === 'SMS') {
    result = await sendViaSmsProvider(input.recipient, input.message);
  } else if (input.channel === 'WHATSAPP') {
    result = await sendViaWhatsAppProvider(input.recipient, input.message);
  } else {
    result = { success: true, provider: 'in_app' };
  }

  const status: NotificationStatus = result.success ? 'SENT' : 'FAILED';

  return prisma.notification.create({
    data: {
      customerId: input.customerId,
      channel: input.channel,
      recipient: input.recipient,
      eventType: input.eventType,
      subject: input.subject,
      message: input.message,
      status,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      errorMessage: result.errorMessage,
      sentAt: result.success ? new Date() : null,
    },
  });
}

export async function ensureActiveCustomerPortalLink(customerId: string): Promise<string> {
  const existing = await prisma.customerPortalToken.findFirst({
    where: {
      customerId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    return `${env.publicPortalBaseUrl}/${existing.token}`;
  }

  const { generateSecureToken } = await import('../lib/crypto');
  const rawToken = generateSecureToken(24);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await prisma.customerPortalToken.create({
    data: {
      customerId,
      token: rawToken,
      expiresAt,
    },
  });
  return `${env.publicPortalBaseUrl}/${rawToken}`;
}

export function buildWhatsAppShareUrl(phone: string, message: string): string {
  const num = toWhatsAppNumber(phone);
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

export async function notifyCustomerDebtEvent(params: {
  customerId: string;
  customerName: string;
  customerPhone: string;
  eventType: NotificationEventType;
  subject: string;
  messageBody: string;
  newBalance: string;
}) {
  const settings = await prisma.setting.findUnique({ where: { key: 'default' } });
  const portalUrl = await ensureActiveCustomerPortalLink(params.customerId);
  const storeName = settings?.storeName || 'Zamora Liquor Store';
  const currency = settings?.currency || 'KSh';

  const fullMessage = `${storeName}: Hi ${params.customerName}, ${params.messageBody} New balance: ${currency} ${params.newBalance}. View statement: ${portalUrl}`;

  if (settings?.smsEnabled ?? true) {
    await dispatchNotification({
      customerId: params.customerId,
      channel: 'SMS',
      recipient: params.customerPhone,
      eventType: params.eventType,
      subject: params.subject,
      message: fullMessage,
    });
  }
}

