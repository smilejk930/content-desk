import { z } from '../zod.js';

export const bridgeJobStatusSchema = z.enum([
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'AUTH_REQUIRED',
  'CAPTCHA_DETECTED',
  'RESUME_REQUESTED',
  'SAVED',
  'FAILED',
  'UNKNOWN',
  'CANCELED'
]);

export const bridgeDeviceStatusSchema = z.enum([
  'READY',
  'NAVER_LOGIN_REQUIRED',
  'BUSY',
  'OFFLINE'
]);

export const createBridgeTokenRequestSchema = z.strictObject({
  label: z.string().min(1).max(60)
});

export const createBridgeJobRequestSchema = z.strictObject({
  manuscript_id: z.string().min(1).max(64),
  approved_hash: z.string().length(64)
});

export type BridgeJobStatus = z.infer<typeof bridgeJobStatusSchema>;
export type BridgeDeviceStatus = z.infer<typeof bridgeDeviceStatusSchema>;
