import { Router } from 'express';
import { PoojaController } from '../controllers/pooja.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validatePagination } from '../middleware/validation.middleware.js';

const router = Router();

router.get('/services', validatePagination, PoojaController.listServices);
router.get('/services/:slug', PoojaController.getServiceBySlug);
router.post('/book', authenticate, PoojaController.bookPooja);
router.get('/bookings', authenticate, validatePagination, PoojaController.listUserBookings);
router.get('/my-bookings', authenticate, validatePagination, PoojaController.listUserBookings);

export default router;
