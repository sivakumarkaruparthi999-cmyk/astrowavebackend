import { Router } from 'express';
import { ConsultationsController } from '../controllers/consultations.controller.js';
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
router.get('/history', authenticate, validatePagination, ConsultationsController.listUserHistory);
router.get('/:id', authenticate, validateUuidParam('id'), ConsultationsController.getById);

export default router;
