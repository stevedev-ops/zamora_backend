import { MpesaPurpose, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { normalizePhone } from '../lib/phone';
import { toNumber } from '../lib/money';
import { NotFoundError, ValidationError } from '../lib/errors';
import { initiateDarajaStkPush } from '../integrations/daraja';
import { recordDebtRepayment } from './debt.service';

export async function initiateMpesaStkPush(input: {
  purpose: MpesaPurpose;
  phoneNumber: string;
  amount: number;
  customerId?: string;
  saleId?: string;
}) {
  if (input.amount <= 0) {
    throw new ValidationError('Amount must be greater than zero');
  }

  let accountReference = 'ZAMORA';
  if (input.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundError('Customer not found');
    accountReference = customer.accountNumber;
  }

  const stkResp = await initiateDarajaStkPush({
    phoneNumber: input.phoneNumber,
    amount: input.amount,
    accountReference,
    transactionDesc: input.purpose === 'POS_SALE' ? 'POS Sale' : 'Debt Pay',
  });

  const record = await prisma.mpesaTransaction.create({
    data: {
      merchantRequestId: stkResp.merchantRequestId,
      checkoutRequestId: stkResp.checkoutRequestId,
      purpose: input.purpose,
      customerId: input.customerId || null,
      saleId: input.saleId || null,
      phoneNumber: normalizePhone(input.phoneNumber),
      amount: input.amount.toFixed(2),
      status: 'PENDING',
    },
  });

  return {
    transactionId: record.id,
    checkoutRequestId: record.checkoutRequestId,
    merchantRequestId: record.merchantRequestId,
    mode: stkResp.mode,
    customerMessage: stkResp.customerMessage,
  };
}

export async function handleDarajaCallback(payload: {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: {
        Item?: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}) {
  const cb = payload?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) {
    throw new ValidationError('Invalid Daraja STK callback payload');
  }

  const txRecord = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId: cb.CheckoutRequestID },
  });
  if (!txRecord) {
    throw new NotFoundError('M-Pesa transaction not found');
  }

  // Idempotent callback handling
  if (txRecord.status !== 'PENDING') {
    return {
      alreadyProcessed: true,
      status: txRecord.status,
      mpesaReceiptNumber: txRecord.mpesaReceiptNumber,
    };
  }

  const resultCode = Number(cb.ResultCode ?? 1);
  const metaItems = cb.CallbackMetadata?.Item ?? [];
  const receiptItem = metaItems.find((i) => i.Name === 'MpesaReceiptNumber');
  const receiptNumber = receiptItem?.Value ? String(receiptItem.Value) : undefined;

  if (resultCode !== 0) {
    await prisma.mpesaTransaction.update({
      where: { id: txRecord.id },
      data: {
        status: 'FAILED',
        resultCode,
        resultDesc: cb.ResultDesc || 'Transaction cancelled or failed',
        rawCallback: payload as Prisma.InputJsonValue,
      },
    });
    return { status: 'FAILED', resultCode, resultDesc: cb.ResultDesc };
  }

  await prisma.mpesaTransaction.update({
    where: { id: txRecord.id },
    data: {
      status: 'SUCCESS',
      resultCode: 0,
      resultDesc: cb.ResultDesc || 'The service request is processed successfully.',
      mpesaReceiptNumber: receiptNumber || `MP${Date.now()}`,
      rawCallback: payload as Prisma.InputJsonValue,
    },
  });

  // Automatically settle customer debt if this STK push was a debt or portal repayment
  if (
    (txRecord.purpose === 'DEBT_REPAYMENT' || txRecord.purpose === 'PORTAL_REPAYMENT') &&
    txRecord.customerId
  ) {
    await recordDebtRepayment({
      customerId: txRecord.customerId,
      amount: toNumber(txRecord.amount),
      method: 'MPESA',
      mpesaReference: receiptNumber || txRecord.checkoutRequestId,
      mpesaCheckoutRequestId: txRecord.checkoutRequestId,
      notes: `M-Pesa STK Push (${txRecord.purpose})`,
      idempotencyKey: `mpesa-${txRecord.checkoutRequestId}`,
    });
  }

  return {
    status: 'SUCCESS',
    mpesaReceiptNumber: receiptNumber,
  };
}

export async function simulateMpesaSuccess(checkoutRequestId: string) {
  if (env.darajaMode !== 'simulation' && env.isProd) {
    throw new ValidationError('M-Pesa simulation is disabled in production');
  }
  const txRecord = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
  });
  if (!txRecord) throw new NotFoundError('M-Pesa transaction not found');

  const simulatedReceipt = `SIM${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  return handleDarajaCallback({
    Body: {
      stkCallback: {
        MerchantRequestID: txRecord.merchantRequestId || undefined,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully (Simulated).',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: toNumber(txRecord.amount) },
            { Name: 'MpesaReceiptNumber', Value: simulatedReceipt },
            { Name: 'PhoneNumber', Value: txRecord.phoneNumber },
          ],
        },
      },
    },
  });
}

export async function getMpesaTransactionStatus(checkoutRequestId: string) {
  const tx = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
  });
  if (!tx) throw new NotFoundError('M-Pesa transaction not found');
  return {
    ...tx,
    amount: toNumber(tx.amount),
  };
}

