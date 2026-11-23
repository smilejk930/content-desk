import { z } from '../zod.js';

export const userRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userStatusSchema = z.enum(['active', 'blocked']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const firebaseUidSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{4,128}$/, {
    error: '유효한 Firebase UID 형식이 아닙니다 (영문·숫자·하이픈·밑줄 4~128자).'
  });

export const adminUserTodayUsageSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'YYYY-MM-DD 형식이어야 합니다.' }),
  totalCalls: z.number().int().min(0),
  byProvider: z.record(z.string(), z.number().int().min(0))
});

export const adminUserItemSchema = z.strictObject({
  uid: firebaseUidSchema,
  label: z.string().min(1).max(60),
  status: userStatusSchema,
  role: userRoleSchema,
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  statusChangedAt: z.iso.datetime().nullable(),
  todayUsage: adminUserTodayUsageSchema
});

export const adminUsersListResponseSchema = z.strictObject({
  windowDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'YYYY-MM-DD 형식이어야 합니다.' }),
  users: z.array(adminUserItemSchema)
});

export const createAdminUserRequestSchema = z.strictObject({
  uid: firebaseUidSchema,
  label: z.string().trim().min(1, { error: '사용자 라벨을 입력해 주세요.' }).max(60)
});

export const updateAdminUserRequestSchema = z
  .strictObject({
    label: z.string().trim().min(1, { error: '사용자 라벨을 입력해 주세요.' }).max(60).optional(),
    status: userStatusSchema.optional()
  })
  .refine((val) => val.label !== undefined || val.status !== undefined, {
    error: '변경할 label 또는 status 중 하나 이상을 입력해 주세요.'
  });

export const adminUserMutationResponseSchema = z.strictObject({
  user: adminUserItemSchema
});

export type AdminUserTodayUsage = z.infer<typeof adminUserTodayUsageSchema>;
export type AdminUserItem = z.infer<typeof adminUserItemSchema>;
export type AdminUsersListResponse = z.infer<typeof adminUsersListResponseSchema>;
export type CreateAdminUserRequest = z.infer<typeof createAdminUserRequestSchema>;
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;
export type AdminUserMutationResponse = z.infer<typeof adminUserMutationResponseSchema>;
