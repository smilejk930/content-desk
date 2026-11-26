import {
  MAX_CAPTURE_FILE_BYTES,
  type CaptureUploadMime
} from '@content-desk/shared';
import type { UserScope, WorkerBindings } from '../env.js';
import { AppError } from '../middleware/error-handler.js';

export const R2_PUT_EXPIRES_SECONDS = 300; // 5 minutes
export const R2_GET_EXPIRES_SECONDS = 600; // 10 minutes
const R2_REGION = 'auto';
const R2_SERVICE = 's3';
const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const ALLOWED_UPLOAD_MIMES = new Set<string>(['image/webp', 'image/jpeg']);

export interface R2SignerConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignedUrlResult {
  objectKey: string;
  url: string;
  expiresInSeconds: number;
  expiresAt: string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function encodeUtf8(value: string): ArrayBuffer {
  const bytes = encoder.encode(value);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(message));
  return toHex(digest);
}

async function hmacSha256(
  key: ArrayBuffer | string,
  data: string
): Promise<ArrayBuffer> {
  const keyBuffer = typeof key === 'string' ? encodeUtf8(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encodeUtf8(data));
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeCanonicalUri(bucketName: string, objectKey: string): string {
  const segments = [bucketName, ...objectKey.split('/')].map(encodeRfc3986);
  return `/${segments.join('/')}`;
}

function formatAmzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = now.getUTCFullYear();
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hour = pad(now.getUTCHours());
  const minute = pad(now.getUTCMinutes());
  const second = pad(now.getUTCSeconds());
  const dateStamp = `${year}${month}${day}`;
  return {
    dateStamp,
    amzDate: `${dateStamp}T${hour}${minute}${second}Z`
  };
}

export function resolveR2SignerConfig(env: WorkerBindings): R2SignerConfig {
  const accountId = env.R2_ACCOUNT_ID?.trim() ?? '';
  const bucketName = env.R2_BUCKET_NAME?.trim() ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? '';

  if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
    throw new AppError(
      503,
      'INTERNAL_ERROR',
      'R2 서명 URL 발급에 필요한 환경 변수가 설정되지 않았습니다.'
    );
  }

  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

export function buildCaptureObjectKey(
  scope: UserScope,
  captureId: string,
  seq: number,
  contentType: CaptureUploadMime
): string {
  const ext = contentType === 'image/webp' ? 'webp' : 'jpg';
  return `users/${scope.uid}/captures/${captureId}/${seq}.${ext}`;
}

export function assertOwnerObjectKey(
  scope: UserScope,
  objectKey: string,
  subPrefix?: string
): void {
  const trimmed = objectKey.trim();
  const requiredPrefix = subPrefix
    ? `users/${scope.uid}/${subPrefix}`
    : `users/${scope.uid}/`;

  if (
    trimmed !== objectKey ||
    trimmed.includes('..') ||
    trimmed.includes('\\') ||
    trimmed.includes('//') ||
    !trimmed.startsWith(requiredPrefix)
  ) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '요청자 소유 경로(users/{uid}/...)와 일치하지 않는 R2 객체 키입니다.'
    );
  }
}

async function signR2Url(params: {
  method: 'PUT' | 'GET';
  config: R2SignerConfig;
  objectKey: string;
  expiresInSeconds: number;
  contentType?: CaptureUploadMime;
  contentLength?: number;
  now?: Date;
}): Promise<PresignedUrlResult> {
  const now = params.now ?? new Date();
  const { amzDate, dateStamp } = formatAmzTimestamps(now);
  const host = `${params.config.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = encodeCanonicalUri(params.config.bucketName, params.objectKey);
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const headerEntries: Array<[string, string]> = [['host', host]];
  if (params.contentType) {
    headerEntries.push(['content-type', params.contentType]);
  }
  if (params.contentLength !== undefined) {
    headerEntries.push(['content-length', String(params.contentLength)]);
  }
  headerEntries.sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = `${headerEntries.map(([k, v]) => `${k}:${v}`).join('\n')}\n`;
  const signedHeaders = headerEntries.map(([k]) => k).join(';');

  const queryParams: Array<[string, string]> = [
    ['X-Amz-Algorithm', AWS_ALGORITHM],
    ['X-Amz-Credential', `${params.config.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(params.expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders]
  ];
  queryParams.sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');

  const signingKey = await deriveSigningKey(
    params.config.secretAccessKey,
    dateStamp,
    R2_REGION,
    R2_SERVICE
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const url = `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  const expiresAt = new Date(now.getTime() + params.expiresInSeconds * 1000).toISOString();

  return {
    objectKey: params.objectKey,
    url,
    expiresInSeconds: params.expiresInSeconds,
    expiresAt
  };
}

export async function presignR2PutUrl(
  scope: UserScope,
  config: R2SignerConfig,
  params: {
    objectKey: string;
    contentType: CaptureUploadMime;
    byteSize: number;
    expiresInSeconds?: number;
    now?: Date;
  }
): Promise<PresignedUrlResult> {
  // Double-check owner prefix immediately before signing
  assertOwnerObjectKey(scope, params.objectKey);

  if (!ALLOWED_UPLOAD_MIMES.has(params.contentType)) {
    throw new AppError(400, 'VALIDATION_ERROR', '허용되지 않는 이미지 형식입니다. (webp/jpeg만 허용)');
  }
  if (!Number.isInteger(params.byteSize) || params.byteSize <= 0 || params.byteSize > MAX_CAPTURE_FILE_BYTES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `파일 크기는 1바이트 이상 ${MAX_CAPTURE_FILE_BYTES}바이트 이하여야 합니다.`
    );
  }

  return signR2Url({
    method: 'PUT',
    config,
    objectKey: params.objectKey,
    contentType: params.contentType,
    contentLength: params.byteSize,
    expiresInSeconds: params.expiresInSeconds ?? R2_PUT_EXPIRES_SECONDS,
    now: params.now
  });
}

export async function presignR2GetUrl(
  scope: UserScope,
  config: R2SignerConfig,
  params: {
    objectKey: string;
    expiresInSeconds?: number;
    now?: Date;
  }
): Promise<PresignedUrlResult> {
  // Double-check owner prefix immediately before signing
  assertOwnerObjectKey(scope, params.objectKey);

  return signR2Url({
    method: 'GET',
    config,
    objectKey: params.objectKey,
    expiresInSeconds: params.expiresInSeconds ?? R2_GET_EXPIRES_SECONDS,
    now: params.now
  });
}
