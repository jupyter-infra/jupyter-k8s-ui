// Builds the initial YAML buffer for advanced *create*: a self-documenting scaffold
// where the required fields are active and every other common top-level spec field is
// present but commented out, each with a one-line description. Uncommenting a line
// gives the user a ready starting point; the schema + dry-run validate the rest.
//
// When a template is selected, its defaults are folded into the commented values
// (image, env, resources, accessType, ownershipType); otherwise sensible fallbacks are
// used. templateRef and displayName are deliberately absent — they're owned by the
// dedicated controls above the editor (dropdown / text field), not the YAML buffer.

import type { DiscoveredTemplate } from '../types';

// Render a small value as single-line (flow-style) YAML for embedding in a commented
// line. JSON is valid YAML flow syntax and stays on one line, which is exactly what we
// want for scaffold examples like `[]`, `{}`, or `{"requests":{"cpu":"1"}}`.
function inline(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Produce the create-mode scaffold. `template` is the resolved template selected in
 * the dropdown, or null when none is selected / discovery is unavailable. `docsUrl` is
 * the CRD reference link surfaced for the advanced fields (which are listed without
 * inline help — the docs are the source of truth for their shapes).
 */
export function buildCreateScaffold(template: DiscoveredTemplate | null, docsUrl: string): string {
  const spec = template?.spec;

  // Template-aware commented values, each with a fallback when the template is absent
  // or doesn't set that default.
  const image = spec?.defaultImage ?? 'registry/image:tag';
  const env = spec?.baseEnv && spec.baseEnv.length > 0 ? inline(spec.baseEnv) : '[]';
  const resources = spec?.defaultResources ? inline(spec.defaultResources) : '{}';
  const accessType = spec?.defaultAccessType ?? 'Public';
  const ownershipType = spec?.defaultOwnershipType ?? 'Public';

  return [
    'desiredStatus: Running',
    '',
    '# --- Common overrides ---',
    '# name / displayName / templateRef are set via the controls above — not here.',
    `# image: ${image}`,
    `# accessType: ${accessType}`,
    `# ownershipType: ${ownershipType}`,
    `# resources: ${resources}`,
    '# storage: { size: 10Gi }',
    '# idleShutdown: { enabled: true, idleTimeoutInMinutes: 30 }',
    `# env: ${env}`,
    '# appType: jupyterlab',
    '',
    '# --- Advanced fields ---',
    `# see ${docsUrl}`,
    '# accessStrategy: { name: my-access-strategy }',
    '# serviceAccountName: my-service-account',
    '# nodeSelector: {}',
    '# affinity: {}',
    '# tolerations: []',
    '# volumes: []',
    '# initContainers: []',
    '# containerConfig: {}',
    '# lifecycle: {}',
    '# readinessProbe: {}',
    '# podSecurityContext: {}',
    '# containerSecurityContext: {}',
    '',
  ].join('\n');
}
