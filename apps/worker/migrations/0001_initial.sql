-- Content Desk M1 Initial Schema (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  category_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  discovery_mode TEXT NOT NULL CHECK (discovery_mode IN ('trend_first', 'experience_first', 'none')),
  datalab_anchor_keyword TEXT,
  default_visibility TEXT NOT NULL CHECK (default_visibility IN ('전체공개', '이웃공개')),
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  capture_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'vlog')),
  llm_consent_at TEXT,
  capture_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captures_category_created
  ON captures (category_id, created_at DESC);

CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('category_discovery', 'personal_vlog')),
  category_id TEXT NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'explainer', 'vlog')),
  status TEXT NOT NULL,
  ymyl_status TEXT NOT NULL CHECK (ymyl_status IN ('SAFE', 'BORDERLINE_PENDING', 'BORDERLINE_CONFIRMED', 'BLOCKED')),
  topic_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_category_status_created
  ON topics (category_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_topics_run_id
  ON topics (run_id);

CREATE TABLE IF NOT EXISTS source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  ingest_channel TEXT NOT NULL CHECK (ingest_channel IN ('webkr_search', 'manual_input')),
  r2_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_snapshots_topic
  ON source_snapshots (topic_id);

CREATE TABLE IF NOT EXISTS manuscripts (
  manuscript_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE RESTRICT,
  category_id TEXT NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL CHECK (content_type IN ('experience_review', 'explainer', 'vlog')),
  run_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  approved_hash TEXT,
  approved_at TEXT,
  unresolved_verify_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_verify_count >= 0),
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manuscripts_approved_at
  ON manuscripts (approved_at DESC);

CREATE INDEX IF NOT EXISTS idx_manuscripts_category_created
  ON manuscripts (category_id, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  provider TEXT NOT NULL,
  window_date TEXT NOT NULL,
  reset_tz TEXT NOT NULL CHECK (reset_tz IN ('UTC', 'America/Los_Angeles')),
  daily_cap INTEGER NOT NULL CHECK (daily_cap >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, window_date)
);

CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  backoff_until TEXT
);

CREATE TABLE IF NOT EXISTS published_posts (
  post_id TEXT PRIMARY KEY,
  manuscript_id TEXT NOT NULL REFERENCES manuscripts(manuscript_id) ON DELETE RESTRICT,
  category_id TEXT NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  log_no TEXT NOT NULL UNIQUE,
  post_url TEXT NOT NULL,
  target_keywords_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  track_until TEXT NOT NULL,
  last_tracked_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_published_posts_tracking
  ON published_posts (track_until, last_tracked_date);

CREATE INDEX IF NOT EXISTS idx_published_posts_category_published
  ON published_posts (category_id, published_at DESC);

CREATE TABLE IF NOT EXISTS rank_history (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES published_posts(post_id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  rank INTEGER,
  checked_date TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE (post_id, keyword, checked_date)
);

CREATE TABLE IF NOT EXISTS daily_visitors (
  visit_date TEXT PRIMARY KEY,
  visitor_count INTEGER NOT NULL CHECK (visitor_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
