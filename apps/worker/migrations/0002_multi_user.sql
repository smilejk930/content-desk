-- Content Desk Phase 1.5 Multi-User Schema (Cloudflare D1 / SQLite)
-- Precondition before remote apply: verify all 9 user data tables have 0 rows.
PRAGMA defer_foreign_keys = ON;

-- 0행 가드: 기존 9개 사용자 데이터 표 중 하나라도 1행 이상 있으면 CHECK 제약으로 즉시 실패해
-- 후속 DROP TABLE이 실행되지 않고 트랜잭션이 롤백되도록 보호합니다.
CREATE TABLE _mu_guard (n INTEGER CHECK (n = 0));
INSERT INTO _mu_guard
  SELECT
    (SELECT COUNT(*) FROM categories) +
    (SELECT COUNT(*) FROM captures) +
    (SELECT COUNT(*) FROM topics) +
    (SELECT COUNT(*) FROM source_snapshots) +
    (SELECT COUNT(*) FROM manuscripts) +
    (SELECT COUNT(*) FROM execution_runs) +
    (SELECT COUNT(*) FROM published_posts) +
    (SELECT COUNT(*) FROM rank_history) +
    (SELECT COUNT(*) FROM daily_visitors);
DROP TABLE _mu_guard;

DROP TABLE IF EXISTS rank_history;
DROP TABLE IF EXISTS published_posts;
DROP TABLE IF EXISTS manuscripts;
DROP TABLE IF EXISTS source_snapshots;
DROP TABLE IF EXISTS topics;
DROP TABLE IF EXISTS captures;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS execution_runs;
DROP TABLE IF EXISTS daily_visitors;

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  discovery_mode TEXT NOT NULL CHECK (discovery_mode IN ('trend_first', 'experience_first', 'none')),
  datalab_anchor_keyword TEXT,
  default_visibility TEXT NOT NULL CHECK (default_visibility IN ('전체공개', '이웃공개')),
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_uid, category_id),
  UNIQUE (owner_uid, display_name)
);

CREATE INDEX idx_categories_owner_created
  ON categories (owner_uid, created_at DESC);

CREATE TABLE captures (
  capture_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  category_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'vlog')),
  llm_consent_at TEXT,
  capture_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_uid, capture_id),
  FOREIGN KEY (owner_uid, category_id) REFERENCES categories(owner_uid, category_id) ON DELETE RESTRICT
);

CREATE INDEX idx_captures_owner_category_created
  ON captures (owner_uid, category_id, created_at DESC);

CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('category_discovery', 'personal_vlog')),
  category_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'explainer', 'vlog')),
  status TEXT NOT NULL,
  ymyl_status TEXT NOT NULL CHECK (ymyl_status IN ('SAFE', 'BORDERLINE_PENDING', 'BORDERLINE_CONFIRMED', 'BLOCKED')),
  topic_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_uid, topic_id),
  FOREIGN KEY (owner_uid, category_id) REFERENCES categories(owner_uid, category_id) ON DELETE RESTRICT
);

CREATE INDEX idx_topics_owner_category_status_created
  ON topics (owner_uid, category_id, status, created_at DESC);

CREATE INDEX idx_topics_owner_run_id
  ON topics (owner_uid, run_id);

CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  ingest_channel TEXT NOT NULL CHECK (ingest_channel IN ('webkr_search', 'manual_input')),
  r2_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  fetched_at TEXT NOT NULL,
  FOREIGN KEY (owner_uid, topic_id) REFERENCES topics(owner_uid, topic_id) ON DELETE CASCADE
);

CREATE INDEX idx_source_snapshots_owner_topic
  ON source_snapshots (owner_uid, topic_id);

CREATE TABLE manuscripts (
  manuscript_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'explainer', 'vlog')),
  run_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  approved_hash TEXT,
  approved_at TEXT,
  unresolved_verify_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_verify_count >= 0),
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_uid, manuscript_id),
  UNIQUE (owner_uid, run_id),
  FOREIGN KEY (owner_uid, topic_id) REFERENCES topics(owner_uid, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_uid, category_id) REFERENCES categories(owner_uid, category_id) ON DELETE RESTRICT
);

CREATE INDEX idx_manuscripts_owner_approved_at
  ON manuscripts (owner_uid, approved_at DESC);

CREATE INDEX idx_manuscripts_owner_category_created
  ON manuscripts (owner_uid, category_id, created_at DESC);

CREATE TABLE execution_runs (
  run_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_execution_runs_owner_created
  ON execution_runs (owner_uid, created_at DESC);

CREATE TABLE published_posts (
  post_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  manuscript_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  log_no TEXT NOT NULL,
  post_url TEXT NOT NULL,
  target_keywords_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  track_until TEXT NOT NULL,
  last_tracked_date TEXT,
  UNIQUE (owner_uid, post_id),
  UNIQUE (owner_uid, log_no),
  FOREIGN KEY (owner_uid, manuscript_id) REFERENCES manuscripts(owner_uid, manuscript_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_uid, category_id) REFERENCES categories(owner_uid, category_id) ON DELETE RESTRICT
);

CREATE INDEX idx_published_posts_tracking
  ON published_posts (track_until, last_tracked_date, owner_uid);

CREATE INDEX idx_published_posts_owner_category_published
  ON published_posts (owner_uid, category_id, published_at DESC);

CREATE TABLE rank_history (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  post_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  rank INTEGER,
  checked_date TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE (owner_uid, post_id, keyword, checked_date),
  FOREIGN KEY (owner_uid, post_id) REFERENCES published_posts(owner_uid, post_id) ON DELETE CASCADE
);

CREATE INDEX idx_rank_history_owner_checked
  ON rank_history (owner_uid, checked_date DESC, checked_at DESC);

CREATE TABLE daily_visitors (
  owner_uid TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  visitor_count INTEGER NOT NULL CHECK (visitor_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_uid, visit_date)
);

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_meta (
  owner_uid TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_uid, key)
);

-- usage_daily.window_date는 quota_ledger의 제공자별 기준 시간대
-- (gemini* 계열은 America/Los_Angeles 날짜, 그 외 제공자는 UTC 날짜, YYYY-MM-DD)로 기록·조회하며
-- Phase 3 quota-ledger.ts 정산 batch()도 동일 기준을 따릅니다.
CREATE TABLE IF NOT EXISTS usage_daily (
  owner_uid TEXT NOT NULL,
  provider TEXT NOT NULL,
  window_date TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (owner_uid, provider, window_date)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_window_date
  ON usage_daily (window_date);

-- Phase 1에서 전역 app_meta에 저장하던 last_full_export_at은 사람별 user_meta로 이전되었으므로 정리합니다.
DELETE FROM app_meta WHERE key = 'last_full_export_at';
