import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const skipInTest = () => env.isTest;

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts. Please wait 15 minutes.',
    },
  },
});

export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many OTP verification attempts. Please try again shortly.',
    },
  },
});

