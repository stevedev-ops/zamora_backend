import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from './errors';

export interface OwnerTokenPayload {
  sub: string;
  email: string;
  role: 'OWNER';
  tokenType: 'OWNER_SESSION';
}

export interface PortalTokenPayload {
  sub: string; // customerId
  portalTokenId: string;
  accountNumber: string;
  role: 'CUSTOMER_PORTAL';
  tokenType: 'PORTAL_SESSION';
}

export function signOwnerJwt(payload: Omit<OwnerTokenPayload, 'tokenType'>): string {
  const fullPayload: OwnerTokenPayload = { ...payload, tokenType: 'OWNER_SESSION' };
  return jwt.sign(fullPayload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'],
  });
}

export function verifyOwnerJwt(token: string): OwnerTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as OwnerTokenPayload;
    if (!decoded || decoded.tokenType !== 'OWNER_SESSION' || decoded.role !== 'OWNER') {
      throw new UnauthorizedError('Invalid owner session token');
    }
    return decoded;
  } catch {
    throw new UnauthorizedError('Invalid or expired session');
  }
}

export function signPortalJwt(payload: Omit<PortalTokenPayload, 'tokenType' | 'role'>): string {
  const fullPayload: PortalTokenPayload = {
    ...payload,
    role: 'CUSTOMER_PORTAL',
    tokenType: 'PORTAL_SESSION',
  };
  return jwt.sign(fullPayload, env.portalJwtSecret, {
    expiresIn: env.portalJwtExpiresIn as SignOptions['expiresIn'],
  });
}

export function verifyPortalJwt(token: string): PortalTokenPayload {
  try {
    const decoded = jwt.verify(token, env.portalJwtSecret) as PortalTokenPayload;
    if (
      !decoded ||
      decoded.tokenType !== 'PORTAL_SESSION' ||
      decoded.role !== 'CUSTOMER_PORTAL'
    ) {
      throw new UnauthorizedError('Invalid customer portal session');
    }
    return decoded;
  } catch {
    throw new UnauthorizedError('Invalid or expired portal session');
  }
}

