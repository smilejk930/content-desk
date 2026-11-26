import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import {
  buildEffectivePrimarySourceDomains,
  checkPrimarySourceUrlDomain,
  createSourceSnapshotRequestSchema,
  discoverStep1RequestSchema,
  discoverStep2RequestSchema,
  discoverStep3RequestSchema,
  topicFromCaptureRequestSchema,
  topicYmylConfirmRequestSchema,
  type SourceCandidate,
  type TopicDiscoveryJSON
} from '@content-desk/shared';
import type { WorkerEnv } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { firebaseAuth } from '../middleware/firebase-auth.js';
import { getCaptureById } from '../repositories/captures.repo.js';
import { getCategoryById } from '../repositories/categories.repo.js';
import {
  createTopic,
  createTopicsBatch,
  getExecutionRunById,
  getTopicById,
  getTopicWithVersion,
  listTopics,
  listTopicsWithVersion,
  saveSourceSnapshotAndUpdateTopicOptimistic,
  updateTopicOptimistic,
  updateTopicsBatchOptimistic,
  upsertExecutionRun
} from '../repositories/topics.repo.js';
import {
  fetchGoogleTrendsSeeds,
  fetchNormalizedDatalabScores,
  fetchOptionalSearchAdVolumes,
  searchNaver,
  toSerpSnippets
} from '../services/naver-api.js';
import { checkD1BudgetForNewGeneration } from '../services/quota-ledger.js';
import { collectAndStorePrimarySourceSnapshot } from '../services/source-snapshot.js';
import { assertNonYmylOrThrow, evaluateYmylBatchForKeywords } from '../services/ymyl.js';

const MAX_STEP1_KEYWORDS = 12;
const MAX_STEP3_TOPICS_PER_REQUEST = 10;
export const MAX_SOURCES_PER_TOPIC = 10;

const STEP2_ALLOWED_RUN_STATUSES = new Set([
  'STEP1_SEEDS_DONE',
  'STEP2_DATALAB_DONE',
  'STEP3_SUPPLY_DONE'
]);
const STEP3_ALLOWED_RUN_STATUSES = new Set(['STEP2_DATALAB_DONE', 'STEP3_SUPPLY_DONE']);
const STEP3_ALLOWED_TOPIC_STATUSES = new Set(['DATALAB_SCORED', 'SUPPLY_SCORED', 'READY']);

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

function deriveCaptureKeyword(fieldMemo: string, captions: readonly string[]): string {
  const firstLine = fieldMemo
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.slice(0, 60);
  }
  const firstCaption = captions.map((c) => c.trim()).find((c) => c.length > 0);
  if (firstCaption) {
    return firstCaption.slice(0, 60);
  }
  return '현장 기록';
}

