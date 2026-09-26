import { Router } from 'express';
import { CallsController } from '../controllers/calls.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/session', authenticate, CallsController.logVideoSession);
router.get('/:consultationId', authenticate, CallsController.getVideoSession);

export default router;
