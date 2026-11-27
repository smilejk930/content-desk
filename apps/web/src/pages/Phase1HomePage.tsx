import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ExportResponse, MeResponse } from '@content-desk/shared';
import type { User } from 'firebase/auth';
import {
  ApiRequestError,
  fetchMe,
  getApiErrorMessage,
  triggerExport
} from '../lib/api-client';
import { signOutUser } from '../lib/firebase';
import { StatusBadge } from '../components/StatusBadge';
import { AccessDeniedPage } from './AccessDeniedPage';
import { AdminUsersPage, type AdminUsersPageProps } from './AdminUsersPage';
import { CategoriesPage, type CategoriesPageProps } from './CategoriesPage';
import { CopyPanelPage, type CopyPanelPageProps } from './CopyPanelPage';
import { DashboardPage, type DashboardPageProps } from './DashboardPage';
import { DiscoveryPage, type DiscoveryPageProps } from './DiscoveryPage';
import { ManuscriptPage, type ManuscriptPageProps } from './ManuscriptPage';
import { MobileUploadPage, type MobileUploadPageProps } from './MobileUploadPage';
import { PublishTrackerPage, type PublishTrackerPageProps } from './PublishTrackerPage';
import { SettingsPage, type SettingsPageProps } from './SettingsPage';

export interface Phase1HomePageProps {
  user: Pick<User, 'uid'>;
  d1LimitResetAt: string | null;
  loadMe?: () => Promise<MeResponse>;
  runExport?: () => Promise<ExportResponse>;
  onSignOut?: () => Promise<void> | void;
  adminPageProps?: AdminUsersPageProps;
  categoriesPageProps?: CategoriesPageProps;
  uploadPageProps?: MobileUploadPageProps;
  discoveryPageProps?: DiscoveryPageProps;
  manuscriptPageProps?: ManuscriptPageProps;
  copyPanelPageProps?: CopyPanelPageProps;
  publishTrackerPageProps?: PublishTrackerPageProps;
  dashboardPageProps?: Omit<DashboardPageProps, 'me' | 'd1LimitResetAt'>;
  settingsPageProps?: Omit<SettingsPageProps, 'me'>;
}

type ActiveTab =
  | 'home'
  | 'categories'
  | 'upload'
  | 'discovery'
  | 'manuscripts'
  | 'copy-panel'
  | 'publish'
  | 'settings'
  | 'admin-users';

