import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  authLimiter,
  passwordResetLimiter,
  refreshLimiter,
} from '../middleware/rate-limit.middleware.js';

const router = Router();

router.post('/register', authLimiter, AuthController.register);
router.post('/login', authLimiter, AuthController.login);
router.post('/firebase', authLimiter, AuthController.firebaseAuth);
router.post('/google', authLimiter, AuthController.googleAuth);
router.post('/refresh', refreshLimiter, AuthController.refreshToken);
router.post('/forgot-password', passwordResetLimiter, AuthController.forgotPassword);
router.post('/reset-password', passwordResetLimiter, AuthController.resetPassword);
router.post('/logout', authenticate, AuthController.logout);
router.get('/me', authenticate, AuthController.me);

export default router;
