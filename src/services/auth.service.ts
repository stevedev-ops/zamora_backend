import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { generateSecureToken, hashToken } from '../lib/crypto';
import { signOwnerJwt } from '../lib/jwt';
import { recordAuditLog } from '../lib/audit';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../lib/errors';
import { dispatchNotification } from '../integrations/notifications';

export async function loginOwner(email: string, password: string, ipAddress?: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (!user.isActive) {
    throw new ForbiddenError('Account is disabled');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: user.id,
      userId: user.id,
      action: 'OWNER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });
  });

  const token = signOwnerJwt({
    sub: user.id,
    email: user.email,
    role: 'OWNER',
  });

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      lastLoginAt: new Date(),
    },
  };
}

export async function getOwnerProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
  if (!user) throw new UnauthorizedError('Owner account not found');
  return user;
}

export async function requestPasswordReset(email: string, ipAddress?: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });

  if (!user || !user.isActive) {
    return {
      message: 'If an account matches that email, a password reset link has been sent.',
    };
  }

  const rawToken = generateSecureToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: user.id,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });
  });

  const resetUrl = `${env.frontendUrl}/reset-password?token=${rawToken}`;
  if (user.phone) {
    await dispatchNotification({
      channel: 'SMS',
      recipient: user.phone,
      eventType: 'PORTAL_OTP',
      subject: 'Password Reset',
      message: `Zamora Liquor Store: Reset your owner password using this link (expires in 1 hour): ${resetUrl}`,
    });
  } else if (!env.isTest) {
    console.info(`[PASSWORD RESET LINK for ${user.email}]: ${resetUrl}`);
  }

  return {
    message: 'If an account matches that email, a password reset link has been sent.',
    ...(env.exposeDevOtp ? { devResetToken: rawToken, devResetUrl: resetUrl } : {}),
  };
}

export async function resetPassword(rawToken: string, newPassword: string, ipAddress?: string) {
  const tokenHash = hashToken(rawToken.trim());
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record || record.usedAt !== null || record.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('Invalid or expired password reset token');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: record.userId,
      userId: record.userId,
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: record.userId,
      ipAddress,
    });
  });

  return { message: 'Password has been reset successfully. You can now sign in.' };
}

export async function changeOwnerPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ipAddress?: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('Owner not found');

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new ValidationError('Current password is incorrect');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await recordAuditLog(tx, {
      actorType: 'OWNER',
      actorId: userId,
      userId,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: userId,
      ipAddress,
    });
  });

  return { message: 'Password updated successfully' };
}

