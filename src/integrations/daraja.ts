import { env } from '../config/env';
import { toDarajaPhone } from '../lib/phone';

export interface StkPushRequest {
  phoneNumber: string;
  amount: number;
  accountReference: string;
  transactionDesc: string;
}

export interface StkPushResponse {
  mode: 'simulation' | 'sandbox' | 'production';
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
}

function formatDarajaTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

async function getDarajaAccessToken(baseUrl: string): Promise<string> {
  const auth = Buffer.from(`${env.darajaConsumerKey}:${env.darajaConsumerSecret}`).toString(
    'base64'
  );
  const resp = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!resp.ok) {
    throw new Error(`Daraja OAuth failed with HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

export async function initiateDarajaStkPush(input: StkPushRequest): Promise<StkPushResponse> {
  const hasRealCreds = Boolean(env.darajaConsumerKey && env.darajaConsumerSecret && env.darajaPasskey);

  if (env.darajaMode === 'simulation' || !hasRealCreds) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    return {
      mode: 'simulation',
      merchantRequestId: `SIM-MR-${suffix}`,
      checkoutRequestId: `ws_CO_SIM_${suffix}`,
      responseCode: '0',
      responseDescription: 'Success. Request accepted for processing (Simulation Mode)',
      customerMessage: 'Success. Request accepted for processing',
    };
  }

  const baseUrl =
    env.darajaMode === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

  const token = await getDarajaAccessToken(baseUrl);
  const timestamp = formatDarajaTimestamp();
  const password = Buffer.from(`${env.darajaShortcode}${env.darajaPasskey}${timestamp}`).toString(
    'base64'
  );
  const phone = toDarajaPhone(input.phoneNumber);

  const payload = {
    BusinessShortCode: env.darajaShortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.ceil(input.amount),
    PartyA: phone,
    PartyB: env.darajaShortcode,
    PhoneNumber: phone,
    CallBackURL: env.darajaCallbackUrl,
    AccountReference: input.accountReference.slice(0, 12),
    TransactionDesc: input.transactionDesc.slice(0, 13),
  };

  const resp = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = (await resp.json()) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResponseCode?: string;
    ResponseDescription?: string;
    CustomerMessage?: string;
    errorMessage?: string;
  };

  if (!resp.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || 'M-Pesa STK Push failed');
  }

  return {
    mode: env.darajaMode,
    merchantRequestId: data.MerchantRequestID || '',
    checkoutRequestId: data.CheckoutRequestID || '',
    responseCode: data.ResponseCode || '0',
    responseDescription: data.ResponseDescription || 'Accepted',
    customerMessage: data.CustomerMessage || 'Check your phone to complete M-Pesa payment.',
  };
}

