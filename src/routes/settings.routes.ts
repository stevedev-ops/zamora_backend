import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as settingsService from '../services/settings.service';

const router = Router();
router.use(requireOwner);

const settingsUpdateSchema = z.object({
  storeName: z.string().min(2).max(120).optional(),
  storePhone: z.string().min(6).max(30).optional(),
  storeEmail: z.string().email().nullable().optional().or(z.literal('')),
  storeAddress: z.string().min(2).max(240).optional(),
  currency: z.string().min(1).max(10).optional(),
  receiptFooter: z.string().max(300).optional(),
  mpesaEnabled: z.boolean().optional(),
  mpesaPaybillOrTill: z.string().max(40).nullable().optional(),
  mpesaAccountReference: z.string().max(40).nullable().optional(),
  smsEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  defaultCreditLimit: z.coerce.number().min(0).optional(),
  lowStockDefaultAlert: z.coerce.number().int().min(0).optional(),
  overdueDaysThreshold: z.coerce.number().int().min(1).optional(),
  portalRequireOtp: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const settings = await settingsService.getStoreSettings();
    res.json({ settings });
  })
);

router.patch(
  '/',
  validateBody(settingsUpdateSchema),
  asyncHandler(async (req, res) => {
    const settings = await settingsService.updateStoreSettings(
      { ...req.body, storeEmail: req.body.storeEmail === '' ? null : req.body.storeEmail },
      req.owner!.id,
      req.ip
    );
    res.json({ settings });
  })
);

router.get(
  '/audit-logs',
  asyncHandler(async (req, res) => {
    const logs = await settingsService.listAuditLogs(
      req.query.limit ? Number(req.query.limit) : 100
    );
    res.json({ logs });
  })
);

router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const notifications = await settingsService.listNotifications(
      req.query.limit ? Number(req.query.limit) : 100
    );
    res.json({ notifications });
  })
);

router.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const notification = await settingsService.markNotificationRead(req.params.id as string);
    res.json({ notification });
  })
);

router.get(
  '/backup',
  asyncHandler(async (req, res) => {
    const snapshot = await settingsService.exportDatabaseSnapshot(req.owner!.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="zamora-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.send(JSON.stringify(snapshot, null, 2));
  })
);

export default router;

