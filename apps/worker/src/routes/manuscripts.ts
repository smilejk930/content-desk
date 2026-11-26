import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  approveManuscriptRequestSchema,
  buildAiImageDisclosure,
  buildFtcDisclosure,
  computeContentHash,
  formatImageMarker,
  generateManuscriptRequestSchema,
  isContentTypeAllowedForDiscoveryMode,
  MAX_AI_PROMPT_EXCERPT_BYTES,
  resolveVerifyRequestSchema,
  updateManuscriptRequestSchema,
  type CapturePhoto,
  type ManuscriptClaim,
  type ManuscriptImageRef,
  type NaverBlogManuscriptBundle
} from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { getCaptureById } from '../repositories/captures.repo.js';
import { getCategoryById } from '../repositories/categories.repo.js';
import {
  approveManuscriptConditional,
  claimManuscriptRunIdAtomic,
  createManuscriptAndCompleteRun,
  getManuscriptById,
  getManuscriptByRunId,
  getOwnManuscriptRun,
  listApprovedManuscriptTextsForNgram,
  listManuscripts,
  releaseFailedManuscriptRun,
  updateManuscriptAndClearApproval
} from '../repositories/manuscripts.repo.js';
import { getTopicById } from '../repositories/topics.repo.js';
import {
  sanitizeHtmlWithWorkersRewriter,
  verifyClaimsAndSanitizeManuscript
} from '../services/claim-verify.js';
import {
  createDefaultLlmAdapter,
  isAiDiagramGenerationAllowed,
  type LlmSourceExcerptInput
} from '../services/llm-adapter.js';
import {
  checkD1BudgetForNewGeneration,
  reserveProviderQuota,
  settleSingleProviderQuota
} from '../services/quota-ledger.js';
import { assertOwnerObjectKey } from '../services/r2-signer.js';
import { truncateTextToUtf8Bytes } from '../services/source-snapshot.js';
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

function countUnresolvedVerify(claims: readonly ManuscriptClaim[], bodyHtml: string): number {
  const claimCount = claims.filter((c) => c.verification_status === 'VERIFY_REQUIRED').length;
  if (claimCount > 0) return claimCount;
  return bodyHtml.includes('[VERIFY]') ? 1 : 0;
}

