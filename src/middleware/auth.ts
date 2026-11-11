import { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { verifyOwnerJwt, verifyPortalJwt } from '../lib/jwt';

declare global {
  namespace Express {
    interface Request {
      owner?: {
        id: string;
        email: string;
        name: string;
        role: 'OWNER';
      };
      portalSession?: {
        customerId: string;
        portalTokenId: string;
        accountNumber: string;
      };
    }
  }
}

function extractBearer(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export async function requireOwner(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.owner_token || extractBearer(req);
    if (!token) {
      throw new UnauthorizedError('Owner authentication required');
    }

    const payload = verifyOwnerJwt(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!user || !user.isActive || user.role !== 'OWNER') {
      throw new ForbiddenError('Owner account is inactive or unauthorized');
    }

    req.owner = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'OWNER',
    };
    next();
  } catch (err) {
    next(err);
  }
}

export async function requireCustomerPortal(req: Request, _res: Response, next: NextFunction) {
  try {
    const token =
      req.cookies?.portal_token ||
      (req.headers['x-portal-session'] as string | undefined) ||
      extractBearer(req);

    if (!token) {
      throw new UnauthorizedError('Portal OTP verification required');
    }

    const payload = verifyPortalJwt(token);
    const portalToken = await prisma.customerPortalToken.findUnique({
      where: { id: payload.portalTokenId },
      include: { customer: { select: { id: true, accountNumber: true } } },
    });

    if (
      !portalToken ||
      portalToken.revokedAt !== null ||
      portalToken.expiresAt.getTime() < Date.now() ||
      portalToken.customerId !== payload.sub
    ) {
      throw new UnauthorizedError('Portal link has expired or been revoked');
    }

    // If the route carries a :token param, enforce that the session belongs to that exact token
    if (req.params.token && portalToken.token !== req.params.token) {
      throw new ForbiddenError('Portal session does not match this link');
    }

    req.portalSession = {
      customerId: portalToken.customerId,
      portalTokenId: portalToken.id,
      accountNumber: portalToken.customer.accountNumber,
    };
    next();
  } catch (err) {
    next(err);
  }
}

