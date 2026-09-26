import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  validateBody,
  validateUuidParam,
  validatePagination,
  adminUpdateUserSchema,
  adminVerifyAstrologerSchema,
} from '../middleware/validation.middleware.js';

const router = Router();

// Protect all admin routes with authentication and admin/super_admin role
router.use(authenticate, requireRole(['admin', 'super_admin']));

router.get('/stats', AdminController.getDashboardStats);
router.get('/users', validatePagination, AdminController.listUsers);
router.put('/users/:id', validateUuidParam('id'), validateBody(adminUpdateUserSchema), AdminController.updateUserStatus);
router.get('/astrologers', validatePagination, AdminController.listAstrologers);
router.put('/astrologers/:id/verify', validateUuidParam('id'), validateBody(adminVerifyAstrologerSchema), AdminController.verifyAstrologer);
router.get('/audit-logs', validatePagination, AdminController.listAuditLogs);
router.post('/notifications/broadcast', AdminController.broadcastNotification);

export default router;
