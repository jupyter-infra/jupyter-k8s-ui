import { extractJWT, decodeJWTPayload } from '../middleware/auth';
import { jsonResponse, errorResponse } from '../responses';

export async function handleGetMe(req: Request): Promise<Response> {
  const jwt = extractJWT(req);
  if (!jwt) {
    return jsonResponse({ authenticated: false, user: null });
  }

  const payload = decodeJWTPayload(jwt);
  if (!payload) {
    return errorResponse(401, 'Invalid token');
  }

  return jsonResponse({
    authenticated: true,
    user: {
      username: payload.preferred_username || payload.sub,
      email: payload.email || null,
      groups: payload.groups || [],
    },
    claims: payload,
  });
}
