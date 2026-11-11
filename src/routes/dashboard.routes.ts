import { Router } from 'express';
import { asyncHandler } from '../lib/errors';
import { requireOwner } from '../middleware/auth';
import { getDashboardData } from '../services/dashboard.service';

const router = Router();
router.use(requireOwner);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const periodParam = req.query.period as string | undefined;
    const period =
      periodParam === 'weekly' || periodParam === 'monthly' ? periodParam : 'daily';
    const data = await getDashboardData(period);
    res.json(data);
  })
);

export default router;

