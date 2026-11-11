export function normalizePhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s()-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  if (cleaned.startsWith('00')) {
    return `+${cleaned.slice(2)}`;
  }
  // Kenyan local formats: 07XXXXXXXX or 01XXXXXXXX -> +2547XXXXXXXX / +2541XXXXXXXX
  if (/^0[17]\d{8}$/.test(cleaned)) {
    return `+254${cleaned.slice(1)}`;
  }
  if (/^254[17]\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  return cleaned;
}

export function toDarajaPhone(raw: string): string {
  const normalized = normalizePhone(raw);
  return normalized.startsWith('+') ? normalized.slice(1) : normalized;
}

export function maskPhone(phone: string): string {
  const norm = normalizePhone(phone);
  if (norm.length <= 6) return '***';
  return `${norm.slice(0, 5)}****${norm.slice(-3)}`;
}

export function toWhatsAppNumber(phone: string): string {
  const normalized = normalizePhone(phone);
  return normalized.replace(/^\+/, '');
}

