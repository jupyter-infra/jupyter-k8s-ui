/**
 * Decode a JWT payload without verification.
 * Returns null if the token is malformed.
 */
export function decodeJWTPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
