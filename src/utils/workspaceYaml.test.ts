import { describe, expect, test } from 'bun:test';
import { specToYaml, yamlToSpec, orderSpecKeys } from './workspaceYaml';

describe('orderSpecKeys', () => {
  test('emits preferred keys first in curated order, remainder alphabetical', () => {
    const ordered = orderSpecKeys({
      templateRef: { name: 't' },
      accessType: 'Public',
      displayName: 'x',
      appType: 'jupyter',
      image: 'img',
    });
    expect(Object.keys(ordered)).toEqual([
      // curated order (only those present)
      'displayName',
      'image',
      'accessType',
      // remainder alphabetical
      'appType',
      'templateRef',
    ]);
  });
});

describe('specToYaml / yamlToSpec round-trip', () => {
  test('a populated spec survives serialize -> parse unchanged', () => {
    const spec = {
      displayName: 'My Workspace',
      image: 'jupyter/base:1.2',
      desiredStatus: 'Running' as const,
      resources: { limits: { cpu: '2', memory: '4Gi' } },
      idleShutdown: { enabled: true, idleTimeoutInMinutes: 30 },
    };
    const round = yamlToSpec(specToYaml(spec));
    expect(round.error).toBeNull();
    expect(round.spec).toEqual(spec);
  });

  test('key ordering is stable and human-friendly in the emitted YAML', () => {
    const yaml = specToYaml({ accessType: 'Public', displayName: 'x', image: 'i' });
    // displayName must appear before accessType regardless of input order
    expect(yaml.indexOf('displayName')).toBeLessThan(yaml.indexOf('accessType'));
    expect(yaml.indexOf('image')).toBeLessThan(yaml.indexOf('accessType'));
  });
});

describe('yamlToSpec error handling', () => {
  test('empty buffer parses to an empty spec, no error', () => {
    expect(yamlToSpec('   ')).toEqual({ spec: {}, error: null });
  });

  test('malformed YAML returns a syntax error, not a throw', () => {
    const res = yamlToSpec('displayName: "unterminated\n  bad: : :');
    expect(res.spec).toBeNull();
    expect(res.error).toBeTruthy();
  });

  test('a bare scalar is rejected — spec must be a mapping', () => {
    const res = yamlToSpec('just-a-string');
    expect(res.spec).toBeNull();
    expect(res.error).toMatch(/mapping/i);
  });

  test('a top-level list is rejected — spec must be a mapping', () => {
    const res = yamlToSpec('- a\n- b');
    expect(res.spec).toBeNull();
    expect(res.error).toMatch(/mapping/i);
  });
});