export function Phase1HomePage({
  user,
  d1LimitResetAt,
  loadMe = fetchMe,
  runExport = triggerExport,
  onSignOut = signOutUser,
  adminPageProps,
  categoriesPageProps,
  uploadPageProps,
  discoveryPageProps,
  manuscriptPageProps,
  copyPanelPageProps,
  publishTrackerPageProps,
  dashboardPageProps,
  settingsPageProps
}: Phase1HomePageProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [selectedManuscriptId, setSelectedManuscriptId] = useState<string | null>(null);

  const meQuery = useQuery({
    queryKey: ['me', user.uid],
    queryFn: loadMe,
    retry: false
  });

  if (
    meQuery.error instanceof ApiRequestError &&
    (meQuery.error.code === 'USER_NOT_REGISTERED' || meQuery.error.code === 'USER_BLOCKED')
  ) {
    const deniedUid =
      typeof meQuery.error.details?.uid === 'string' ? meQuery.error.details.uid : user.uid;
    return <AccessDeniedPage code={meQuery.error.code} uid={deniedUid} onSignOut={onSignOut} />;
  }

  const isAdmin = meQuery.data?.role === 'admin';
  const currentTab: ActiveTab =
    activeTab === 'admin-users' && !isAdmin ? 'home' : activeTab;

  const navTabClass = (tab: ActiveTab) =>
    `pill-btn px-4 text-sm font-semibold ${
      currentTab === tab
        ? 'bg-surface text-cta'
        : 'border border-ink-inverse/30 text-ink-inverse'
    }`;

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <header className="bg-band px-5 py-4 text-ink-inverse">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-ink-inverse-soft">PHASE 4 · M1 JOURNEY 3·4</p>
            <h1 className="text-xl font-semibold">Content Desk</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {meQuery.data && (
              <nav aria-label="주 메뉴" className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('home')}
                  aria-current={currentTab === 'home' ? 'page' : undefined}
                  className={navTabClass('home')}
                >
                  대시보드
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('categories')}
                  aria-current={currentTab === 'categories' ? 'page' : undefined}
                  className={navTabClass('categories')}
                >
                  카테고리
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('upload')}
                  aria-current={currentTab === 'upload' ? 'page' : undefined}
                  className={navTabClass('upload')}
                >
                  자료 올리기
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('discovery')}
                  aria-current={currentTab === 'discovery' ? 'page' : undefined}
                  className={navTabClass('discovery')}
                >
                  글감 발굴
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('manuscripts')}
                  aria-current={currentTab === 'manuscripts' ? 'page' : undefined}
                  className={navTabClass('manuscripts')}
                >
                  원고 편집·검증
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('copy-panel')}
                  aria-current={currentTab === 'copy-panel' ? 'page' : undefined}
                  className={navTabClass('copy-panel')}
                >
                  복사·공유
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('publish')}
                  aria-current={currentTab === 'publish' ? 'page' : undefined}
                  className={navTabClass('publish')}
                >
                  발행·순위
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  aria-current={currentTab === 'settings' ? 'page' : undefined}
                  className={navTabClass('settings')}
                >
                  설정
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('admin-users')}
                    aria-current={currentTab === 'admin-users' ? 'page' : undefined}
                    className={navTabClass('admin-users')}
                  >
                    사용자 관리
                  </button>
                )}
              </nav>
            )}

            <button
              type="button"
              onClick={() => void onSignOut()}
              className="pill-btn border border-ink-inverse/30 px-4 text-sm font-medium text-ink-inverse"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-5 py-6">
        {d1LimitResetAt && (
          <div role="alert" className="rounded-xl bg-warning px-4 py-3 text-sm font-medium text-warning-ink">
            D1 무료 일일 한도에 도달했습니다. UTC 자정({d1LimitResetAt}) 이후 다시 시도해 주세요.
          </div>
        )}

        {meQuery.isLoading && (
          <section className="card-surface p-6">
            <p className="text-sm text-ink-soft">인증 및 D1 연결 상태를 확인하고 있습니다...</p>
          </section>
        )}

        {meQuery.error && (
          <section className="card-surface p-6">
            <StatusBadge tone="danger" icon="!" label="API 오류" />
            <p className="mt-3 text-sm text-danger">
              {getApiErrorMessage(meQuery.error, '상태 조회에 실패했습니다.')}
            </p>
          </section>
        )}

        {meQuery.data && currentTab === 'home' && (
          <DashboardPage
            {...dashboardPageProps}
            me={meQuery.data}
            d1LimitResetAt={d1LimitResetAt}
            runExport={dashboardPageProps?.runExport ?? runExport}
            onNavigateTab={(tab) => setActiveTab(tab)}
          />
        )}

        {meQuery.data && currentTab === 'categories' && (
          <CategoriesPage {...categoriesPageProps} />
        )}

        {meQuery.data && currentTab === 'upload' && (
          <MobileUploadPage
            {...uploadPageProps}
            onNavigateCategories={() => setActiveTab('categories')}
          />
        )}

        {meQuery.data && currentTab === 'discovery' && (
          <DiscoveryPage
            {...discoveryPageProps}
            onSelectTopicForManuscript={(topicId) => {
              setSelectedTopicId(topicId);
              setActiveTab('manuscripts');
            }}
          />
        )}

        {meQuery.data && currentTab === 'manuscripts' && (
          <ManuscriptPage
            {...manuscriptPageProps}
            initialTopicId={selectedTopicId}
            initialManuscriptId={selectedManuscriptId}
            onOpenCopyPanel={(manuscriptId) => {
              setSelectedManuscriptId(manuscriptId);
              setActiveTab('copy-panel');
            }}
          />
        )}

        {meQuery.data && currentTab === 'copy-panel' && (
          <CopyPanelPage
            {...copyPanelPageProps}
            initialManuscriptId={selectedManuscriptId}
            onNavigateToManuscript={(manuscriptId) => {
              setSelectedManuscriptId(manuscriptId);
              setActiveTab('manuscripts');
            }}
            onNavigateToPublish={(manuscriptId) => {
              setSelectedManuscriptId(manuscriptId);
              setActiveTab('publish');
            }}
          />
        )}

        {meQuery.data && currentTab === 'publish' && (
          <PublishTrackerPage
            {...publishTrackerPageProps}
            initialManuscriptId={selectedManuscriptId}
          />
        )}

        {meQuery.data && currentTab === 'settings' && (
          <SettingsPage
            {...settingsPageProps}
            me={meQuery.data}
            runExport={settingsPageProps?.runExport ?? runExport}
          />
        )}

        {meQuery.data && currentTab === 'admin-users' && isAdmin && (
          <AdminUsersPage {...adminPageProps} />
        )}
      </div>
    </main>
  );
}
