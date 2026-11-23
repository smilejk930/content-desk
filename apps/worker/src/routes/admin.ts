import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  createAdminUserRequestSchema,
  firebaseUidSchema,
  updateAdminUserRequestSchema
} from '@content-desk/shared';
import { parseCsvList, type WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { requireRecentAuth } from '../middleware/recent-auth.js';
import {
  createUser,
  findUserByUid,
  getUsageWindowDates,
  listUsersWithTodayUsage,
  updateUser
} from '../repositories/users.repo.js';

function throwValidationError(issues: readonly { message: string; path?: readonly unknown[] }[]): never {
  const firstMessage = issues[0]?.message ?? '요청 값이 올바르지 않습니다.';
  throw new AppError(400, 'VALIDATION_ERROR', firstMessage, {
    details: {
      issues: issues.map((issue) => ({
        message: issue.message,
        path: issue.path
      }))
    }
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export const adminRoute = new Hono<WorkerEnv>()
  .get('/users', firebaseAuth, requireAdmin, requireRecentAuth, async (c) => {
    const adminUids = parseCsvList(c.env.ADMIN_UIDS);
    const windows = getUsageWindowDates();
    const result = await listUsersWithTodayUsage(c.env.DB, adminUids, windows);
    return c.json(result, 200);
  })
  .post(
    '/users',
    firebaseAuth,
    requireAdmin,
    requireRecentAuth,
    sValidator('json', createAdminUserRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const auth = c.get('auth');
      const body = c.req.valid('json');
      const adminUids = parseCsvList(c.env.ADMIN_UIDS);

      if (adminUids.includes(body.uid)) {
        throw new AppError(
          409,
          'USER_ALREADY_EXISTS',
          '이미 관리자 목록(ADMIN_UIDS)에 등록된 UID입니다.'
        );
      }

      const existing = await findUserByUid(c.env.DB, body.uid);
      if (existing) {
        throw new AppError(409, 'USER_ALREADY_EXISTS', '이미 등록된 사용자 UID입니다.');
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const windows = getUsageWindowDates(now);

      try {
        const user = await createUser(c.env.DB, {
          uid: body.uid,
          label: body.label,
          createdBy: auth.uid,
          nowIso,
          windows
        });
        return c.json({ user }, 201);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(409, 'USER_ALREADY_EXISTS', '이미 등록된 사용자 UID입니다.');
        }
        throw err;
      }
    }
  )
  .patch(
    '/users/:uid',
    firebaseAuth,
    requireAdmin,
    requireRecentAuth,
    sValidator('json', updateAdminUserRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const targetUid = c.req.param('uid');
      const parsedUid = firebaseUidSchema.safeParse(targetUid);
      if (!parsedUid.success) {
        throwValidationError(parsedUid.error.issues);
      }

      const adminUids = parseCsvList(c.env.ADMIN_UIDS);
      if (adminUids.includes(parsedUid.data)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          '관리자(ADMIN_UIDS) 계정은 수정하거나 차단할 수 없습니다.'
        );
      }

      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();
      const windows = getUsageWindowDates(now);

      const updated = await updateUser(c.env.DB, {
        uid: parsedUid.data,
        label: body.label,
        status: body.status,
        nowIso,
        windows
      });

      if (!updated) {
        throw new AppError(404, 'NOT_FOUND', '대상 사용자를 찾을 수 없습니다.');
      }

      return c.json({ user: updated }, 200);
    }
  );
