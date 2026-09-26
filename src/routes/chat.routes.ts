import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { uploadMiddleware } from '../services/storage.service.js';
import { validateUuidParam, validatePagination } from '../middleware/validation.middleware.js';

const router = Router();

router.get('/messages/:consultationId', authenticate, validateUuidParam('consultationId'), validatePagination, ChatController.listMessages);
router.post('/messages', authenticate, ChatController.sendMessage);
router.post('/send', authenticate, ChatController.sendMessage);
router.post('/upload', authenticate, uploadMiddleware.single('file'), ChatController.uploadMedia);

export default router;
