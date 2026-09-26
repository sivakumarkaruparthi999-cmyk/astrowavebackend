import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOSE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidUuid = (value: string): boolean => {
  return LOOSE_UUID_REGEX.test(value);
};

/**
 * Validate request body against a Zod schema
 */
export const validateBody = (schema: z.ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        res.status(400).json({
          success: false,
          error: `Validation error: ${issues.join('; ')}`,
          details: error.errors,
        });
        return;
      }
      res.status(400).json({ success: false, error: 'Malformed request body' });
    }
  };
};

/**
 * Validate request query against a Zod schema
 */
export const validateQuery = (schema: z.ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.query = await schema.parseAsync(req.query);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        res.status(400).json({
          success: false,
          error: `Query validation error: ${issues.join('; ')}`,
        });
        return;
      }
      res.status(400).json({ success: false, error: 'Malformed query parameters' });
    }
  };
};

/**
 * Validates that specified route params are valid UUIDs
 */
export const validateUuidParam = (...paramNames: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const name of paramNames) {
      const val = req.params[name];
      if (val && !isValidUuid(val)) {
        res.status(400).json({
          success: false,
          error: `Invalid UUID format for parameter: ${name}`,
        });
        return;
      }
    }
    next();
  };
};

/**
 * Validates and normalizes pagination parameters
 */
export const validatePagination = (req: Request, res: Response, next: NextFunction): void => {
  const { page, limit, offset } = req.query;

  if (limit !== undefined) {
    const parsedLimit = Number(limit);
    if (isNaN(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit < 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid pagination: limit must be a positive integer',
      });
      return;
    }
    if (parsedLimit > 100) {
      res.status(400).json({
        success: false,
        error: 'Invalid pagination: limit cannot exceed 100',
      });
      return;
    }
  }

  if (page !== undefined) {
    const parsedPage = Number(page);
    if (isNaN(parsedPage) || !Number.isInteger(parsedPage) || parsedPage < 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid pagination: page must be a positive integer greater than or equal to 1',
      });
      return;
    }
  }

  if (offset !== undefined) {
    const parsedOffset = Number(offset);
    if (isNaN(parsedOffset) || !Number.isInteger(parsedOffset) || parsedOffset < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid pagination: offset must be a non-negative integer',
      });
      return;
    }
  }

  next();
};

// ==========================================
// Strict Schemas for Mass Assignment Defense
// ==========================================

export const consultationCreateSchema = z
  .object({
    userId: z.string().optional(), // ignored by controller; overridden by authenticated req.user.userId
    astrologerId: z.string().refine(isValidUuid, { message: 'Must be a valid UUID' }),
    type: z.enum(['chat', 'call', 'voice', 'video']).default('chat'),
    topic: z.string().max(255).optional(),
    duration: z.number().int().positive().optional(),
    scheduledAt: z.string().datetime().optional(),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    fullName: z.string().min(1).max(100).optional(),
    avatarUrl: z.string().url().max(500).optional(),
    dateOfBirth: z.string().max(50).optional(),
    timeOfBirth: z.string().max(50).optional(),
    placeOfBirth: z.string().max(100).optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    bio: z.string().max(1000).optional(),
  })
  .strict();

export const paymentOrderSchema = z
  .object({
    amount: z.number().positive({ message: 'Amount must be greater than 0' }).max(100000, { message: 'Maximum recharge is 100,000' }),
    currency: z.string().length(3).default('INR'),
    purpose: z.string().max(100).optional(),
    consultationId: z.string().refine(isValidUuid, { message: 'Must be a valid UUID' }).optional(),
    couponCode: z.string().max(50).optional(),
    idempotencyKey: z.string().max(255).optional(),
    description: z.string().max(255).optional(),
  })
  .strict();

export const paymentVerifySchema = z
  .object({
    orderId: z.string().min(1).max(255),
    paymentId: z.string().min(1).max(255),
    signature: z.string().min(1).max(255),
    idempotencyKey: z.string().max(255).optional(),
  })
  .strict();

export const paymentRefundSchema = z
  .object({
    paymentId: z.string().min(1).max(255),
    amount: z.number().positive().optional(),
    reason: z.string().min(1).max(500),
    idempotencyKey: z.string().max(255).optional(),
  })
  .strict();

export const adminUpdateUserSchema = z
  .object({
    status: z.enum(['active', 'blocked', 'suspended']).optional(),
    role: z.enum(['customer', 'astrologer', 'admin', 'super_admin']).optional(),
  })
  .strict();

export const adminVerifyAstrologerSchema = z
  .object({
    isVerified: z.boolean().optional(),
    status: z.enum(['approved', 'rejected', 'pending']).optional(),
  })
  .strict();
