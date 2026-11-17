import { Router } from 'express';
import { ConsultationsController } from '../controllers/consultations.controller.js';
import { CallsController } from '../controllers/calls.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  validateBody,
  validateUuidParam,
  validatePagination,
  consultationCreateSchema,
} from '../middleware/validation.middleware.js';

const router = Router();

router.post('/', authenticate, validateBody(consultationCreateSchema), ConsultationsController.create);
router.post('/create', authenticate, validateBody(consultationCreateSchema), ConsultationsController.create);
router.post('/request', authenticate, validateBody(consultationCreateSchema), ConsultationsController.create);
router.post('/:id/accept', authenticate, validateUuidParam('id'), ConsultationsController.accept);
router.post('/:id/start', authenticate, validateUuidParam('id'), ConsultationsController.start);
router.post('/:id/end', authenticate, validateUuidParam('id'), ConsultationsController.end);
router.post('/:id/recording', authenticate, validateUuidParam('id'), CallsController.saveRecording);
router.get('/:id/recording', authenticate, validateUuidParam('id'), CallsController.getRecording);
router.get('/history', authenticate, validatePagination, ConsultationsController.listUserHistory);
router.get('/:id', authenticate, validateUuidParam('id'), ConsultationsController.getById);

export default router;
