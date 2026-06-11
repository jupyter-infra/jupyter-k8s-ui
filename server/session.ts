import { deriveKeys, encrypt, decrypt, sign, verify } from './crypto';
import type { SessionConfig } from './types';
import { log } from './logger';

// --- Types ---

export interface SessionPayload {
  /** Dex access token (JWT) */
  token: string;
  /** Unix timestamp (seconds) when this session was created */
  iat: number;
  /** Unix timestamp (seconds) when this session expires */
  exp: number;
  /** Key ID used for signing */
  kid: string;
}

export interface KeyEntry {
  kid: string;
  key: Buffer;
  /** Date.now() when this pod first saw the key */
  addedTime: number;
}

export interface KeyMap {
  keys: Map<string, KeyEntry>;
}

// --- Cookie Creation ---

/**
 * Create an encrypted+signed session cookie value.
 *
 * Returns null if:
 * - No signing key is available past cooloff
 * - The Dex token is within nearExpiryThreshold of expiry (Thread 10)
 * - The resulting cookie exceeds max size
 */
export function createSessionCookie(dexToken: string, keyMap: KeyMap, config: SessionConfig): string | null {
  const signingEntry = getSigningKey(keyMap, config.newKeyUseDelaySecs);
  if (!signingEntry) {
    log('warn', 'No signing key available past cooloff period');
    return null;
  }

  // Check if Dex token is near expiry (Thread 10)
  const dexExp = extractJwtExp(dexToken);
  const now = Math.floor(Date.now() / 1000);

  if (dexExp !== null && dexExp - now < config.nearExpiryThresholdSecs) {
    log('debug', 'Dex token near expiry, skipping cookie creation');
    return null;
  }

  // Session exp = min(now + maxSessionLifetime, dexTokenExp) (Thread 7)
  const sessionExp = dexExp !== null ? Math.min(now + config.maxSessionLifetimeSecs, dexExp) : now + config.maxSessionLifetimeSecs;

  const payload: SessionPayload = {
    token: dexToken,
    iat: now,
    exp: sessionExp,
    kid: signingEntry.kid,
  };

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const { encryptionKey, signingKey } = deriveKeys(signingEntry.key);
  const encrypted = encrypt(plaintext, encryptionKey);

  // Sign: HMAC(kid, encrypted_blob)
  const signature = sign(encrypted, signingKey, signingEntry.kid);

  // Wire format: base64url(encrypted) . kid . base64url(signature)
  const cookieValue = `${base64urlEncode(encrypted)}.${signingEntry.kid}.${base64urlEncode(signature)}`;

  if (cookieValue.length > config.cookieSizeMaxBytes) {
    log('error', `Cookie size ${cookieValue.length} exceeds max ${config.cookieSizeMaxBytes}, not setting cookie`);
    return null;
  }

  if (cookieValue.length > config.cookieSizeWarnBytes) {
    log('warn', `Cookie size ${cookieValue.length} exceeds warning threshold ${config.cookieSizeWarnBytes}`);
  }

  return cookieValue;
}

// --- Cookie Validation ---

/**
 * Validate and decrypt a session cookie, returning the payload.
 * Returns null if any validation step fails.
 */
export function validateSessionCookie(cookieValue: string, keyMap: KeyMap): SessionPayload | null {
  try {
    // Parse: base64url(encrypted) . kid . base64url(signature)
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;

    const [encryptedB64, kid, signatureB64] = parts;
    const encrypted = base64urlDecode(encryptedB64);
    const signature = base64urlDecode(signatureB64);

    // Look up key by kid
    const entry = keyMap.keys.get(kid);
    if (!entry) {
      // Fallback: try all keys (backward compat)
      for (const [, e] of keyMap.keys) {
        const result = tryValidate(encrypted, signature, e, kid);
        if (result) return result;
      }
      return null;
    }

    return tryValidate(encrypted, signature, entry, kid);
  } catch {
    return null;
  }
}

function tryValidate(encrypted: Buffer, signature: Buffer, entry: KeyEntry, kid: string): SessionPayload | null {
  try {
    const { encryptionKey, signingKey } = deriveKeys(entry.key);

    // Verify HMAC signature
    if (!verify(encrypted, signature, signingKey, kid)) return null;

    // Decrypt
    const plaintext = decrypt(encrypted, encryptionKey);
    const payload = JSON.parse(plaintext.toString('utf-8')) as SessionPayload;

    // Check session expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    // Check embedded Dex token expiry
    const dexExp = extractJwtExp(payload.token);
    if (dexExp !== null && dexExp <= now) return null;

    return payload;
  } catch {
    return null;
  }
}

// --- Set-Cookie Header ---

/**
 * Build a Set-Cookie header value with security attributes.
 */
export function buildSetCookieHeader(cookieValue: string, config: SessionConfig): string {
  const parts = [
    `${config.cookieName}=${cookieValue}`,
    `Path=${config.cookiePath}`,
    `Max-Age=${config.cookieMaxAgeSecs}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];

  return parts.join('; ');
}

/**
 * Build a Set-Cookie header that expires the session cookie.
 *
 * Traefik routes requests with a session cookie present (HeaderRegexp match)
 * directly to Bun, bypassing OAuth2 Proxy. When the embedded Dex token expires,
 * the cookie becomes invalid but still triggers the fast path — trapping the
 * user in an auth loop. Clearing it on 401 lets subsequent requests fall to
 * the auth-path route where OAuth2 Proxy initiates a fresh OIDC flow.
 */
export function buildClearCookieHeader(config: SessionConfig): string {
  const parts = [`${config.cookieName}=`, `Path=${config.cookiePath}`, 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Lax'];

  return parts.join('; ');
}

// --- Key Management ---

/**
 * Get the newest key that has passed the cooloff period.
 */
export function getSigningKey(keyMap: KeyMap, newKeyUseDelaySecs: number): KeyEntry | null {
  const now = Date.now();
  let best: KeyEntry | null = null;

  for (const [, entry] of keyMap.keys) {
    const elapsed = (now - entry.addedTime) / 1000;
    if (elapsed >= newKeyUseDelaySecs) {
      if (!best || entry.kid > best.kid) {
        best = entry;
      }
    }
  }

  return best;
}

// --- Cookie Parsing ---

/**
 * Extract a named cookie value from a Cookie header string.
 */
export function parseCookieValue(cookieHeader: string, cookieName: string): string | null {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name === cookieName) {
      return valueParts.join('=');
    }
  }
  return null;
}

// --- Helpers ---

/**
 * Extract the exp claim from a JWT without verification.
 * Returns null if the token is malformed or has no exp.
 */
function extractJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}
