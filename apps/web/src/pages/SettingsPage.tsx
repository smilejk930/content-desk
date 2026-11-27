import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buildNaverBlogWriteUrl,
  NAVER_BLOG_ID_RE,
  type ExportResponse,
  type MeResponse,
  type SettingsResponse,
  type UpdateSettingsRequest
} from '@content-desk/shared';
import {
  fetchSettings,
  getApiErrorMessage,
  triggerExport,
  updateSettings
} from '../lib/api-client';
import { StatusBadge } from '../components/StatusBadge';
import { downloadExportJsonFile } from './DashboardPage';

export interface SettingsPageProps {
  me: MeResponse;
  loadSettings?: () => Promise<SettingsResponse>;
  saveSettings?: (input: UpdateSettingsRequest) => Promise<SettingsResponse>;
  runExport?: () => Promise<ExportResponse>;
}

export function SettingsPage({
  me,
  loadSettings = fetchSettings,
  saveSettings = updateSettings,
  runExport = triggerExport
}: SettingsPageProps) {
  const queryClient = useQueryClient();
  const [blogIdInput, setBlogIdInput] = useState<string>('');
  const [initialized, setInitialized] = useState<boolean>(false);
  const [settingsFeedback, setSettingsFeedback] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [exportFeedback, setExportFeedback] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: loadSettings,
    retry: false
  });

  useEffect(() => {
    if (settingsQuery.data && !initialized) {
      setBlogIdInput(settingsQuery.data.naver_blog_id ?? '');
      setInitialized(true);
    }
  }, [settingsQuery.data, initialized]);

  const trimmedBlogId = blogIdInput.trim();
  const isBlogIdValid = trimmedBlogId === '' || NAVER_BLOG_ID_RE.test(trimmedBlogId);
  const previewWriteUrl = buildNaverBlogWriteUrl(isBlogIdValid ? trimmedBlogId : null);

  const saveMutation = useMutation({
    mutationFn: (nextId: string | null) => saveSettings({ naver_blog_id: nextId }),
    onSuccess: (res) => {
      setBlogIdInput(res.naver_blog_id ?? '');
      setSettingsFeedback({
        tone: 'success',
        text: res.naver_blog_id
          ? `네이버 블로그 ID(${res.naver_blog_id})를 저장했습니다.`
          : '네이버 블로그 ID를 초기화했습니다 (기본 글쓰기 주소 사용).'
      });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => {
      setSettingsFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '설정 저장에 실패했습니다.')
      });
    }
  });

  const exportMutation = useMutation({
    mutationFn: runExport,
    onSuccess: (data) => {
      downloadExportJsonFile(data);
      setExportFeedback({
        tone: 'success',
        text: `본인 데이터 전체 JSON 내보내기를 완료했습니다 (시각: ${data.exported_at}).`
      });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (err) => {
      setExportFeedback({
        tone: 'danger',
        text: getApiErrorMessage(err, '전체 데이터 내보내기에 실패했습니다.')
      });
    }
  });

  const settings = settingsQuery.data ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* 1. 네이버 블로그 ID 설정 */}
      <section className="card-surface p-6">
        <h2 className="text-xl font-semibold text-brand">설정 · 백업</h2>
        <p className="mt-1 text-sm text-ink-soft">
          수동 복사 패널의 [네이버 블로그 글쓰기 열기] 바로가기에 사용할 네이버 블로그 ID(선택)를
          설정합니다.
        </p>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isBlogIdValid) {
              setSettingsFeedback({
                tone: 'danger',
                text: '네이버 블로그 ID는 영문, 숫자, _, - 만 입력할 수 있습니다 (최대 50자).'
              });
              return;
            }
            saveMutation.mutate(trimmedBlogId || null);
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            <span>네이버 블로그 ID (선택 입력)</span>
            <input
              type="text"
              aria-label="네이버 블로그 ID"
              value={blogIdInput}
              onChange={(e) => {
                setInitialized(true);
                setBlogIdInput(e.target.value);
              }}
              placeholder="예: my_naver_blog (비워두면 기본 글쓰기 주소 사용)"
              className="min-h-[44px] rounded-lg border border-ink/20 bg-surface px-3.5 text-base text-ink focus:border-cta focus:outline-none"
            />
          </label>

          {!isBlogIdValid && (
            <p role="alert" className="text-xs text-danger">
              영문, 숫자, 밑줄(_), 하이픈(-)만 허용됩니다 (URL·슬래시·공백 불가).
            </p>
          )}

          <p className="break-all text-xs text-ink-soft">
            글쓰기 바로가기 미리보기: <code>{previewWriteUrl}</code>
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!isBlogIdValid || saveMutation.isPending}
              className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-45"
            >
              {saveMutation.isPending ? '저장 중...' : '블로그 ID 저장'}
            </button>
            <button
              type="button"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(null)}
              className="pill-btn border border-ink/20 bg-surface px-5 text-sm font-semibold text-ink disabled:opacity-45"
            >
              초기화
            </button>
          </div>
        </form>

        {settingsFeedback && (
          <p
            role={settingsFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              settingsFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {settingsFeedback.text}
          </p>
        )}
      </section>

      {/* 2. 본인 데이터 전체 JSON 내보내기 (15분 재인증) */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-ink">본인 데이터 전체 JSON 내보내기</h3>
            <p className="mt-1 text-sm text-ink-soft">
              최근 15분 이내 Google 재인증 후 본인 소유 카테고리·캡처·글감·원고·발행 기록·방문자
              수를 JSON 파일로 백업합니다. (전역 원장·타인 데이터 제외)
            </p>
          </div>
          {settings && (
            <StatusBadge
              tone={settings.backup_reminder_due ? 'warning' : 'success'}
              icon={settings.backup_reminder_due ? '!' : '✓'}
              label={settings.backup_reminder_due ? '30일 백업 권장' : '백업 최신'}
            />
          )}
        </div>

        <p className="mt-3 text-xs text-ink-soft">
          마지막 전체 내보내기 일시:{' '}
          <strong className="text-ink">
            {settings?.last_full_export_at ?? '내보내기 기록 없음'}
          </strong>
          {settings?.days_since_export !== null && settings?.days_since_export !== undefined
            ? ` (${settings.days_since_export}일 전)`
            : ''}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
            className="pill-btn bg-cta px-6 text-sm font-semibold text-ink-inverse disabled:opacity-50"
          >
            {exportMutation.isPending ? '내보내기 준비 중...' : '전체 데이터 JSON 내보내기 (15분 재인증)'}
          </button>
        </div>

        {exportFeedback && (
          <p
            role={exportFeedback.tone === 'danger' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3.5 py-2.5 text-sm ${
              exportFeedback.tone === 'danger'
                ? 'bg-danger-bg text-danger'
                : 'bg-success-bg text-brand'
            }`}
          >
            {exportFeedback.text}
          </p>
        )}
      </section>

      {/* 3. 계정 · 세션 정보 */}
      <section className="card-surface p-6">
        <h3 className="text-lg font-semibold text-ink">계정 및 세션 정보</h3>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-surface-subtle p-3.5">
            <dt className="text-xs text-ink-soft">Firebase UID</dt>
            <dd className="mt-1 break-all font-mono text-sm text-ink">{me.uid}</dd>
          </div>
          <div className="rounded-lg bg-surface-subtle p-3.5">
            <dt className="text-xs text-ink-soft">이메일 / 권한</dt>
            <dd className="mt-1 text-sm text-ink">
              {me.email ?? '-'} ({me.role === 'admin' ? '관리자' : '일반 사용자'})
            </dd>
          </div>
          <div className="rounded-lg bg-surface-subtle p-3.5">
            <dt className="text-xs text-ink-soft">최대 세션 만료 (14일)</dt>
            <dd className="mt-1 text-sm text-ink">{me.session_expires_at}</dd>
          </div>
          <div className="rounded-lg bg-surface-subtle p-3.5">
            <dt className="text-xs text-ink-soft">민감 작업 재인증 유효 (15분)</dt>
            <dd className="mt-1 text-sm text-ink">{me.reauth_valid_until}</dd>
          </div>
        </dl>
      </section>

      {/* 4. M2 Phase 5 예정 안내 */}
      <section className="card-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-ink">Windows PC 자동 임시저장 (M2 · Phase 5 예정)</h3>
          <StatusBadge tone="neutral" icon="M2" label="Phase 5 예정" />
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          PC 브리지 페어링 토큰 발급·폐기 및 <code>ego-browser</code> 기반 스마트에디터 ONE 자동
          임시저장 기능은 네이버 이용약관 검토 완료 후 마일스톤 2(Phase 5)에서 제공될 예정입니다.
          마일스톤 1의 모든 기능은 수동 복사·공유 패널로 단독 동작합니다.
        </p>
      </section>
    </div>
  );
}
