import { SignJWT } from 'jose';

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derTag(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeDerLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function derSequence(...items: Uint8Array[]): Uint8Array {
  return derTag(0x30, concat(...items));
}

function derSet(...items: Uint8Array[]): Uint8Array {
  return derTag(0x31, concat(...items));
}

function derInteger(bytes: Uint8Array): Uint8Array {
  const normalized = bytes[0]! & 0x80 ? concat(Uint8Array.of(0x00), bytes) : bytes;
  return derTag(0x02, normalized);
}

function derBitString(bytes: Uint8Array): Uint8Array {
  return derTag(0x03, concat(Uint8Array.of(0x00), bytes));
}

function derOid(encodedBytes: number[]): Uint8Array {
  return derTag(0x06, Uint8Array.from(encodedBytes));
}

function derUtf8String(value: string): Uint8Array {
  return derTag(0x0c, new TextEncoder().encode(value));
}

function derUtcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, '0');
  const str =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return derTag(0x17, new TextEncoder().encode(str));
}

function toPem(label: string, der: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < der.length; i++) binary += String.fromCharCode(der[i]!);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export interface TestCertKeyPair {
  kid: string;
  privateKey: CryptoKey;
  certPem: string;
}

export async function generateTestCertKeyPair(kid = 'test-kid-1'): Promise<TestCertKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', keyPair.publicKey)) as ArrayBuffer);
  // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
  const sigAlg = derSequence(
    derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Uint8Array.of(0x05, 0x00)
  );
  // CN=firebase-test
  const cnAttr = derSequence(derOid([0x55, 0x04, 0x03]), derUtf8String('firebase-test'));
  const name = derSequence(derSet(cnAttr));
  const now = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 86_400_000 * 30);
  const validity = derSequence(derUtcTime(now), derUtcTime(future));
  const version = derTag(0xa0, derInteger(Uint8Array.of(0x02))); // v3
  const serial = derInteger(Uint8Array.of(0x01));

  const tbs = derSequence(version, serial, sigAlg, name, validity, name, spki);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keyPair.privateKey, tbs)
  );
  const certDer = derSequence(tbs, sigAlg, derBitString(signature));

  return {
    kid,
    privateKey: keyPair.privateKey,
    certPem: toPem('CERTIFICATE', certDer)
  };
}

export interface SignFirebaseTokenOptions {
  keyPair: TestCertKeyPair;
  projectId?: string;
  sub?: string;
  email?: string;
  iat?: number;
  authTime?: number;
  exp?: number;
  aud?: string;
  iss?: string;
}

export async function signFirebaseToken(opts: SignFirebaseTokenOptions): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const projectId = opts.projectId ?? 'content-desk-b9c3d';
  const iat = opts.iat ?? nowSec;
  const authTime = opts.authTime ?? nowSec;
  const exp = opts.exp ?? nowSec + 3600;

  return new SignJWT({
    auth_time: authTime,
    email: opts.email ?? 'owner@example.com'
  })
    .setProtectedHeader({ alg: 'RS256', kid: opts.keyPair.kid })
    .setAudience(opts.aud ?? projectId)
    .setIssuer(opts.iss ?? `https://securetoken.google.com/${projectId}`)
    .setSubject(opts.sub ?? 'owner-uid-1')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(opts.keyPair.privateKey);
}
