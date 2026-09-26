import { describe, expect, test } from 'bun:test';
import { get409ErrorMessage, handleK8sError } from '../responses';

describe('handleK8sError', () => {
  // Each mapped status code is a contract with the frontend — if the map changes,
  // the UI's error handling breaks silently. One test per distinct outcome.
  test.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'not found'],
    [422, 'Unprocessable'],
  ])('maps K8s %d to matching message', async (statusCode, expectedText) => {
    const err = Object.assign(new Error('x'), { statusCode });
    const res = handleK8sError(err, 'fallback');
    expect(res.status).toBe(statusCode);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain(expectedText.toLowerCase());
  });

  test('maps a 409 with reason Conflict to a concurrent-modification message', async () => {
    const err = Object.assign(new Error('x'), { statusCode: 409, body: { reason: 'Conflict', message: 'the object has been modified' } });
    const res = handleK8sError(err, 'fallback');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toContain('modified concurrently');
    expect(body.details).toBe('the object has been modified');
  });

  test('returns 500 with fallback message for unmapped status', async () => {
    const err = Object.assign(new Error('weird'), { statusCode: 999 });
    const res = handleK8sError(err, 'Something broke');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe('Something broke');
    expect(body.details).toBe('weird');
  });

  test('returns 500 for non-K8s error values', async () => {
    const res = handleK8sError('string error', 'fallback');
    expect(res.status).toBe(500);
  });

  // The advanced editor's dry-run validation needs the webhook's actual message, not
  // the generic mapped status string — so it must survive in `details`.
  test('surfaces the K8s Status body message as details on a 422', async () => {
    const err = Object.assign(new Error('422'), {
      statusCode: 422,
      body: { message: 'image "evil:latest" not permitted by template gpu-small' },
    });
    const res = handleK8sError(err, 'Failed to create workspace');
    const body = (await res.json()) as { error: string; details: string };
    expect(res.status).toBe(422);
    expect(body.details).toContain('not permitted by template gpu-small');
  });

  test('includes per-field causes from the Status body details', async () => {
    const err = Object.assign(new Error('422'), {
      statusCode: 422,
      body: {
        message: 'admission webhook denied the request',
        details: { causes: [{ field: 'spec.resources.limits.cpu', message: 'exceeds maximum 8' }] },
      },
    });
    const res = handleK8sError(err, 'fallback');
    const body = (await res.json()) as { details: string };
    expect(body.details).toContain('spec.resources.limits.cpu: exceeds maximum 8');
  });

  test('parses a stringified JSON body (client-node sometimes returns a string)', async () => {
    const err = Object.assign(new Error('422'), {
      statusCode: 422,
      body: JSON.stringify({ message: 'bad thing happened' }),
    });
    const res = handleK8sError(err, 'fallback');
    const body = (await res.json()) as { details: string };
    expect(body.details).toContain('bad thing happened');
  });
});

describe('get409ErrorMessage', () => {
  test('reason Conflict reads as a concurrent modification', () => {
    expect(get409ErrorMessage('Conflict')).toBe('Conflict — the resource was modified concurrently, try again');
  });

  test('reason AlreadyExists reads as an existing resource', () => {
    expect(get409ErrorMessage('AlreadyExists')).toBe('Resource already exists');
  });

  test('a missing reason reads as an existing resource', () => {
    expect(get409ErrorMessage(undefined)).toBe('Resource already exists');
  });
});
