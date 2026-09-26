import { Router } from 'express';
import { UsersController } from '../controllers/users.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  validateBody,
  validateUuidParam,
  validatePagination,
  updateProfileSchema,
} from '../middleware/validation.middleware.js';

const router = Router();

router.put('/profile', authenticate, validateBody(updateProfileSchema), UsersController.updateProfile);
router.get('/wallet', authenticate, UsersController.getWallet);
router.get('/kundli', authenticate, UsersController.listSavedKundlis);
router.get('/kundlis', authenticate, UsersController.listSavedKundlis);
router.post('/kundli', authenticate, UsersController.saveKundli);
router.post('/kundlis', authenticate, UsersController.saveKundli);
router.get('/notifications', authenticate, validatePagination, UsersController.getNotifications);
router.put('/notifications/:id/read', authenticate, validateUuidParam('id'), UsersController.markNotificationRead);

export default router;
