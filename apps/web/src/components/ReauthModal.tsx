import { useState } from 'react';
import {
  isStandaloneMode,
  mapAuthPopupError,
  reauthenticateWithGooglePopup
} from '../lib/firebase';

export interface ReauthModalProps {
  open: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  reauthenticate?: () => Promise<string>;
  standalone?: boolean;
}

export function ReauthModal({
  open,
  onSuccess,
  onCancel,
  reauthenticate = reauthenticateWithGooglePopup,
  standalone = isStandaloneMode()
}: ReauthModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleReauthClick = () => {
    setErrorMessage(null);
    setSubmitting(true);
    // Invoke popup reauth synchronously on the click gesture with NO prior await.
    reauthenticate()
      .then(() => {
        setSubmitting(false);
        onSuccess();
      })
      .catch((err: unknown) => {
        setSubmitting(false);
        setErrorMessage(mapAuthPopupError(err, standalone));
      });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
    >
      <div className="card-surface w-full max-w-md p-6">
        <h2 id="reauth-modal-title" className="text-xl font-semibold text-brand">
          민감 작업 전 Google 재인증
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          전체 데이터 내보내기나 브리지 관리 작업은 최근 15분 이내 인증이 필요합니다. 아래 버튼을
          눌러 본인 Google 계정으로 다시 인증해 주세요.
        </p>

        {standalone && (
          <p className="mt-3 rounded-lg bg-warning px-3 py-2 text-sm font-medium text-warning-ink">
            홈 화면 단독 실행 모드에서는 팝업 인증이 실패할 수 있습니다. 문제가 발생하면 일반
            브라우저 탭에서 열어 로그인해 주세요.
          </p>
        )}

        {errorMessage && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            {errorMessage}
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="pill-btn border border-ink/20 bg-surface px-5 text-sm font-medium text-ink"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleReauthClick}
            disabled={submitting}
            className="pill-btn bg-cta px-5 text-sm font-semibold text-ink-inverse disabled:opacity-60"
          >
            {submitting ? '재인증 중...' : 'Google로 다시 인증'}
          </button>
        </div>
      </div>
    </div>
  );
}
