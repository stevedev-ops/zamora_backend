import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler } from './lib/errors';

import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import categoriesRoutes from './routes/categories.routes';
import productsRoutes from './routes/products.routes';
import inventoryRoutes from './routes/inventory.routes';
import suppliersRoutes from './routes/suppliers.routes';
import purchasesRoutes from './routes/purchases.routes';
import customersRoutes from './routes/customers.routes';
import salesRoutes from './routes/sales.routes';
import debtRoutes from './routes/debt.routes';
import portalRoutes from './routes/portal.routes';
import mpesaRoutes from './routes/mpesa.routes';
import expensesRoutes from './routes/expenses.routes';
import reportsRoutes from './routes/reports.routes';
import settingsRoutes from './routes/settings.routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/+$/, '');
        if (env.frontendUrls.includes('*') || env.frontendUrls.includes(normalized)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      exposedHeaders: ['Content-Disposition'],
    })
  );
  const defaultJsonParser = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/settings/backup/restore') {
      next();
      return;
    }
    defaultJsonParser(req, res, next);
  });
  app.use(cookieParser());
  app.use('/api', apiLimiter);

  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'zamora-liquor-api', health: '/api/health' });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'zamora-liquor-api', timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/products', productsRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/suppliers', suppliersRoutes);
  app.use('/api/purchases', purchasesRoutes);
  app.use('/api/customers', customersRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/debt', debtRoutes);
  app.use('/api/portal', portalRoutes);
  app.use('/api/mpesa', mpesaRoutes);
  app.use('/api/expenses', expensesRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/settings', settingsRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found' } });
  });

  app.use(errorHandler);
  return app;
}

