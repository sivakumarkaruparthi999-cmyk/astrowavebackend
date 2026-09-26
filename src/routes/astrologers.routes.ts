import { Router } from 'express';
import { AstrologersController } from '../controllers/astrologers.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { validateUuidParam, validatePagination } from '../middleware/validation.middleware.js';

const router = Router();

router.get('/', validatePagination, AstrologersController.list);
router.get('/:id', validateUuidParam('id'), AstrologersController.getById);
router.put('/status', authenticate, requireRole(['astrologer']), AstrologersController.updateStatus);
router.get('/me/earnings', authenticate, requireRole(['astrologer']), AstrologersController.getEarnings);
router.post('/documents', authenticate, requireRole(['astrologer']), AstrologersController.uploadDocument);

export default router;
