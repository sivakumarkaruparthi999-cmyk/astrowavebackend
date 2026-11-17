import { Router } from 'express';
import { AstrologerApplicationsController } from '../controllers/astrologer-applications.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';

const router = Router();

// Public routes for applying & checking application status
router.post('/', AstrologerApplicationsController.submitApplication);
router.post('/apply', AstrologerApplicationsController.submitApplication);
router.get('/status/:applicationId', AstrologerApplicationsController.getApplicationStatus);

// Admin review & verification workflow routes
router.get('/admin', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.listApplications);
router.get('/admin/:id', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.getApplicationDetails);
router.post('/admin/:id/approve', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.approveApplication);
router.post('/admin/:id/reject', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.rejectApplication);
router.post('/admin/:id/under-review', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.markUnderReview);
router.put('/admin/:id', authenticate, requireRole(['admin', 'super_admin']), AstrologerApplicationsController.updateApplication);

export default router;
