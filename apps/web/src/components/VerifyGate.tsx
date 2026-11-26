import { useState } from 'react';
import type {
  ManuscriptClaim,
  NaverBlogManuscriptBundle,
  NgramEvaluationResult,
  PrimarySourceRef,
  ResolveVerifyRequest
} from '@content-desk/shared';
import { StatusBadge } from './StatusBadge';

export interface VerifyGateProps {
  manuscript: NaverBlogManuscriptBundle;
  unresolvedVerifyCount: number;
  sources: ReadonlyArray<PrimarySourceRef & { excerpt: string }>;
  ngramResult: NgramEvaluationResult | null;
  isNgramLoading: boolean;
  isResolving: boolean;
  isApproving: boolean;
  onResolveClaim: (input: ResolveVerifyRequest) => void;
  onApprove: () => void;
}

export function VerifyGate({
  manuscript,
  unresolvedVerifyCount,
  sources,
  ngramResult,
  isNgramLoading,
  isResolving,
  isApproving,
  onResolveClaim,
  onApprove
}: VerifyGateProps) {
  const [urlInputs, setUrlInputs] = useState<Record<string, string>>({});
  const [editInputs, setEditInputs] = useState<Record<string, string>>({});

  const hasVerifyTokenInBody = manuscript.body_html.includes('[VERIFY]');
  const unverifiedClaims = manuscript.claims.filter(
    (claim) => claim.verification_status === 'VERIFY_REQUIRED'
  );
  const effectiveUnresolved = Math.max(
    unresolvedVerifyCount,
    unverifiedClaims.length,
    hasVerifyTokenInBody ? 1 : 0
  );

  const isApprovedForCurrentHash =
    manuscript.approved_hash !== null && manuscript.approved_hash === manuscript.content_hash;
  const ftcMissing =
    manuscript.sponsorship.is_sponsored &&
    (!manuscript.ftc_disclosure ||
      (!manuscript.selected_title.includes(manuscript.ftc_disclosure) &&
        !manuscript.body_html.includes(manuscript.ftc_disclosure)));

  const canApprove =
    effectiveUnresolved === 0 && !ftcMissing && !isApprovedForCurrentHash && !isApproving;

  const renderClaimActions = (claim: ManuscriptClaim) => {
    const urlVal = urlInputs[claim.claim_id] ?? '';
    const editVal = editInputs[claim.claim_id] ?? claim.claim;

    return (
      <div className="mt-3 flex flex-col gap-2 rounded-lg bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="url"
            value={urlVal}
            onChange={(e) =>
              setUrlInputs((prev) => ({ ...prev, [claim.claim_id]: e.target.value }))
            }
            placeholder="확인한 공식 출처 URL (https://...)"
            aria-label={`주장 ${claim.claim_id} 확인 출처 URL`}
            className="min-h-[44px] min-w-[220px] flex-1 rounded-lg border border-ink/20 bg-surface px-3 text-base text-ink focus:border-cta focus:outline-none"
          />
          <button
            type="button"
            disabled={isResolving || !urlVal.trim()}
            onClick={() =>
              onResolveClaim({
                claim_id: claim.claim_id,
                action: 'confirm_with_url',
                resolution_url: urlVal.trim()
              })
            }
            className="pill-btn bg-cta px-4 text-sm font-semibold text-ink-inverse disabled:opacity-50"
          >
            출처 확인 해소
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={editVal}
            onChange={(e) =>
              setEditInputs((prev) => ({ ...prev, [claim.claim_id]: e.target.value }))
            }
            aria-label={`주장 ${claim.claim_id} 수정 문장`}
            className="min-h-[44px] min-w-[220px] flex-1 rounded-lg border border-ink/20 bg-surface px-3 text-base text-ink focus:border-cta focus:outline-none"
          />
          <button
            type="button"
            disabled={isResolving || !editVal.trim()}
            onClick={() =>
              onResolveClaim({
                claim_id: claim.claim_id,
                action: 'edit_claim',
                updated_claim_text: editVal.trim()
              })
            }
            className="pill-btn border border-cta bg-surface px-4 text-sm font-semibold text-cta disabled:opacity-50"
          >
            문장 수정 해소
          </button>
          <button
            type="button"
            disabled={isResolving}
            onClick={() =>
              onResolveClaim({
                claim_id: claim.claim_id,
                action: 'remove_claim'
              })
            }
            className="pill-btn border border-danger/40 bg-danger-bg px-4 text-sm font-semibold text-danger disabled:opacity-50"
          >
            주장 삭제
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label="원고 검증 게이트"
      className="card-surface flex flex-col gap-4 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-brand">검증 게이트 및 승인</h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            미해소 [VERIFY] 항목이 1건이라도 남아 있으면 원고 승인이 차단됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manuscript.sponsorship.is_sponsored && (
            <StatusBadge tone="sponsored" icon="★" label="협찬 · 공정위 표시" />
          )}
          {isApprovedForCurrentHash ? (
            <StatusBadge tone="success" icon="✓" label="승인 완료" />
          ) : effectiveUnresolved > 0 ? (
            <StatusBadge
              tone="warning"
              icon="!"
              label={`[VERIFY] 미해소 ${effectiveUnresolved}건`}
            />
          ) : (
            <StatusBadge tone="neutral" icon="•" label="승인 가능" />
          )}
        </div>
      </div>

      {/* 1. 공정위 / AI 활용 표시 확인 */}
      <div className="rounded-xl bg-surface-subtle p-4 text-sm">
        <p className="font-semibold text-ink">표시 의무 점검</p>
        <ul className="mt-2 flex flex-col gap-1.5 text-xs text-ink-soft">
          <li>
            공정위 경제적 이해관계 표시:{' '}
            {manuscript.sponsorship.is_sponsored ? (
              ftcMissing ? (
                <strong className="text-danger">누락됨 — 본문 첫머리 또는 제목에 삽입 필요</strong>
              ) : (
                <strong className="text-brand">{manuscript.ftc_disclosure}</strong>
              )
            ) : (
              '비협찬 원고 (해당 없음)'
            )}
          </li>
          <li>
            AI 도식 이미지 표시:{' '}
            {manuscript.ai_disclosure ?? 'AI 생성 도식 없음 (0원 무료 티어 정책 준수)'}
          </li>
          <li>
            현재 원고 해시(v{manuscript.version}):{' '}
            <code className="font-mono">{manuscript.content_hash.slice(0, 16)}...</code>
          </li>
        </ul>
      </div>

      {/* 2. 브라우저 문자 3-gram 유사도 검사 결과 */}
      <div className="rounded-xl bg-surface-subtle p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-ink">
            브라우저 문자 3-gram 유사도 대조 (기준 30% 이상 경고)
          </p>
          {isNgramLoading ? (
            <StatusBadge tone="neutral" icon="…" label="계산 중" />
          ) : ngramResult ? (
            <StatusBadge
              tone={ngramResult.warning ? 'warning' : 'success'}
              icon={ngramResult.warning ? '!' : '✓'}
              label={`최대 ${(ngramResult.maxSimilarity * 100).toFixed(1)}%`}
            />
          ) : (
            <StatusBadge tone="neutral" icon="•" label="비교 대상 없음" />
          )}
        </div>

        {ngramResult?.warning && (
          <p role="alert" className="mt-2 rounded-lg bg-warning px-3 py-2 text-xs font-medium text-warning-ink">
            문자 3-gram 유사도가 30% 이상({(ngramResult.maxSimilarity * 100).toFixed(1)}%)으로
            감지되었습니다. 기존 승인 글 또는 상위 검색 결과와 표현이 겹치지 않도록 문장을 다듬어
            주세요.
          </p>
        )}

        {ngramResult && ngramResult.matches.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-soft">
            {ngramResult.matches.slice(0, 5).map((match) => (
              <li key={match.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  [{match.kind === 'past_manuscript' ? '과거 승인본' : 'SERP 스니펫'}] {match.label}
                </span>
                <span className={match.warning ? 'font-semibold text-danger' : 'font-mono'}>
                  {(match.similarity * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 3. 사실 주장 및 [VERIFY] 해소 목록 (외부 인용구는 HTML이 아닌 순수 텍스트 표시) */}
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-ink">
          주장–출처 대조 항목 ({manuscript.claims.length}건)
        </p>

        {manuscript.claims.length === 0 ? (
          <p className="rounded-xl bg-surface-subtle p-4 text-xs text-ink-soft">
            등록된 사실 주장 항목이 없습니다.
          </p>
        ) : (
          manuscript.claims.map((claim) => {
            const needsVerify = claim.verification_status === 'VERIFY_REQUIRED';
            return (
              <article
                key={claim.claim_id}
                data-testid={`claim-row-${claim.claim_id}`}
                className={`rounded-xl border p-4 ${
                  needsVerify
                    ? 'border-warning bg-canvas'
                    : 'border-ink/10 bg-surface-subtle'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{claim.claim}</p>
                  <StatusBadge
                    tone={needsVerify ? 'warning' : 'success'}
                    icon={needsVerify ? '!' : '✓'}
                    label={
                      claim.verification_status === 'VERIFY_REQUIRED'
                        ? '[VERIFY] 확인 필요'
                        : claim.verification_status === 'RESOLVED_BY_OWNER'
                          ? '작성자 해소 완료'
                          : '출처 대조 통과'
                    }
                  />
                </div>

                {claim.quote && (
                  <p className="mt-2 rounded-lg bg-surface p-2.5 text-xs text-ink-soft">
                    원문 인용구(텍스트 전용): {claim.quote}
                  </p>
                )}

                {claim.resolution_url && (
                  <p className="mt-1.5 break-all text-xs text-brand">
                    확인 출처 URL: {claim.resolution_url}
                  </p>
                )}

                {needsVerify && renderClaimActions(claim)}
              </article>
            );
          })
        )}
      </div>

      {/* 4. 1차 출처 URL 및 본문 발췌 (텍스트 전용) */}
      {sources.length > 0 && (
        <div className="rounded-xl bg-surface-subtle p-4">
          <p className="text-sm font-semibold text-ink">연결된 1차 출처 스냅샷 ({sources.length}건)</p>
          <ul className="mt-2 flex flex-col gap-2">
            {sources.map((src) => (
              <li key={src.source_id} className="rounded-lg bg-surface p-3 text-xs">
                <p className="font-semibold text-brand">{src.domain}</p>
                <p className="mt-0.5 break-all text-ink-soft">{src.url}</p>
                {src.excerpt && (
                  <p className="mt-1.5 whitespace-pre-wrap text-ink-soft">{src.excerpt.slice(0, 240)}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. 승인 버튼 (미해소 [VERIFY] 존재 시 절대 비활성화) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-4">
        <p className="text-xs text-ink-soft">
          {isApprovedForCurrentHash
            ? `승인 완료 시각: ${manuscript.approved_at}`
            : effectiveUnresolved > 0
              ? `미해소 [VERIFY] ${effectiveUnresolved}건을 모두 해소해야 승인할 수 있습니다.`
              : ftcMissing
                ? '협찬 원고의 공정위 표시 문구가 필요합니다.'
                : '모든 검증 항목을 확인했습니다. 승인 후 내보내기(Phase 4)를 진행할 수 있습니다.'}
        </p>

        <button
          type="button"
          disabled={!canApprove}
          onClick={onApprove}
          className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isApproving
            ? '승인 처리 중...'
            : isApprovedForCurrentHash
              ? '현재 버전 승인됨'
              : '검증 완료 · 원고 승인'}
        </button>
      </div>
    </section>
  );
}
