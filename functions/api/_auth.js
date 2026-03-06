// Auth utilities — JWT + password hashing using Web Crypto API
// (No Node.js dependencies, works in Cloudflare Workers)

const JWT_ALG = { name: 'HMAC', hash: 'SHA-256' };
const JWT_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds

// ── JWT ──

export async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + JWT_EXPIRY };

  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const bodyB64 = base64url(JSON.stringify(body));
  const signingInput = `${headerB64}.${bodyB64}`;

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), JWT_ALG, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));

  return `${signingInput}.${base64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, sigB64] = parts;
  const enc = new TextEncoder();
  const signingInput = `${headerB64}.${bodyB64}`;

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), JWT_ALG, false, ['verify']);
  const sig = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(signingInput));

  if (!valid) return null;

  const payload = JSON.parse(atob(bodyB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ── Password Hashing (PBKDF2) ──

export async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return {
    hash: bufToHex(hash),
    salt: bufToHex(salt),
  };
}

export async function verifyPassword(password, hash, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBuf(saltHex);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return bufToHex(derived) === hash;
}

// ── Auth Middleware Helper ──

export async function requireAuth(context) {
  const auth = context.request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7);
  const secret = context.env.JWT_SECRET || 'prism-default-secret-change-me';
  const payload = await verifyJWT(token, secret);
  return payload;
}

// ── Base64url / Hex helpers ──

function base64url(input) {
  if (typeof input === 'string') {
    return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // ArrayBuffer
  const bytes = new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes.buffer;
}
