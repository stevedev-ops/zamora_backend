import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import * as authService from '../services/auth.service';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const forgotSchema = z.object({
  email: z.string().email(),
});

const resetSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8),
});

const ownerCookieOptions = {
  httpOnly: true,
  sameSite: env.cookieSameSite,
  secure: env.cookieSecure,
};

router.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.loginOwner(email, password, req.ip);

    res.cookie('owner_token', result.token, {
      ...ownerCookieOptions,
      maxAge: 12 * 60 * 60 * 1000,
    });

    res.json({ user: result.user, token: result.token });
  })
);

router.post('/logout', (_req, res) => {
  res.clearCookie('owner_token', ownerCookieOptions);
  res.json({ message: 'Logged out successfully' });
});

router.get(
  '/me',
  requireOwner,
  asyncHandler(async (req, res) => {
    const profile = await authService.getOwnerProfile(req.owner!.id);
    res.json({ user: profile });
  })
);

router.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.requestPasswordReset(req.body.email, req.ip);
    res.json(result);
  })
);

router.post(
  '/reset-password',
  authLimiter,
  validateBody(resetSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.resetPassword(req.body.token, req.body.newPassword, req.ip);
    res.json(result);
  })
);

router.post(
  '/change-password',
  requireOwner,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.changeOwnerPassword(
      req.owner!.id,
      req.body.currentPassword,
      req.body.newPassword,
      req.ip
    );
    res.json(result);
  })
);

export default router;

