import { Router } from 'express';
import { MuhuratController } from '../controllers/muhurat.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validatePagination } from '../middleware/validation.middleware.js';

const router = Router();

router.post('/calculate', MuhuratController.calculate);
router.post('/order', authenticate, MuhuratController.createOrder);
router.post('/orders', authenticate, MuhuratController.createOrder);
router.get('/orders', authenticate, validatePagination, MuhuratController.listOrders);
router.get('/my-orders', authenticate, validatePagination, MuhuratController.listOrders);

export default router;