function stripVerifyMarkersFromHtml(bodyHtml: string): string {
  return bodyHtml
    .replace(/<p>\s*\[VERIFY\][^<]*<\/p>/gi, '')
    .replace(/\s*\[VERIFY\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function collectAllowedSourceUrls(
  topicSources: ReadonlyArray<{ url: string }>,
  claims: readonly ManuscriptClaim[]
): string[] {
  const urls = new Set<string>();
  for (const s of topicSources) {
    if (s.url) urls.add(s.url);
  }
  for (const c of claims) {
    if (c.resolution_url) urls.add(c.resolution_url);
  }
  return [...urls];
}

export const manuscriptsRoute = new Hono<WorkerEnv>()
  .get('/', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const categoryId = c.req.query('category_id')?.trim() || undefined;
    const manuscripts = await listManuscripts(scope, c.env.DB, { categoryId });
    return c.json({ manuscripts }, 200);
  })
  .post(
    '/generate',
    firebaseAuth,
    sValidator('json', generateManuscriptRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      const runId = body.run_id?.trim() || `ms-run-${crypto.randomUUID()}`;

      // 1) 이미 완료된 동일 run_id 원고가 있으면 LLM 호출 없이 즉시 반환
      if (body.run_id) {
        const existingByRun = await getManuscriptByRunId(scope, c.env.DB, runId);
        if (existingByRun) {
          return c.json(
            {
              manuscript: existingByRun.manuscript,
              unresolved_verify_count: existingByRun.unresolved_verify_count,
              content_type: existingByRun.content_type,
              category_id: existingByRun.category_id,
              run_id: existingByRun.run_id,
              reused_existing: true
            },
            200
          );
        }
      }

      // 2) D1 보수 상한(95% 차단) 확인
      await checkD1BudgetForNewGeneration(c.env.DB, now);

      // 3) 소유권 및 카테고리·content_type 허용 조합 검증
      const topic = await getTopicById(scope, c.env.DB, body.topic_id);
      if (!topic) {
        throw new AppError(404, 'NOT_FOUND', '대상 글감을 찾을 수 없습니다.');
      }

      const category = await getCategoryById(scope, c.env.DB, topic.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (
        !isContentTypeAllowedForDiscoveryMode(category.discovery_mode, topic.content_type) ||
        !category.default_media_policy.allowed_content_types.includes(topic.content_type)
      ) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          `카테고리(${category.display_name})의 콘텐츠 형식 정책과 일치하지 않습니다.`
        );
      }

      if (
        (topic.track === 'personal_vlog' && topic.content_type !== 'vlog') ||
        (topic.track === 'category_discovery' && topic.content_type === 'vlog')
      ) {
        throw new AppError(422, 'VALIDATION_ERROR', '트랙과 콘텐츠 형식 조합이 올바르지 않습니다.');
      }

      if (topic.ymyl_status === 'BLOCKED') {
        throw new AppError(422, 'YMYL_BLOCKED', '차단된 YMYL 글감은 원고를 생성할 수 없습니다.');
      }

      if (topic.ymyl_status === 'BORDERLINE_PENDING' && !body.confirm_borderline) {
        throw new AppError(
          409,
          'YMYL_BORDERLINE_CONFIRM_REQUIRED',
          'YMYL 경계 사례 글감입니다. 먼저 경계 사례 확인을 완료해 주세요.',
          {
            details: {
              topic_id: topic.topic_id,
              ymyl_status: topic.ymyl_status,
              reason: topic.ymyl_reason
            }
          }
        );
      }

      // 4) content_type별 필수 근거 및 LLM 전송 동의 검증
      const llmSources: LlmSourceExcerptInput[] = [];
      let fieldMemo: string | null = null;
      const capturePhotos: CapturePhoto[] = [];

      if (topic.content_type === 'explainer') {
        if (topic.sources.length === 0) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'explainer 원고 생성에는 1차 출처 스냅샷이 1건 이상 필요합니다.'
          );
        }

        for (const src of topic.sources) {
          assertOwnerObjectKey(scope, src.r2_key, `snapshots/${topic.topic_id}/`);
          const obj = await c.env.MEDIA_BUCKET.get(src.r2_key);
          if (!obj) {
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              `저장된 1차 출처 스냅샷(${src.domain}) 본문을 R2에서 찾을 수 없습니다.`
            );
          }
          const fullText = await obj.text();
          llmSources.push({
            source_id: src.source_id,
            url: src.url,
            domain: src.domain,
            excerpt: truncateTextToUtf8Bytes(fullText, MAX_AI_PROMPT_EXCERPT_BYTES)
          });
        }
      } else {
        if (topic.capture_ids.length === 0) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `${topic.content_type} 원고 생성에는 실사 사진 또는 현장 메모(CaptureAsset)가 최소 1건 필요합니다.`
          );
        }

        const memoParts: string[] = [];
        for (const capId of topic.capture_ids) {
          const capture = await getCaptureById(scope, c.env.DB, capId);
          if (!capture) {
            throw new AppError(404, 'NOT_FOUND', '연결된 캡처 자산을 찾을 수 없습니다.');
          }
          if (!capture.llm_consent_at) {
            throw new AppError(
              422,
              'LLM_CONSENT_REQUIRED',
              '무료 LLM 제공자 전송 동의가 완료되지 않았습니다. 먼저 캡처 자산의 LLM 전송 동의에 체크해 주세요.',
              { details: { capture_id: capture.capture_id } }
            );
          }
          if (capture.field_memo.trim().length > 0) {
            memoParts.push(capture.field_memo.trim());
          }
          capturePhotos.push(...capture.photos);
        }

        fieldMemo = memoParts.join('\n\n') || null;
        if (capturePhotos.length === 0 && !fieldMemo) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            '실사 사진 또는 현장 메모가 최소 1건 이상 있어야 원고를 생성할 수 있습니다.'
          );
        }
      }

      // 5) 권장 7: LLM 호출 전 execution_runs에 run_id 원자 선점 (동시 경쟁 상태 차단)
      const claimed = await claimManuscriptRunIdAtomic(scope, c.env.DB, {
        runId,
        topicId: topic.topic_id,
        nowIso
      });

      if (!claimed) {
        const existingAfterRace = await getManuscriptByRunId(scope, c.env.DB, runId);
        if (existingAfterRace) {
          return c.json(
            {
              manuscript: existingAfterRace.manuscript,
              unresolved_verify_count: existingAfterRace.unresolved_verify_count,
              content_type: existingAfterRace.content_type,
              category_id: existingAfterRace.category_id,
              run_id: existingAfterRace.run_id,
              reused_existing: true
            },
            200
          );
        }

        const ownRun = await getOwnManuscriptRun(scope, c.env.DB, runId);
        if (ownRun && ownRun.status === 'IN_PROGRESS') {
          throw new AppError(
            409,
            'CONFLICT',
            '동일한 run_id로 원고를 생성 중입니다. 잠시 후 다시 확인해 주세요.'
          );
        }

        throw new AppError(409, 'CONFLICT', '이미 사용 중인 run_id입니다.');
      }

      try {
        // 원고 생성 직전 확정 주제 YMYL 재검증 (design_draft.md §3)
        await assertNonYmylOrThrow(
          [topic.keyword, ...(fieldMemo ? [fieldMemo] : [])],
          {
            db: c.env.DB,
            ownerUid: scope.uid,
            geminiApiKey: c.env.GEMINI_API_KEY,
            confirmBorderline:
              topic.ymyl_status === 'BORDERLINE_CONFIRMED' || body.confirm_borderline === true,
            now
          }
        );

        // 6) 요청 1: LLM 어댑터 초안 생성 (gemini_text 할당량 예약/정산, gemini_image 상한 0 시 이미지 미호출)
        const llmAdapter = createDefaultLlmAdapter(c.env.GEMINI_API_KEY);
        const ftcDisclosure = buildFtcDisclosure(topic.sponsorship);
        const aiDisclosure = buildAiImageDisclosure(false);
        void isAiDiagramGenerationAllowed(c.env.GEMINI_IMAGE_DAILY_CAP);

        const reservation = await reserveProviderQuota(c.env.DB, {
          provider: 'gemini_text',
          amount: 1,
          now
        });

        let actualUsed = 0;
        let draft;
        try {
          draft = await llmAdapter.generateManuscriptDraft({
            keyword: topic.keyword,
            contentType: topic.content_type,
            categoryName: category.display_name,
            naverBoardName: category.naver_board_name,
            sponsorship: topic.sponsorship,
            ftcDisclosure,
            sources: llmSources,
            fieldMemo,
            photos: capturePhotos.map((p, idx) => ({
              seq: idx + 1,
              caption: p.caption || `현장 사진 ${idx + 1}`,
              taken_at: p.taken_at
            }))
          });
          // LLM 응답 성공 이후에만 actualUsed를 1로 누적
          actualUsed = 1;
        } finally {
          await settleSingleProviderQuota(c.env.DB, {
            ownerUid: scope.uid,
            reservation,
            actualUsed,
            d1Reads: 3,
            d1Writes: 1,
            now
          });
        }

        let bodyHtml = draft.body_html;

        if (
          ftcDisclosure &&
          !bodyHtml.includes(ftcDisclosure) &&
          !draft.selected_title.includes(ftcDisclosure)
        ) {
          bodyHtml = `<p><strong>${ftcDisclosure}</strong></p>${bodyHtml}`;
        }

        const images: ManuscriptImageRef[] = capturePhotos.map((photo, idx) => ({
          seq: idx + 1,
          r2_key: photo.r2_key,
          caption: photo.caption.trim() || `현장 사진 ${idx + 1}`,
          is_ai_generated: false
        }));

        for (const img of images) {
          const marker = formatImageMarker(img.seq, img.caption);
          if (!bodyHtml.includes(marker)) {
            bodyHtml = `${bodyHtml}<p>${marker}</p>`;
          }
        }

        // 필수 1(a): generate 단계에서도 LLM 반환 body_html을 저장 전 HTMLRewriter + sanitizeManuscriptHtml 정제
        const allowedUrls = collectAllowedSourceUrls(topic.sources, []);
        const sanitizedDraftHtml = await sanitizeHtmlWithWorkersRewriter(bodyHtml, allowedUrls);
        if (!sanitizedDraftHtml.trim()) {
          throw new AppError(502, 'UPSTREAM_API_ERROR', '정제 후 원고 본문이 비어 있습니다.');
        }

        const initialClaims: ManuscriptClaim[] = draft.claims.map((cItem, idx) => ({
          claim_id: `claim-${idx + 1}`,
          claim: cItem.claim,
          source_id: cItem.source_id,
          quote: cItem.quote,
          verification_status: 'VERIFY_REQUIRED',
          resolution_url: null
        }));

        const contentHash = await computeContentHash({
          selected_title: draft.selected_title,
          body_html: sanitizedDraftHtml,
          images,
          tags: draft.tags,
          sponsorship: topic.sponsorship,
          ftc_disclosure: ftcDisclosure,
          ai_disclosure: aiDisclosure,
          visibility: category.default_visibility,
          naver_board_name: category.naver_board_name
        });

        const manuscriptId = crypto.randomUUID();
        const bundle: NaverBlogManuscriptBundle = {
          manuscript_id: manuscriptId,
          topic_id: topic.topic_id,
          version: 1,
          content_hash: contentHash,
          title_candidates: draft.title_candidates,
          selected_title: draft.selected_title,
          body_html: sanitizedDraftHtml,
          naver_board_name: category.naver_board_name,
          sponsorship: topic.sponsorship,
          ftc_disclosure: ftcDisclosure,
          ai_disclosure: aiDisclosure,
          images,
          tags: draft.tags,
          visibility: category.default_visibility,
          claims: initialClaims,
          ngram_max_similarity: null,
          // 필수 1(b): generate 직후에는 verify-sanitize 미완료 상태(null)로 기록해 바로 승인을 차단
          sanitized_at: null,
          approved_hash: null,
          approved_at: null
        };

        const unresolvedVerifyCount = countUnresolvedVerify(initialClaims, sanitizedDraftHtml);

        try {
          await createManuscriptAndCompleteRun(scope, c.env.DB, {
            manuscript: bundle,
            category_id: category.category_id,
            content_type: topic.content_type,
            run_id: runId,
            unresolved_verify_count: unresolvedVerifyCount,
            created_at: nowIso,
            updated_at: nowIso
          });
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            const existing = await getManuscriptByRunId(scope, c.env.DB, runId);
            if (existing) {
              return c.json(
                {
                  manuscript: existing.manuscript,
                  unresolved_verify_count: existing.unresolved_verify_count,
                  content_type: existing.content_type,
                  category_id: existing.category_id,
                  run_id: existing.run_id,
                  reused_existing: true
                },
                200
              );
            }
            throw new AppError(409, 'CONFLICT', '이미 동일한 run_id의 원고가 존재합니다.');
          }
          throw err;
        }

        return c.json(
          {
            manuscript: bundle,
            unresolved_verify_count: unresolvedVerifyCount,
            content_type: topic.content_type,
            category_id: category.category_id,
            run_id: runId,
            verified: false,
            reused_existing: false
          },
          201
        );
      } catch (err) {
        // 생성 실패 시 선점된 IN_PROGRESS run_id를 정리해 동일 run_id 재시도 허용
        await releaseFailedManuscriptRun(scope, c.env.DB, runId).catch(() => undefined);
        throw err;
      }
    }
  )
  .post('/:id/verify-sanitize', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const manuscriptId = c.req.param('id');
    const record = await getManuscriptById(scope, c.env.DB, manuscriptId);
    if (!record) {
      throw new AppError(404, 'NOT_FOUND', '원고를 찾을 수 없습니다.');
    }

    const topic = await getTopicById(scope, c.env.DB, record.manuscript.topic_id);
    if (!topic) {
      throw new AppError(404, 'NOT_FOUND', '연결된 글감을 찾을 수 없습니다.');
    }

    const sourceTexts = new Map<string, string>();
    for (const src of topic.sources) {
      assertOwnerObjectKey(scope, src.r2_key, `snapshots/${topic.topic_id}/`);
      const obj = await c.env.MEDIA_BUCKET.get(src.r2_key);
      if (obj) {
        sourceTexts.set(src.source_id, await obj.text());
      }
    }

    if (topic.capture_ids.length > 0) {
      const memoChunks: string[] = [];
      for (const capId of topic.capture_ids) {
        const cap = await getCaptureById(scope, c.env.DB, capId);
        if (!cap) continue;
        if (cap.field_memo.trim()) memoChunks.push(cap.field_memo.trim());
        for (const photo of cap.photos) {
          if (photo.caption.trim()) memoChunks.push(photo.caption.trim());
        }
      }
      if (memoChunks.length > 0) {
        const combinedMemo = memoChunks.join('\n');
        sourceTexts.set('capture_memo', combinedMemo);
        for (const capId of topic.capture_ids) {
          sourceTexts.set(capId, combinedMemo);
        }
      }
    }

    const filteredClaims = record.manuscript.claims.filter(
      (cItem) => cItem.claim_id !== 'claim-verify-pending'
    );
    const allowedUrls = collectAllowedSourceUrls(topic.sources, filteredClaims);

    const verified = await verifyClaimsAndSanitizeManuscript({
      bodyHtml: record.manuscript.body_html,
      claims: filteredClaims,
      sourceTexts,
      allowedSourceUrls: allowedUrls,
      contentType: record.content_type
    });

    const nowIso = new Date().toISOString();
    const nextHash = await computeContentHash({
      selected_title: record.manuscript.selected_title,
      body_html: verified.sanitizedHtml,
      images: record.manuscript.images,
      tags: record.manuscript.tags,
      sponsorship: record.manuscript.sponsorship,
      ftc_disclosure: record.manuscript.ftc_disclosure,
      ai_disclosure: record.manuscript.ai_disclosure,
      visibility: record.manuscript.visibility,
      naver_board_name: record.manuscript.naver_board_name
    });

    const updatedBundle: NaverBlogManuscriptBundle = {
      ...record.manuscript,
      body_html: verified.sanitizedHtml,
      claims: verified.claims,
      content_hash: nextHash,
      sanitized_at: nowIso,
      approved_hash: null,
      approved_at: null
    };

    const unresolvedCount = countUnresolvedVerify(verified.claims, verified.sanitizedHtml);

    await updateManuscriptAndClearApproval(scope, c.env.DB, {
      manuscript: updatedBundle,
      unresolvedVerifyCount: unresolvedCount,
      nowIso
    });

    return c.json(
      {
        manuscript: updatedBundle,
        unresolved_verify_count: unresolvedCount,
        verified_claim_count: verified.verifiedClaimCount,
        flagged_claim_count: verified.flaggedClaimCount,
        sanitized: true as const
      },
      200
    );
  })
  .get('/:id', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const manuscriptId = c.req.param('id');
    const record = await getManuscriptById(scope, c.env.DB, manuscriptId);
    if (!record) {
      throw new AppError(404, 'NOT_FOUND', '원고를 찾을 수 없습니다.');
    }

    const topic = await getTopicById(scope, c.env.DB, record.manuscript.topic_id);
    if (!topic) {
      throw new AppError(404, 'NOT_FOUND', '연결된 글감을 찾을 수 없습니다.');
    }

    const pastManuscripts = await listApprovedManuscriptTextsForNgram(
      scope,
      c.env.DB,
      manuscriptId,
      20
    );

    const sourcesWithExcerpt = await Promise.all(
      topic.sources.map(async (src) => {
        assertOwnerObjectKey(scope, src.r2_key, `snapshots/${topic.topic_id}/`);
        const obj = await c.env.MEDIA_BUCKET.get(src.r2_key);
        const text = obj ? await obj.text() : '';
        return {
          ...src,
          excerpt: truncateTextToUtf8Bytes(text, 1024)
        };
      })
    );

    const capturePhotos: CapturePhoto[] = [];
    const memoParts: string[] = [];
    for (const capId of topic.capture_ids) {
      const cap = await getCaptureById(scope, c.env.DB, capId);
      if (!cap) continue;
      capturePhotos.push(...cap.photos);
      if (cap.field_memo.trim()) memoParts.push(cap.field_memo.trim());
    }

    const serpSnippets = (topic.serp_snippets ?? []).map((item, idx) => ({
      id: `serp-${idx + 1}`,
      label: `[${item.source === 'blog' ? '블로그' : '뉴스'}] ${item.title || `스니펫 ${idx + 1}`}`,
      text: `${item.title} ${item.snippet}`.trim()
    }));

    return c.json(
      {
        manuscript: record.manuscript,
        unresolved_verify_count: record.unresolved_verify_count,
        content_type: record.content_type,
        category_id: record.category_id,
        run_id: record.run_id,
        topic,
        comparison_context: {
          past_manuscripts: pastManuscripts,
          serp_snippets: serpSnippets,
          sources: sourcesWithExcerpt,
          capture_photos: capturePhotos,
          capture_memo: memoParts.join('\n\n') || null
        }
      },
      200
    );
  })
  .patch(
    '/:id',
    firebaseAuth,
    sValidator('json', updateManuscriptRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const manuscriptId = c.req.param('id');
      const body = c.req.valid('json');

      const record = await getManuscriptById(scope, c.env.DB, manuscriptId);
      if (!record) {
        throw new AppError(404, 'NOT_FOUND', '원고를 찾을 수 없습니다.');
      }

      const topic = await getTopicById(scope, c.env.DB, record.manuscript.topic_id);
      if (!topic) {
        throw new AppError(404, 'NOT_FOUND', '연결된 글감을 찾을 수 없습니다.');
      }

      const allowedUrls = collectAllowedSourceUrls(topic.sources, record.manuscript.claims);
      const nextBodyHtml =
        body.body_html !== undefined
          ? await sanitizeHtmlWithWorkersRewriter(body.body_html, allowedUrls)
          : record.manuscript.body_html;

      if (!nextBodyHtml.trim()) {
        throw new AppError(400, 'VALIDATION_ERROR', '정제된 원고 본문이 비어 있을 수 없습니다.');
      }

      const nextTitle = body.selected_title ?? record.manuscript.selected_title;
      const nextBoardName = body.naver_board_name ?? record.manuscript.naver_board_name;
      const nextTags = body.tags ?? record.manuscript.tags;
      const nextVisibility = body.visibility ?? record.manuscript.visibility;
      const nextImages = body.images ?? record.manuscript.images;
      const nextNgram =
        body.ngram_max_similarity !== undefined
          ? body.ngram_max_similarity
          : record.manuscript.ngram_max_similarity;

      const nextHash = await computeContentHash({
        selected_title: nextTitle,
        body_html: nextBodyHtml,
        images: nextImages,
        tags: nextTags,
        sponsorship: record.manuscript.sponsorship,
        ftc_disclosure: record.manuscript.ftc_disclosure,
        ai_disclosure: record.manuscript.ai_disclosure,
        visibility: nextVisibility,
        naver_board_name: nextBoardName
      });

      const nowIso = new Date().toISOString();
      const updatedBundle: NaverBlogManuscriptBundle = {
        ...record.manuscript,
        version: record.manuscript.version + 1,
        selected_title: nextTitle,
        body_html: nextBodyHtml,
        naver_board_name: nextBoardName,
        tags: nextTags,
        visibility: nextVisibility,
        images: nextImages,
        ngram_max_similarity: nextNgram,
        sanitized_at: nowIso,
        content_hash: nextHash,
        approved_hash: null,
        approved_at: null
      };

      const unresolvedCount = countUnresolvedVerify(updatedBundle.claims, updatedBundle.body_html);

      await updateManuscriptAndClearApproval(scope, c.env.DB, {
        manuscript: updatedBundle,
        unresolvedVerifyCount: unresolvedCount,
        nowIso
      });

      return c.json(
        {
          manuscript: updatedBundle,
          unresolved_verify_count: unresolvedCount,
          content_type: record.content_type,
          category_id: record.category_id,
          run_id: record.run_id
        },
        200
      );
    }
  )
  .post(
    '/:id/resolve-verify',
    firebaseAuth,
    sValidator('json', resolveVerifyRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const manuscriptId = c.req.param('id');
      const body = c.req.valid('json');

      const record = await getManuscriptById(scope, c.env.DB, manuscriptId);
      if (!record) {
        throw new AppError(404, 'NOT_FOUND', '원고를 찾을 수 없습니다.');
      }

      const targetIdx = record.manuscript.claims.findIndex((item) => item.claim_id === body.claim_id);
      if (targetIdx === -1) {
        throw new AppError(404, 'NOT_FOUND', '해당 검증 주장(claim_id)을 찾을 수 없습니다.');
      }

      if (body.resolution_url) {
        const parsed = new URL(body.resolution_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new AppError(400, 'VALIDATION_ERROR', '출처 URL은 http 또는 https만 허용됩니다.');
        }
      }

      const targetClaim = record.manuscript.claims[targetIdx]!;
      let nextClaims: ManuscriptClaim[];
      let nextBodyHtml = record.manuscript.body_html;

      if (body.action === 'remove_claim') {
        nextClaims = record.manuscript.claims.filter((item) => item.claim_id !== body.claim_id);
        if (targetClaim.claim.length >= 4 && nextBodyHtml.includes(`${targetClaim.claim} [VERIFY]`)) {
          nextBodyHtml = nextBodyHtml.replace(`${targetClaim.claim} [VERIFY]`, '');
        }
      } else if (body.action === 'edit_claim') {
        const editedText = body.updated_claim_text!;
        nextClaims = record.manuscript.claims.map((item) =>
          item.claim_id === body.claim_id
            ? {
                ...item,
                claim: editedText,
                verification_status: 'RESOLVED_BY_OWNER' as const,
                resolution_url: body.resolution_url ?? item.resolution_url
              }
            : item
        );
        if (targetClaim.claim.length >= 4 && nextBodyHtml.includes(`${targetClaim.claim} [VERIFY]`)) {
          nextBodyHtml = nextBodyHtml.replace(`${targetClaim.claim} [VERIFY]`, editedText);
        }
      } else {
        nextClaims = record.manuscript.claims.map((item) =>
          item.claim_id === body.claim_id
            ? {
                ...item,
                verification_status: 'RESOLVED_BY_OWNER' as const,
                resolution_url: body.resolution_url!
              }
            : item
        );
        if (targetClaim.claim.length >= 4 && nextBodyHtml.includes(`${targetClaim.claim} [VERIFY]`)) {
          nextBodyHtml = nextBodyHtml.replace(`${targetClaim.claim} [VERIFY]`, targetClaim.claim);
        }
      }

      const remainingUnverifiedClaims = nextClaims.filter(
        (item) => item.verification_status === 'VERIFY_REQUIRED'
      ).length;
      if (remainingUnverifiedClaims === 0) {
        nextBodyHtml = stripVerifyMarkersFromHtml(nextBodyHtml);
      }

      const topic = await getTopicById(scope, c.env.DB, record.manuscript.topic_id);
      const allowedUrls = collectAllowedSourceUrls(topic?.sources ?? [], nextClaims);
      nextBodyHtml = await sanitizeHtmlWithWorkersRewriter(nextBodyHtml, allowedUrls);

      const nextHash = await computeContentHash({
        selected_title: record.manuscript.selected_title,
        body_html: nextBodyHtml,
        images: record.manuscript.images,
        tags: record.manuscript.tags,
        sponsorship: record.manuscript.sponsorship,
        ftc_disclosure: record.manuscript.ftc_disclosure,
        ai_disclosure: record.manuscript.ai_disclosure,
        visibility: record.manuscript.visibility,
        naver_board_name: record.manuscript.naver_board_name
      });

      const nowIso = new Date().toISOString();
      const updatedBundle: NaverBlogManuscriptBundle = {
        ...record.manuscript,
        version: record.manuscript.version + 1,
        body_html: nextBodyHtml,
        claims: nextClaims,
        sanitized_at: nowIso,
        content_hash: nextHash,
        approved_hash: null,
        approved_at: null
      };

      const unresolvedCount = countUnresolvedVerify(nextClaims, nextBodyHtml);

      await updateManuscriptAndClearApproval(scope, c.env.DB, {
        manuscript: updatedBundle,
        unresolvedVerifyCount: unresolvedCount,
        nowIso
      });

      return c.json(
        {
          manuscript: updatedBundle,
          unresolved_verify_count: unresolvedCount,
          content_type: record.content_type,
          category_id: record.category_id,
          run_id: record.run_id
        },
        200
      );
    }
  )
  .post(
    '/:id/approve',
    firebaseAuth,
    sValidator('json', approveManuscriptRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const manuscriptId = c.req.param('id');
      const body = c.req.valid('json');

      const record = await getManuscriptById(scope, c.env.DB, manuscriptId);
      if (!record) {
        throw new AppError(404, 'NOT_FOUND', '원고를 찾을 수 없습니다.');
      }

      // 필수 1(b): 검증·정제(verify-sanitize) 단계 미완료(sanitized_at === null) 시 승인 차단
      if (!record.manuscript.sanitized_at) {
        throw new AppError(
          422,
          'VERIFY_REQUIRED',
          '원고 대조·정제(verify-sanitize) 단계를 먼저 완료해야 승인할 수 있습니다.',
          {
            details: { sanitized_at: null }
          }
        );
      }

      if (record.manuscript.content_hash !== body.content_hash) {
        throw new AppError(
          409,
          'HASH_MISMATCH',
          '원고가 수정되어 승인 대상 해시(content_hash)가 일치하지 않습니다. 최신 원고를 다시 검토해 주세요.',
          {
            details: {
              expected_hash: record.manuscript.content_hash,
              provided_hash: body.content_hash
            }
          }
        );
      }

      const unresolvedCount = countUnresolvedVerify(
        record.manuscript.claims,
        record.manuscript.body_html
      );
      if (unresolvedCount > 0 || record.manuscript.body_html.includes('[VERIFY]')) {
        throw new AppError(
          422,
          'VERIFY_UNRESOLVED',
          `미해소 [VERIFY] 항목이 ${Math.max(1, unresolvedCount)}건 남아 있어 승인할 수 없습니다.`,
          {
            details: {
              unresolved_verify_count: Math.max(1, unresolvedCount)
            }
          }
        );
      }

      if (record.manuscript.sponsorship.is_sponsored) {
        const ftc = record.manuscript.ftc_disclosure?.trim() ?? '';
        if (
          !ftc ||
          (!record.manuscript.selected_title.includes(ftc) &&
            !record.manuscript.body_html.includes(ftc))
        ) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            '협찬 원고는 공정위 경제적 이해관계 문구가 제목 또는 본문 첫머리에 포함되어야 승인할 수 있습니다.'
          );
        }
      }

      const nowIso = new Date().toISOString();
      const approvedBundle: NaverBlogManuscriptBundle = {
        ...record.manuscript,
        ngram_max_similarity:
          body.ngram_max_similarity !== undefined
            ? body.ngram_max_similarity
            : record.manuscript.ngram_max_similarity,
        approved_hash: body.content_hash,
        approved_at: nowIso
      };

      const approved = await approveManuscriptConditional(scope, c.env.DB, {
        manuscriptId,
        expectedHash: body.content_hash,
        approvedAtIso: nowIso,
        updatedBundle: approvedBundle
      });

      if (!approved) {
        throw new AppError(
          409,
          'HASH_MISMATCH',
          '승인 처리 중 원고 상태가 변경되었습니다. 최신 버전을 다시 확인해 주세요.'
        );
      }

      return c.json(
        {
          manuscript: approvedBundle,
          unresolved_verify_count: 0,
          content_type: record.content_type,
          category_id: record.category_id,
          run_id: record.run_id
        },
        200
      );
    }
  );