export const topicsRoute = new Hono<WorkerEnv>()
  .get('/', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const categoryId = c.req.query('category_id')?.trim() || undefined;
    const runId = c.req.query('run_id')?.trim() || undefined;
    const status = c.req.query('status')?.trim() || undefined;
    const topics = await listTopics(scope, c.env.DB, { categoryId, runId, status });
    return c.json({ topics }, 200);
  })
  .post(
    '/discover/step1-seeds',
    firebaseAuth,
    sValidator('json', discoverStep1RequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      await checkD1BudgetForNewGeneration(c.env.DB, now);

      const category = await getCategoryById(scope, c.env.DB, body.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (category.discovery_mode !== 'trend_first') {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          '단계별 글감 발굴(step1~step3)은 trend_first 카테고리에서만 실행할 수 있습니다.'
        );
      }

      if (!category.default_media_policy.allowed_content_types.includes(body.content_type)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `선택한 카테고리(${category.display_name})는 ${body.content_type} 형식을 허용하지 않습니다.`
        );
      }

      let googleTrendsStatus: 'ok' | 'cached' | 'backoff_skipped' | 'disabled' | 'error_skipped' =
        'disabled';
      let trendKeywords: string[] = [];
      if (body.include_google_trends) {
        const trendsRes = await fetchGoogleTrendsSeeds(c.env.DB, now);
        googleTrendsStatus = trendsRes.status;
        trendKeywords = trendsRes.keywords;
      }

      const candidateSet = new Set<string>();
      for (const kw of [...body.extra_keywords, ...category.seed_keywords, ...trendKeywords]) {
        const trimmed = kw.trim();
        if (trimmed.length > 0 && candidateSet.size < MAX_STEP1_KEYWORDS) {
          candidateSet.add(trimmed);
        }
      }

      if (candidateSet.size === 0) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          '발굴할 시드 키워드가 없습니다. 카테고리 시드 키워드 또는 추가 키워드를 입력해 주세요.'
        );
      }

      const decisions = await evaluateYmylBatchForKeywords([...candidateSet], {
        db: c.env.DB,
        ownerUid: scope.uid,
        geminiApiKey: c.env.GEMINI_API_KEY,
        now
      });

      const runId = body.run_id?.trim() || `run-${crypto.randomUUID()}`;
      const createdTopics: TopicDiscoveryJSON[] = [];
      const blockedKeywords: Array<{
        keyword: string;
        stage: 'primary' | 'secondary' | 'secondary_error';
        reason: string;
      }> = [];

      for (const decision of decisions) {
        if (decision.status === 'BLOCKED') {
          blockedKeywords.push({
            keyword: decision.keyword,
            stage: decision.stage,
            reason: decision.reason ?? 'YMYL 주제로 차단되었습니다.'
          });
          continue;
        }

        createdTopics.push({
          topic_id: crypto.randomUUID(),
          run_id: runId,
          track: 'category_discovery',
          category_id: category.category_id,
          content_type: body.content_type,
          status: 'DISCOVERED',
          keyword: decision.keyword,
          capture_ids: [],
          sources: [],
          ymyl_status: decision.status,
          ymyl_reason: decision.reason,
          sponsorship: { is_sponsored: false },
          datalab_demand_index: null,
          blog_supply_count: null,
          news_supply_count: null,
          monthly_search_volume: null,
          competition_score: null,
          serp_snippets: [],
          created_at: nowIso
        });
      }

      await upsertExecutionRun(scope, c.env.DB, {
        runId,
        kind: 'topic_discovery',
        status: 'STEP1_SEEDS_DONE',
        state: {
          category_id: category.category_id,
          google_trends_status: googleTrendsStatus,
          topic_count: createdTopics.length,
          blocked_count: blockedKeywords.length
        },
        nowIso
      });

      await createTopicsBatch(scope, c.env.DB, createdTopics, nowIso);

      return c.json(
        {
          run_id: runId,
          category_id: category.category_id,
          google_trends_status: googleTrendsStatus,
          topics: createdTopics,
          blocked_keywords: blockedKeywords
        },
        201
      );
    }
  )
  .post(
    '/discover/step2-datalab',
    firebaseAuth,
    sValidator('json', discoverStep2RequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      const [executionRun, runTopicsWithVersion] = await Promise.all([
        getExecutionRunById(scope, c.env.DB, body.run_id),
        listTopicsWithVersion(scope, c.env.DB, { runId: body.run_id, limit: 50 })
      ]);

      const targetItems = body.topic_ids?.length
        ? runTopicsWithVersion.filter((item) => body.topic_ids!.includes(item.topic.topic_id))
        : runTopicsWithVersion;

      if (targetItems.length === 0) {
        throw new AppError(404, 'NOT_FOUND', '대상 실행(run_id)의 글감 후보를 찾을 수 없습니다.');
      }

      // 필수 2 가드: track === category_discovery, discovery_mode === trend_first, Step 1 완료 실행 확인
      if (targetItems.some((item) => item.topic.track !== 'category_discovery')) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'category_discovery 트랙(트렌드 발굴) 글감만 데이터랩 2단계를 실행할 수 있습니다.'
        );
      }

      const categoryIds = new Set(targetItems.map((item) => item.topic.category_id));
      if (categoryIds.size !== 1) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '하나의 실행(run_id)에 서로 다른 카테고리의 글감이 섞여 있어 2단계를 실행할 수 없습니다.'
        );
      }

      const category = await getCategoryById(scope, c.env.DB, targetItems[0]!.topic.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (category.discovery_mode !== 'trend_first') {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'trend_first 모드의 카테고리에서만 데이터랩 2단계를 실행할 수 있습니다.'
        );
      }

      if (
        !executionRun ||
        executionRun.kind !== 'topic_discovery' ||
        !STEP2_ALLOWED_RUN_STATUSES.has(executionRun.status)
      ) {
        throw new AppError(
          409,
          'CONFLICT',
          '1단계(step1-seeds)가 완료된 글감 발굴 실행(run_id)에 대해서만 2단계(step2-datalab)를 실행할 수 있습니다.'
        );
      }

      const anchorKeyword = category.datalab_anchor_keyword?.trim();
      if (!anchorKeyword) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '데이터랩 정규화를 위한 datalab_anchor_keyword가 카테고리에 설정되어 있지 않습니다.'
        );
      }

      const datalabResult = await fetchNormalizedDatalabScores(
        c.env,
        scope.uid,
        anchorKeyword,
        targetItems.map((item) => item.topic.keyword),
        now
      );

      const updates = targetItems.map(({ topic, updatedAt }) => ({
        topic: {
          ...topic,
          datalab_demand_index:
            datalabResult.scores.get(topic.keyword) ?? topic.datalab_demand_index,
          status: topic.status === 'READY' ? ('READY' as const) : ('DATALAB_SCORED' as const)
        },
        expectedUpdatedAt: updatedAt
      }));

      const ok = await updateTopicsBatchOptimistic(scope, c.env.DB, updates, nowIso);
      if (!ok) {
        throw new AppError(
          409,
          'CONFLICT',
          '글감 상태가 동시 요청으로 변경되어 2단계 결과를 저장할 수 없습니다. 다시 시도해 주세요.'
        );
      }

      await upsertExecutionRun(scope, c.env.DB, {
        runId: body.run_id,
        kind: 'topic_discovery',
        status: 'STEP2_DATALAB_DONE',
        state: {
          category_id: category.category_id,
          cache_hits: datalabResult.cacheHits,
          api_calls: datalabResult.apiCalls
        },
        nowIso
      });

      return c.json(
        {
          run_id: body.run_id,
          cache_hits: datalabResult.cacheHits,
          api_calls: datalabResult.apiCalls,
          topics: updates.map((u) => u.topic)
        },
        200
      );
    }
  )
  .post(
    '/discover/step3-supply',
    firebaseAuth,
    sValidator('json', discoverStep3RequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      const [executionRun, runTopicsWithVersion] = await Promise.all([
        getExecutionRunById(scope, c.env.DB, body.run_id),
        listTopicsWithVersion(scope, c.env.DB, { runId: body.run_id, limit: 50 })
      ]);

      const filtered = body.topic_ids?.length
        ? runTopicsWithVersion.filter((item) => body.topic_ids!.includes(item.topic.topic_id))
        : runTopicsWithVersion;

      if (filtered.length === 0) {
        throw new AppError(404, 'NOT_FOUND', '대상 실행(run_id)의 글감 후보를 찾을 수 없습니다.');
      }

      // 필수 2 가드: track === category_discovery, discovery_mode === trend_first, Step 2(DATALAB_SCORED) 완료 확인
      if (filtered.some((item) => item.topic.track !== 'category_discovery')) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'category_discovery 트랙(트렌드 발굴) 글감만 공급량 3단계를 실행할 수 있습니다.'
        );
      }

      const categoryIds = new Set(filtered.map((item) => item.topic.category_id));
      if (categoryIds.size !== 1) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          '하나의 실행(run_id)에 서로 다른 카테고리의 글감이 섞여 있어 3단계를 실행할 수 없습니다.'
        );
      }

      const category = await getCategoryById(scope, c.env.DB, filtered[0]!.topic.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (category.discovery_mode !== 'trend_first') {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'trend_first 모드의 카테고리에서만 공급량 3단계를 실행할 수 있습니다.'
        );
      }

      if (
        !executionRun ||
        executionRun.kind !== 'topic_discovery' ||
        !STEP3_ALLOWED_RUN_STATUSES.has(executionRun.status) ||
        filtered.some((item) => !STEP3_ALLOWED_TOPIC_STATUSES.has(item.topic.status))
      ) {
        throw new AppError(
          409,
          'CONFLICT',
          '2단계(step2-datalab, DATALAB_SCORED)가 완료된 글감 발굴 실행(run_id)에 대해서만 3단계(step3-supply)를 실행할 수 있습니다.'
        );
      }

      // Workers 외부 호출 50개 한도를 지키기 위해 1회 요청당 최대 10건으로 제한
      const targetItems = filtered.slice(0, MAX_STEP3_TOPICS_PER_REQUEST);

      const searchAd = await fetchOptionalSearchAdVolumes(
        c.env,
        scope.uid,
        targetItems.map((item) => item.topic.keyword),
        now
      );

      const updates: Array<{ topic: TopicDiscoveryJSON; expectedUpdatedAt: string }> = [];
      for (const { topic, updatedAt } of targetItems) {
        const [blogRes, newsRes] = await Promise.all([
          searchNaver(c.env, scope.uid, 'blog', topic.keyword, { display: 5, sort: 'sim', now }),
          searchNaver(c.env, scope.uid, 'news', topic.keyword, { display: 5, sort: 'sim', now })
        ]);

        const normalizedKey = topic.keyword.replace(/\s+/g, '').toLowerCase();
        const monthlyVol = searchAd.used
          ? searchAd.monthlyVolumes.get(normalizedKey) ?? null
          : null;
        const competitionScore =
          monthlyVol !== null
            ? Number((monthlyVol / Math.max(1, blogRes.total)).toFixed(4))
            : null;

        const serpSnippets = [
          ...toSerpSnippets(blogRes.items, 'blog', 5),
          ...toSerpSnippets(newsRes.items, 'news', 5)
        ];

        updates.push({
          topic: {
            ...topic,
            blog_supply_count: blogRes.total,
            news_supply_count: newsRes.total,
            monthly_search_volume: monthlyVol,
            competition_score: competitionScore,
            serp_snippets: serpSnippets,
            status: topic.status === 'READY' ? 'READY' : 'SUPPLY_SCORED'
          },
          expectedUpdatedAt: updatedAt
        });
      }

      const ok = await updateTopicsBatchOptimistic(scope, c.env.DB, updates, nowIso);
      if (!ok) {
        throw new AppError(
          409,
          'CONFLICT',
          '글감 상태가 동시 요청으로 변경되어 3단계 결과를 저장할 수 없습니다. 다시 시도해 주세요.'
        );
      }

      await upsertExecutionRun(scope, c.env.DB, {
        runId: body.run_id,
        kind: 'topic_discovery',
        status: 'STEP3_SUPPLY_DONE',
        state: {
          searchad_used: searchAd.used,
          processed_count: updates.length
        },
        nowIso
      });

      return c.json(
        {
          run_id: body.run_id,
          searchad_used: searchAd.used,
          topics: updates.map((u) => u.topic)
        },
        200
      );
    }
  )
  .post(
    '/from-capture',
    firebaseAuth,
    sValidator('json', topicFromCaptureRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      await checkD1BudgetForNewGeneration(c.env.DB, now);

      const capture = await getCaptureById(scope, c.env.DB, body.capture_id);
      if (!capture) {
        throw new AppError(404, 'NOT_FOUND', '대상 캡처 자산을 찾을 수 없습니다.');
      }

      const category = await getCategoryById(scope, c.env.DB, capture.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      if (!category.default_media_policy.allowed_content_types.includes(capture.content_type)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `선택한 카테고리(${category.display_name})는 ${capture.content_type} 형식을 허용하지 않습니다.`
        );
      }

      const captions = capture.photos.map((p) => p.caption).filter((cap) => cap.trim().length > 0);
      const keyword = body.keyword?.trim() || deriveCaptureKeyword(capture.field_memo, captions);

      const ymylRes = await assertNonYmylOrThrow(
        [keyword, capture.field_memo, ...captions].filter((t) => t.trim().length > 0),
        {
          db: c.env.DB,
          ownerUid: scope.uid,
          geminiApiKey: c.env.GEMINI_API_KEY,
          confirmBorderline: body.confirm_borderline,
          now
        }
      );

      let datalabDemandIndex: number | null = null;
      let blogSupplyCount: number | null = null;
      let newsSupplyCount: number | null = null;
      let serpSnippets: TopicDiscoveryJSON['serp_snippets'] = [];

      if (
        capture.content_type === 'experience_review' &&
        c.env.NAVER_CLIENT_ID?.trim() &&
        c.env.NAVER_CLIENT_SECRET?.trim()
      ) {
        if (category.datalab_anchor_keyword) {
          const dl = await fetchNormalizedDatalabScores(
            c.env,
            scope.uid,
            category.datalab_anchor_keyword,
            [keyword],
            now
          );
          datalabDemandIndex = dl.scores.get(keyword) ?? null;
        }
        const [blogRes, newsRes] = await Promise.all([
          searchNaver(c.env, scope.uid, 'blog', keyword, { display: 5, sort: 'sim', now }),
          searchNaver(c.env, scope.uid, 'news', keyword, { display: 5, sort: 'sim', now })
        ]);
        blogSupplyCount = blogRes.total;
        newsSupplyCount = newsRes.total;
        serpSnippets = [
          ...toSerpSnippets(blogRes.items, 'blog', 5),
          ...toSerpSnippets(newsRes.items, 'news', 5)
        ];
      }

      const runId = body.run_id?.trim() || `run-cap-${crypto.randomUUID()}`;
      const topic: TopicDiscoveryJSON = {
        topic_id: crypto.randomUUID(),
        run_id: runId,
        track: capture.content_type === 'vlog' ? 'personal_vlog' : 'category_discovery',
        category_id: category.category_id,
        content_type: capture.content_type,
        status: 'READY',
        keyword,
        capture_ids: [capture.capture_id],
        sources: [],
        ymyl_status: ymylRes.status === 'BORDERLINE_CONFIRMED' ? 'BORDERLINE_CONFIRMED' : 'SAFE',
        ymyl_reason: ymylRes.reason,
        sponsorship: body.sponsorship ?? capture.sponsorship,
        datalab_demand_index: datalabDemandIndex,
        blog_supply_count: blogSupplyCount,
        news_supply_count: newsSupplyCount,
        monthly_search_volume: null,
        competition_score: null,
        serp_snippets: serpSnippets,
        created_at: nowIso
      };

      await createTopic(scope, c.env.DB, topic, nowIso);
      return c.json({ topic }, 201);
    }
  )
  .get('/:id', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const topic = await getTopicById(scope, c.env.DB, c.req.param('id'));
    if (!topic) {
      throw new AppError(404, 'NOT_FOUND', '글감을 찾을 수 없습니다.');
    }
    return c.json({ topic }, 200);
  })
  .post(
    '/:id/ymyl-confirm',
    firebaseAuth,
    sValidator('json', topicYmylConfirmRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const topicId = c.req.param('id');
      const found = await getTopicWithVersion(scope, c.env.DB, topicId);
      if (!found) {
        throw new AppError(404, 'NOT_FOUND', '글감을 찾을 수 없습니다.');
      }

      if (found.topic.ymyl_status === 'BLOCKED') {
        throw new AppError(422, 'YMYL_BLOCKED', '차단된 YMYL 글감은 확인 승인할 수 없습니다.');
      }

      const nowIso = new Date().toISOString();
      const updatedTopic: TopicDiscoveryJSON = {
        ...found.topic,
        ymyl_status:
          found.topic.ymyl_status === 'BORDERLINE_PENDING'
            ? 'BORDERLINE_CONFIRMED'
            : found.topic.ymyl_status
      };

      const saved = await updateTopicOptimistic(scope, c.env.DB, {
        topic: updatedTopic,
        expectedUpdatedAt: found.updatedAt,
        nowIso
      });
      if (!saved) {
        throw new AppError(
          409,
          'CONFLICT',
          '글감 상태가 동시 요청으로 변경되었습니다. 새로고침 후 다시 시도해 주세요.'
        );
      }

      return c.json({ topic: updatedTopic }, 200);
    }
  )
  .get('/:id/sources/candidates', firebaseAuth, async (c) => {
    const scope = c.get('userScope');
    const topic = await getTopicById(scope, c.env.DB, c.req.param('id'));
    if (!topic) {
      throw new AppError(404, 'NOT_FOUND', '글감을 찾을 수 없습니다.');
    }

    const category = await getCategoryById(scope, c.env.DB, topic.category_id);
    if (!category) {
      throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
    }

    const webRes = await searchNaver(c.env, scope.uid, 'webkr', topic.keyword, { display: 20 });
    const allowedDomains = buildEffectivePrimarySourceDomains(category.primary_source_domains);

    const seenUrls = new Set<string>();
    const candidates: SourceCandidate[] = [];

    for (const item of webRes.items) {
      const check = checkPrimarySourceUrlDomain(item.link, category.primary_source_domains);
      if (!check.allowed || !check.hostname || !check.matchedDomain) continue;
      if (seenUrls.has(item.link)) continue;
      seenUrls.add(item.link);

      candidates.push({
        url: item.link,
        title: item.title || item.link,
        description: item.description,
        domain: check.hostname,
        matched_domain: check.matchedDomain
      });
    }

    return c.json(
      {
        topic_id: topic.topic_id,
        allowed_domains: allowedDomains,
        candidates
      },
      200
    );
  })
  .post(
    '/:id/sources/snapshot',
    firebaseAuth,
    sValidator('json', createSourceSnapshotRequestSchema, (result) => {
      if (!result.success) throwValidationError(result.error);
    }),
    async (c) => {
      const scope = c.get('userScope');
      const topicId = c.req.param('id');
      const body = c.req.valid('json');
      const now = new Date();
      const nowIso = now.toISOString();

      const found = await getTopicWithVersion(scope, c.env.DB, topicId);
      if (!found) {
        throw new AppError(404, 'NOT_FOUND', '글감을 찾을 수 없습니다.');
      }

      const { topic, updatedAt } = found;
      if (topic.ymyl_status === 'BLOCKED') {
        throw new AppError(422, 'YMYL_BLOCKED', '차단된 YMYL 글감에는 출처 스냅샷을 저장할 수 없습니다.');
      }

      if (topic.sources.length >= MAX_SOURCES_PER_TOPIC) {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          `글감당 1차 출처 스냅샷은 최대 ${MAX_SOURCES_PER_TOPIC}개까지 저장할 수 있습니다.`
        );
      }

      const category = await getCategoryById(scope, c.env.DB, topic.category_id);
      if (!category) {
        throw new AppError(404, 'NOT_FOUND', '대상 카테고리를 찾을 수 없습니다.');
      }

      const collected = await collectAndStorePrimarySourceSnapshot({
        scope,
        bucket: c.env.MEDIA_BUCKET,
        topicId: topic.topic_id,
        url: body.url,
        ingestChannel: body.ingest_channel,
        categoryAllowedDomains: category.primary_source_domains,
        confirmUnlistedDomain: body.confirm_unlisted_domain,
        now
      });

      const updatedTopic: TopicDiscoveryJSON = {
        ...topic,
        sources: [...topic.sources, collected.snapshotRef],
        status: 'READY'
      };

      try {
        const saved = await saveSourceSnapshotAndUpdateTopicOptimistic(scope, c.env.DB, {
          snapshot: collected.snapshotRef,
          updatedTopic,
          expectedUpdatedAt: updatedAt,
          nowIso
        });

        if (!saved) {
          await c.env.MEDIA_BUCKET.delete(collected.snapshotRef.r2_key).catch(() => undefined);
          throw new AppError(
            409,
            'CONFLICT',
            '글감 상태가 동시 요청으로 변경되어 스냅샷을 반영할 수 없습니다. 다시 시도해 주세요.'
          );
        }
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'CONFLICT')) {
          await c.env.MEDIA_BUCKET.delete(collected.snapshotRef.r2_key).catch(() => undefined);
        }
        throw err;
      }

      return c.json(
        {
          snapshot: {
            ...collected.snapshotRef,
            excerpt: collected.excerpt
          },
          topic: updatedTopic
        },
        201
      );
    }
  );
