import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import * as settingsService from '../services/settings.service';
import {
  exportFmtDateTime,
  parseExportFormat,
  sendTableExport,
} from '../integrations/export';

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

router.get(
  '/audit-logs/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const [logs, settings] = await Promise.all([
      settingsService.listAuditLogs(limit),
      settingsService.getStoreSettings(),
    ]);

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-audit-logs',
      title: 'System Audit Logs',
      summaryRows: [{ label: 'Audit Entries', value: String(logs.length) }],
      columns: [
        {
          header: 'Timestamp',
          key: 'createdAt',
          width: 18,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        {
          header: 'Actor',
          key: 'actor',
          width: 18,
          format: (r) => r.user?.name || r.actorType,
        },
        { header: 'Action', key: 'action', width: 24 },
        { header: 'Entity Type', key: 'entityType', width: 16 },
        { header: 'Entity ID', key: 'entityId', width: 22 },
      ],
      rows: logs,
      store: settings,
    });
  })
);

router.get(
  '/notifications/export/:format',
  asyncHandler(async (req, res) => {
    const format = parseExportFormat(req.params.format as string);
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const [notifications, settings] = await Promise.all([
      settingsService.listNotifications(limit),
      settingsService.getStoreSettings(),
    ]);

    await sendTableExport(res, {
      format,
      filenameBase: 'zamora-notifications',
      title: 'Customer Notification Logs',
      summaryRows: [{ label: 'Notifications Count', value: String(notifications.length) }],
      columns: [
        {
          header: 'Date',
          key: 'createdAt',
          width: 18,
          format: (r) => exportFmtDateTime(r.createdAt),
        },
        { header: 'Channel', key: 'channel', width: 11 },
        { header: 'Recipient', key: 'recipient', width: 16 },
        { header: 'Event', key: 'eventType', width: 18 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Message', key: 'message', width: 38 },
      ],
      rows: notifications,
      store: settings,
    });
  })
);

export default router;

