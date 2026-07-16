import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildCreateScaffold } from './workspaceScaffold';
import { yamlToSpec } from './workspaceYaml';
import type { DiscoveredTemplate } from '../types';

function template(spec: Partial<DiscoveredTemplate['spec']>): DiscoveredTemplate {
  return { metadata: { name: 't', namespace: 'ns' }, sourceNamespace: 'ns', spec };
}

const DOCS = 'https://example.test/crd';

// templateRef and displayName are intentionally excluded from the scaffold — they're
// edited via dedicated controls above the editor (dropdown / text field), not typed
// into the YAML buffer.
const SCAFFOLD_EXCLUDES = new Set(['templateRef', 'displayName']);

// The generated Workspace CRD spec schema (source of truth). We compare the scaffold's
// top-level fields against this so the two can't silently drift apart when the CRD
// gains or loses a field. Regenerate with `bun run gen:crd`.
function crdSpecProperties(): string[] {
  const path = join(import.meta.dir, '..', '..', 'server', 'schema', 'vendored', 'workspaces.json');
  const schema = JSON.parse(readFileSync(path, 'utf8')) as { properties: Record<string, unknown> };
  return Object.keys(schema.properties);
}

// Pull the top-level field names out of the scaffold — both the active lines
// (`displayName:`) and the commented ones (`# image:`) — while ignoring prose comments
// (`# --- Common overrides ---`, the templateRef note, the `# see <url>` line), which
// never have a bare `key:` at the start.
function scaffoldTopLevelFields(scaffold: string): string[] {
  const keys: string[] = [];
  for (const line of scaffold.split('\n')) {
    const match = line.match(/^#?\s*([a-zA-Z][a-zA-Z0-9]*):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

describe('buildCreateScaffold', () => {
  test('active lines parse to exactly the required fields (everything else commented)', () => {
    const result = yamlToSpec(buildCreateScaffold(null, DOCS));
    expect(result.error).toBeNull();
    expect(result.spec).toEqual({ desiredStatus: 'Running' });
  });

  test('uses fallbacks when no template is selected', () => {
    const scaffold = buildCreateScaffold(null, DOCS);
    expect(scaffold).toContain('# image: registry/image:tag');
    expect(scaffold).toContain('# accessType: Public');
    expect(scaffold).toContain('# ownershipType: Public');
    expect(scaffold).toContain('# resources: {}');
    expect(scaffold).toContain('# env: []');
  });

  test("folds in the template's defaults when present", () => {
    const scaffold = buildCreateScaffold(
      template({
        defaultImage: 'jupyter/tf:1.2',
        defaultAccessType: 'OwnerOnly',
        defaultOwnershipType: 'OwnerOnly',
        defaultResources: { requests: { cpu: '1', memory: '2Gi' } },
        baseEnv: [{ name: 'TEAM', value: 'ml' }],
      }),
      DOCS,
    );
    expect(scaffold).toContain('# image: jupyter/tf:1.2');
    expect(scaffold).toContain('# accessType: OwnerOnly');
    expect(scaffold).toContain('# ownershipType: OwnerOnly');
    expect(scaffold).toContain('# resources: {"requests":{"cpu":"1","memory":"2Gi"}}');
    expect(scaffold).toContain('# env: [{"name":"TEAM","value":"ml"}]');
  });

  test('never scaffolds templateRef or displayName into the buffer (they are owned by the controls above)', () => {
    const scaffold = buildCreateScaffold(template({ defaultImage: 'x:1' }), DOCS);
    // No active or commented templateRef / displayName key — only the explanatory note.
    expect(scaffold).not.toMatch(/^#?\s*templateRef:/m);
    expect(scaffold).not.toMatch(/^#?\s*displayName:/m);
    expect(scaffold).toContain('controls above');
  });

  test('points advanced fields at the docs URL instead of inline help', () => {
    const scaffold = buildCreateScaffold(null, DOCS);
    expect(scaffold).toContain(DOCS);
    // advanced fields are listed bare, without trailing "# ..." inline descriptions
    expect(scaffold).toContain('# affinity: {}');
    expect(scaffold).not.toContain('node affinity / anti-affinity');
  });

  test('a commented example line parses correctly once uncommented', () => {
    const scaffold = buildCreateScaffold(template({ defaultResources: { requests: { cpu: '2' } } }), DOCS);
    const uncommented = scaffold.replace('# resources:', 'resources:');
    const result = yamlToSpec(uncommented);
    expect(result.error).toBeNull();
    expect(result.spec?.resources).toEqual({ requests: { cpu: '2' } });
  });

  describe('stays in sync with the Workspace CRD spec schema', () => {
    const scaffoldFields = new Set(scaffoldTopLevelFields(buildCreateScaffold(null, DOCS)));
    const crdFields = crdSpecProperties();

    test('every scaffold field is a real top-level spec field', () => {
      const unknown = [...scaffoldFields].filter((f) => !crdFields.includes(f));
      expect(unknown).toEqual([]);
    });

    test('every spec field is represented in the scaffold (except the excluded ones)', () => {
      const missing = crdFields.filter((f) => !SCAFFOLD_EXCLUDES.has(f) && !scaffoldFields.has(f));
      expect(missing).toEqual([]);
    });

    test('templateRef and displayName are the intentional exclusions, and are genuinely absent', () => {
      expect(crdFields).toContain('templateRef');
      expect(crdFields).toContain('displayName');
      expect(scaffoldFields.has('templateRef')).toBe(false);
      expect(scaffoldFields.has('displayName')).toBe(false);
    });
  });
});
