import { Router } from 'express';
import { CallsController } from '../controllers/calls.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/ice-servers', authenticate, CallsController.getIceServers);
router.post('/session', authenticate, CallsController.logCallSession);
router.post('/recordings', authenticate, CallsController.saveRecording);
router.get('/recordings/:consultationId', authenticate, CallsController.getRecording);
router.get('/:consultationId', authenticate, CallsController.getCallSession);

export default router;
