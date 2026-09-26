import { Router } from 'express';
import { PayoutsController } from '../controllers/payouts.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/request', authenticate, requireRole(['astrologer', 'pandit', 'vendor']), PayoutsController.requestPayout);
router.get('/accounts', authenticate, PayoutsController.listAccounts);
router.post('/accounts', authenticate, PayoutsController.addAccount);
router.post('/process', authenticate, requireRole(['admin', 'finance']), PayoutsController.processPayout);

export default router;
