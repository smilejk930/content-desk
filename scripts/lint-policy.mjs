import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const TARGET_DIRS = ['packages', 'apps'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.json', '.toml']);

const failures = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (CODE_EXTS.has(path.extname(entry.name))) {
      checkFile(full);
    }
  }
}

function checkFile(fullPath) {
  const rel = path.relative(ROOT, fullPath).replace(/\\/g, '/');
  if (rel.endsWith('.env.local') || rel.endsWith('.dev.vars')) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  const isTest = rel.includes('/test/') || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx');
  const isSource = !isTest && !rel.endsWith('.json') && !rel.endsWith('.toml');

  // 1. Forbidden Zod 3 syntax in source files
  if (isSource) {
    const zod3Patterns = [
      { re: /z\.string\(\)\.email\(/, msg: 'Zod 3 z.string().email() 금지 (z.email() 사용)' },
      { re: /z\.string\(\)\.datetime\(/, msg: 'Zod 3 z.string().datetime() 금지 (z.iso.datetime() 사용)' },
      { re: /z\.string\(\)\.url\(/, msg: 'Zod 3 z.string().url() 금지 (z.url() 사용)' },
      { re: /\.strict\(\)/, msg: 'Zod 3 .strict() 금지 (z.strictObject() 사용)' },
      { re: /\brequired_error\b/, msg: 'Zod 3 required_error 금지 ({ error } 사용)' },
      { re: /\binvalid_type_error\b/, msg: 'Zod 3 invalid_type_error 금지 ({ error } 사용)' }
    ];
    for (const p of zod3Patterns) {
      if (p.re.test(content)) failures.push(`${rel}: ${p.msg}`);
    }

    // 2. Forbidden Email/Password Firebase Auth APIs and signInWithRedirect
    const forbiddenAuth = [
      'signInWithEmailAndPassword',
      'createUserWithEmailAndPassword',
      'sendPasswordResetEmail',
      'EmailAuthProvider',
      'reauthenticateWithCredential',
      'signInWithRedirect',
      'getRedirectResult'
    ];
    for (const api of forbiddenAuth) {
      if (content.includes(api)) {
        failures.push(`${rel}: 금지된 Firebase Auth API '${api}' 포함`);
      }
    }
  }

  // 3. Forbidden dependencies in apps/worker
  if (rel.startsWith('apps/worker/')) {
    const forbiddenDeps = ['firebase-admin', 'jsdom', 'cheerio', '@aws-sdk/'];
    for (const dep of forbiddenDeps) {
      if (content.includes(dep)) {
        failures.push(`${rel}: Worker 금지 의존성 '${dep}' 포함`);
      }
    }
  }

  // 4. Secret literal guard (allow test PEM fixture generation in test/helpers)
  if (!isTest) {
    const secretPatterns = [
      { re: /AIzaSy[0-9A-Za-z_-]{20,}/, msg: 'Google/Firebase API 키 리터럴 감지 (.env.local로 격리 필요)' },
      { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: '개인키 PEM 리터럴 감지' },
      { re: /\bsk-[A-Za-z0-9]{20,}\b/, msg: 'API 비밀키 리터럴 감지' }
    ];
    for (const p of secretPatterns) {
      if (p.re.test(content)) failures.push(`${rel}: ${p.msg}`);
    }
  }
}

// 7. Verify per-user table SQL across ALL apps/worker/src/**/*.ts files:
//    a) Outside apps/worker/src/repositories/: any per-user table SQL is forbidden.
//    b) Inside apps/worker/src/repositories/users.repo.ts (reverse check): referencing per-user content tables is forbidden.
//    c) Inside apps/worker/src/repositories/*.repo.ts (except cron.repo.ts, quota.repo.ts, users.repo.ts):
//       every per-user table SQL must include owner_uid.
const WORKER_SRC_DIR = path.join(ROOT, 'apps/worker/src');
const OWNER_UID_LINT_EXCEPTIONS = new Set(['cron.repo.ts', 'users.repo.ts', 'quota.repo.ts']);
const PER_USER_TABLES = [
  'categories',
  'captures',
  'topics',
  'source_snapshots',
  'manuscripts',
  'execution_runs',
  'published_posts',
  'rank_history',
  'daily_visitors',
  'user_meta',
  'bridge_tokens',
  'bridge_status',
  'bridge_jobs'
];
const PER_USER_SQL_RE = new RegExp(
  `\\b(?:FROM|INTO|UPDATE|JOIN)\\s+(?:${PER_USER_TABLES.join('|')})\\b`,
  'i'
);

function extractStringLiterals(source) {
  const literals = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    // Skip line comments
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    // Skip block comments
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      let buf = '';
      while (i < len) {
        const cur = source[i];
        if (cur === '\\' && i + 1 < len) {
          buf += cur + source[i + 1];
          i += 2;
          continue;
        }
        if (cur === quote) {
          i += 1;
          break;
        }
        buf += cur;
        i += 1;
      }
      literals.push({ text: buf, offset: start });
      continue;
    }
    i += 1;
  }
  return literals;
}

export function checkWorkerPerUserSql(relPath, src) {
  const rel = relPath.replace(/\\/g, '/');
  if (!rel.startsWith('apps/worker/src/') || !rel.endsWith('.ts')) return [];

  const fileFailures = [];
  const literals = extractStringLiterals(src);
  const isInRepositories = rel.startsWith('apps/worker/src/repositories/');
  const baseName = path.posix.basename(rel);

  for (const lit of literals) {
    if (!PER_USER_SQL_RE.test(lit.text)) continue;

    const line = src.slice(0, lit.offset).split(/\r?\n/).length;
    const preview = lit.text.replace(/\s+/g, ' ').trim().slice(0, 100);

    if (!isInRepositories) {
      fileFailures.push(
        `${rel}:${line}: repositories/ 밖에서 사람별 표 SQL을 직접 작성할 수 없습니다: "${preview}"`
      );
      continue;
    }

    if (baseName === 'users.repo.ts') {
      fileFailures.push(
        `${rel}:${line}: users.repo.ts는 사용자 내용물 표를 참조할 수 없습니다(users·usage_daily만 허용): "${preview}"`
      );
      continue;
    }

    if (OWNER_UID_LINT_EXCEPTIONS.has(baseName)) {
      continue;
    }

    if (!/\bowner_uid\b/i.test(lit.text)) {
      fileFailures.push(
        `${rel}:${line}: 사람별 표 SQL에 owner_uid 조건/컬럼이 누락되었습니다: "${preview}"`
      );
    }
  }

  return fileFailures;
}

function walkWorkerSrc(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkWorkerSrc(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      const src = fs.readFileSync(full, 'utf8');
      failures.push(...checkWorkerPerUserSql(rel, src));
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  for (const d of TARGET_DIRS) {
    walk(path.join(ROOT, d));
  }

  // 5. Verify Worker entrypoint initializes z.config({ jitless: true }) before app imports
  const workerEntry = path.join(ROOT, 'apps/worker/src/index.ts');
  if (fs.existsSync(workerEntry)) {
    const entrySrc = fs.readFileSync(workerEntry, 'utf8');
    const zodInit = path.join(ROOT, 'apps/worker/src/zod-init.ts');
    const zodInitSrc = fs.existsSync(zodInit) ? fs.readFileSync(zodInit, 'utf8') : '';
    const firstLine = entrySrc.trimStart().split(/\r?\n/)[0] ?? '';
    if (!firstLine.includes('zod-init') || !zodInitSrc.includes('jitless: true')) {
      failures.push('apps/worker/src/index.ts: 첫 줄에서 z.config({ jitless: true }) 초기화 모듈(zod-init) 로드 필요');
    }
  }

  // 6. Verify Pages _headers does not set COOP: same-origin
  const pagesHeaders = path.join(ROOT, 'apps/web/public/_headers');
  if (fs.existsSync(pagesHeaders)) {
    const headersSrc = fs.readFileSync(pagesHeaders, 'utf8');
    if (/Cross-Origin-Opener-Policy:\s*same-origin\s*$/m.test(headersSrc)) {
      failures.push('apps/web/public/_headers: COOP same-origin은 signInWithPopup을 깨뜨리므로 금지');
    }
  }

  walkWorkerSrc(WORKER_SRC_DIR);

  if (failures.length > 0) {
    console.error('Lint policy violations found:');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }

  console.log('Lint policy passed: 0 violations.');
}
