import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  categoryProfileSchema,
  createCategoryRequestSchema,
  updateCategoryRequestSchema,
  type CategoryProfile
} from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import {
  createCategory,
  deleteCategory,
  getCategoryById,
  listCategories,
  updateCategory
} from '../repositories/categories.repo.js';
import { assertNonYmylOrThrow } from '../services/ymyl.js';

function throwValidationError(
  issues: readonly { message: string; path?: readonly unknown[] }[]
): never {
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

function isForeignKeyConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /FOREIGN KEY constraint failed/i.test(msg);
}

function collectCategoryYmylTexts(input: {
  display_name: string;
  naver_board_name: string;
  datalab_anchor_keyword: string | null;
  seed_keywords: string[];
}): string[] {
  const texts = [input.display_name, input.naver_board_name, ...input.seed_keywords];
  if (input.datalab_anchor_keyword) {
    texts.push(input.datalab_anchor_keyword);
  }
  return texts;
}

export const categoriesRoute = new Hono<WorkerEnv>()
  .get('/', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const categories = await listCategories(scope, c.env.DB);
    return c.json({ categories }, 200);
  })
  .post(
    '/',
    firebaseAuth,
    sValidator('json', createCategoryRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');

      // Phase 3: 1차 키워드 차단 + 2차 Gemini 판정(quota_ledger·usage_daily 연동, 409 경계 확인, 키/한도 불가 시 차단)
      await assertNonYmylOrThrow(collectCategoryYmylTexts(body), {
        db: c.env.DB,
        ownerUid: scope.uid,
        geminiApiKey: c.env.GEMINI_API_KEY,
        confirmBorderline: body.confirm_borderline
      });

      const nowIso = new Date().toISOString();
      const profile: CategoryProfile = {
        category_id: crypto.randomUUID(),
        display_name: body.display_name,
        naver_board_name: body.naver_board_name,
        discovery_mode: body.discovery_mode,
        datalab_anchor_keyword:
          body.discovery_mode === 'none' ? null : body.datalab_anchor_keyword,
        seed_keywords: body.seed_keywords,
        primary_source_domains: body.primary_source_domains,
        default_media_policy: body.default_media_policy,
        default_visibility: body.default_visibility,
        created_at: nowIso,
        updated_at: nowIso
      };

      try {
        const created = await createCategory(scope, c.env.DB, profile);
        return c.json({ category: created }, 201);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(409, 'CONFLICT', '이미 같은 이름의 카테고리가 존재합니다.');
        }
        throw err;
      }
    }
  )
  .patch(
    '/:id',
    firebaseAuth,
    sValidator('json', updateCategoryRequestSchema, (result) => {
      if (!result.success) {
        throwValidationError(result.error);
      }
    }),
    async (c) => {
      const scope = c.get('userScope');
      const categoryId = c.req.param('id');
      const existing = await getCategoryById(scope, c.env.DB, categoryId);
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', '카테고리를 찾을 수 없습니다.');
      }

      const body = c.req.valid('json');
      const nextDiscoveryMode = body.discovery_mode ?? existing.discovery_mode;
      const mergedCandidate: CategoryProfile = {
        ...existing,
        display_name: body.display_name ?? existing.display_name,
        naver_board_name: body.naver_board_name ?? existing.naver_board_name,
        discovery_mode: nextDiscoveryMode,
        datalab_anchor_keyword:
          body.datalab_anchor_keyword !== undefined
            ? nextDiscoveryMode === 'none'
              ? null
              : body.datalab_anchor_keyword
            : nextDiscoveryMode === 'none'
              ? null
              : existing.datalab_anchor_keyword,
        seed_keywords: body.seed_keywords ?? existing.seed_keywords,
        primary_source_domains: body.primary_source_domains ?? existing.primary_source_domains,
        default_media_policy: body.default_media_policy ?? existing.default_media_policy,
        default_visibility: body.default_visibility ?? existing.default_visibility,
        updated_at: new Date().toISOString()
      };

      const validated = categoryProfileSchema.safeParse(mergedCandidate);
      if (!validated.success) {
        throwValidationError(validated.error.issues);
      }

      // Phase 3: 1차 키워드 차단 + 2차 Gemini 판정(quota_ledger·usage_daily 연동, 409 경계 확인, 키/한도 불가 시 차단)
      await assertNonYmylOrThrow(collectCategoryYmylTexts(validated.data), {
        db: c.env.DB,
        ownerUid: scope.uid,
        geminiApiKey: c.env.GEMINI_API_KEY,
        confirmBorderline: body.confirm_borderline
      });

      try {
        const updated = await updateCategory(scope, c.env.DB, validated.data);
        if (!updated) {
          throw new AppError(404, 'NOT_FOUND', '카테고리를 찾을 수 없습니다.');
        }
        return c.json({ category: updated }, 200);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new AppError(409, 'CONFLICT', '이미 같은 이름의 카테고리가 존재합니다.');
        }
        throw err;
      }
    }
  )
  .delete('/:id', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const categoryId = c.req.param('id');

    try {
      const deleted = await deleteCategory(scope, c.env.DB, categoryId);
      if (!deleted) {
        throw new AppError(404, 'NOT_FOUND', '카테고리를 찾을 수 없습니다.');
      }
      return c.json({ deleted: true as const, category_id: categoryId }, 200);
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        throw new AppError(
          409,
          'CONFLICT',
          '캡처·글감·원고가 연결된 카테고리는 삭제할 수 없습니다.'
        );
      }
      throw err;
    }
  });
