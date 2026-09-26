import { Router } from 'express';
import { PaymentsController } from '../controllers/payments.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  validateBody,
  validatePagination,
  paymentOrderSchema,
  paymentVerifySchema,
  paymentRefundSchema,
} from '../middleware/validation.middleware.js';

const router = Router();

router.post('/create-order', authenticate, validateBody(paymentOrderSchema), PaymentsController.createOrder);

router.post('/verify', authenticate, validateBody(paymentVerifySchema), PaymentsController.verifyPayment);

router.post('/webhook', PaymentsController.webhook);
router.post('/webhook/razorpay', PaymentsController.webhook);

router.get('/history', authenticate, validatePagination, PaymentsController.getHistory);
router.post(
  '/refund',
  authenticate,
  requireRole(['admin', 'super_admin', 'finance']),
  validateBody(paymentRefundSchema),
  PaymentsController.refund
);

export default router;
