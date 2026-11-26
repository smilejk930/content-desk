import { z } from '../zod.js';

export const API_ERROR_CODES = [
  'USER_NOT_REGISTERED',
  'USER_BLOCKED',
  'ADMIN_ONLY',
  'USER_ALREADY_EXISTS',
  'TOKEN_INVALID',
  'SESSION_EXPIRED',
  'REAUTH_REQUIRED',
  'VERIFY_REQUIRED',
  'VERIFY_UNRESOLVED',
  'HASH_MISMATCH',
  'LLM_CONSENT_REQUIRED',
  'QUOTA_EXCEEDED',
  'D1_DAILY_LIMIT_EXCEEDED',
  'YMYL_BLOCKED',
  'YMYL_BORDERLINE_CONFIRM_REQUIRED',
  'YMYL_SECONDARY_UNAVAILABLE',
  'SOURCE_DOMAIN_CONFIRM_REQUIRED',
  'SSRF_BLOCKED',
  'ROBOTS_DISALLOWED',
  'UPSTREAM_API_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR'
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    reset_at: z.iso.datetime().optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

export type ApiErrorPayload = z.infer<typeof apiErrorSchema>;
