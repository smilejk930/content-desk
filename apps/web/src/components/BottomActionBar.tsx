import type { ReactNode } from 'react';

export interface BottomActionBarProps {
  children: ReactNode;
  ariaLabel?: string;
}

/**
 * DESIGN.md 모바일 안전 영역 및 최소 44px 터치 타겟을 준수하는 하단 고정 액션 바.
 */
export function BottomActionBar({
  children,
  ariaLabel = '하단 작업 메뉴'
}: BottomActionBarProps) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className="safe-bottom-bar sticky bottom-0 z-20 border-t border-ink/10 bg-surface/95 px-4 pt-3 backdrop-blur-sm"
      style={{ boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.08)' }}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2">
        {children}
      </div>
    </div>
  );
}
