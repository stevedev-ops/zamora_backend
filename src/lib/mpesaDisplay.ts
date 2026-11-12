export type MpesaPaymentOptionType = 'POCHI_LA_BIASHARA' | 'PAYBILL' | 'TILL';

export interface MpesaSettingFields {
  mpesaEnabled?: boolean;
  mpesaType?: string | null;
  mpesaPaybillOrTill?: string | null;
  mpesaAccountReference?: string | null;
}

export function normalizeMpesaType(settings: MpesaSettingFields): MpesaPaymentOptionType {
  if (
    settings.mpesaType === 'POCHI_LA_BIASHARA' ||
    settings.mpesaType === 'PAYBILL' ||
    settings.mpesaType === 'TILL'
  ) {
    return settings.mpesaType;
  }
  return settings.mpesaAccountReference?.trim() ? 'PAYBILL' : 'TILL';
}

export function getMpesaOptionLabel(type: MpesaPaymentOptionType): string {
  switch (type) {
    case 'POCHI_LA_BIASHARA':
      return 'Pochi la Biashara';
    case 'TILL':
      return 'M-Pesa Till Number (Buy Goods)';
    case 'PAYBILL':
    default:
      return 'M-Pesa Paybill';
  }
}

export function formatMpesaPaymentSummary(
  settings: MpesaSettingFields,
  customerAccountNumber?: string | null
): string | null {
  if (!settings.mpesaEnabled) return null;
  const number = settings.mpesaPaybillOrTill?.trim();
  if (!number) return null;

  const type = normalizeMpesaType(settings);
  if (type === 'POCHI_LA_BIASHARA') {
    return `Pochi la Biashara: ${number}`;
  }
  if (type === 'TILL') {
    return `M-Pesa Till No.: ${number}`;
  }
  const acct = settings.mpesaAccountReference?.trim() || customerAccountNumber?.trim() || '';
  return acct ? `M-Pesa Paybill: ${number} | Account: ${acct}` : `M-Pesa Paybill: ${number}`;
}
