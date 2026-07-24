import { describe, test, expect } from 'bun:test';
import { resolveTemplateControls, resolveDefaultTemplate, computeCpuRequest, computeMemoryRequest, conformAxis, conformImage } from './templateBounds';
import type { WorkspaceTemplate, WorkspaceTemplateSpec, DiscoveredTemplate } from '../types';
import { STATIC_DEFAULTS, resourceBounds, RESOURCE_DEFAULTS, IDLE_SHUTDOWN_DEFAULTS, DEFAULT_TEMPLATE_LABEL } from '../constants';

function tmpl(spec: WorkspaceTemplateSpec, name = 'eks-oidc', namespace = 'shared'): WorkspaceTemplate {
  return { metadata: { name, namespace }, spec };
}

describe('resolveTemplateControls — no template', () => {
  const r = resolveTemplateControls(null);

  test('uses static bounds and STATIC_DEFAULTS for each axis', () => {
    expect(r.cpu).toEqual({ min: resourceBounds.cpu.min, max: resourceBounds.cpu.max, step: resourceBounds.cpu.step, default: STATIC_DEFAULTS.cpu });
    expect(r.memory.default).toBe(STATIC_DEFAULTS.memory);
    expect(r.storage.default).toBe(STATIC_DEFAULTS.storage);
  });

  test('image mode is free and idle is unavailable', () => {
    expect(r.image.mode).toBe('free');
    expect(r.idle).toEqual({ available: false });
  });

  test('access defaults Public, ownership defaults OwnerOnly (decoupled)', () => {
    expect(r.accessType).toBe('Public');
    expect(r.ownershipType).toBe('OwnerOnly');
  });

  test('both request policies are ratio (no template requests)', () => {
    expect(r.requestsPolicy.cpu).toEqual({ source: 'ratio' });
    expect(r.requestsPolicy.memory).toEqual({ source: 'ratio' });
  });

  test('no templateRef unless a preserved ref is passed (create path)', () => {
    expect(r.templateRef).toBeUndefined();
    const withRef = resolveTemplateControls(null, { name: 'ghost', namespace: 'ns' });
    expect(withRef.templateRef).toEqual({ name: 'ghost', namespace: 'ns' });
    expect(withRef.hasTemplate).toBe(false); // static controls, ref preserved
  });
});

describe('resolveTemplateControls — resource bounds & defaults', () => {
  test('reads cpu/memory bounds and the limit as the slider default', () => {
    const r = resolveTemplateControls(
      tmpl({
        resourceBounds: { resources: { cpu: { min: '1', max: '4' }, memory: { min: '1Gi', max: '8Gi' } } },
        defaultResources: { limits: { cpu: '2', memory: '4Gi' } },
      }),
    );
    expect(r.cpu.min).toBe(1);
    expect(r.cpu.max).toBe(4);
    expect(r.cpu.default).toBe(2);
    expect(r.memory.min).toBe(1);
    expect(r.memory.max).toBe(8);
    expect(r.memory.default).toBe(4);
  });

  test('clamps a template default that sits outside its own bounds (author error)', () => {
    const r = resolveTemplateControls(
      tmpl({
        resourceBounds: { resources: { cpu: { min: '1', max: '4' } } },
        defaultResources: { limits: { cpu: '8' } }, // above max
      }),
    );
    expect(r.cpu.default).toBe(4);
  });

  test('falls back to the static bound per-axis when a template omits it', () => {
    // memory bound present, cpu bound absent → cpu uses static bounds.
    const r = resolveTemplateControls(tmpl({ resourceBounds: { resources: { memory: { min: '2Gi', max: '4Gi' } } } }));
    expect(r.cpu.min).toBe(resourceBounds.cpu.min);
    expect(r.cpu.max).toBe(resourceBounds.cpu.max);
    expect(r.memory.min).toBe(2);
    expect(r.memory.max).toBe(4);
  });

  test('rounds a memory min UP to the nearest step so the slider never offers a sub-min value', () => {
    // 256Mi = 0.25Gi; step is 1 → min rounds up to 1.
    const r = resolveTemplateControls(tmpl({ resourceBounds: { resources: { memory: { min: '256Mi', max: '8Gi' } } } }));
    expect(r.memory.min).toBe(1);
  });
});

describe('resolveTemplateControls — requests policy', () => {
  test('template-verbatim request when the template declares one; ratio otherwise', () => {
    const r = resolveTemplateControls(
      tmpl({
        defaultResources: { requests: { cpu: '500m' }, limits: { cpu: '2', memory: '4Gi' } },
        resourceBounds: { resources: { cpu: { min: '1', max: '4' }, memory: { min: '1Gi', max: '8Gi' } } },
      }),
    );
    // cpu request is template-verbatim; memory has no request → ratio.
    expect(r.requestsPolicy.cpu).toEqual({ source: 'template', value: '500m' });
    expect(r.requestsPolicy.memory).toEqual({ source: 'ratio' });
  });

  test('a fixed template request floors the slider effective min (limit >= request)', () => {
    // cpu request 2 (fixed), bound min 1 → slider min must rise to 2, not 1.
    const r = resolveTemplateControls(
      tmpl({
        defaultResources: { requests: { cpu: '2' }, limits: { cpu: '3' } },
        resourceBounds: { resources: { cpu: { min: '1', max: '4' } } },
      }),
    );
    expect(r.cpu.min).toBe(2);
  });

  test('ratio request does NOT floor the slider min (scales below the limit)', () => {
    const r = resolveTemplateControls(tmpl({ resourceBounds: { resources: { cpu: { min: '1', max: '4' } } } }));
    expect(r.cpu.min).toBe(1);
  });
});

describe('resolveTemplateControls — image', () => {
  test('allowCustomImages → free', () => {
    expect(resolveTemplateControls(tmpl({ defaultImage: 'x', allowCustomImages: true })).image.mode).toBe('free');
  });

  test('allowCustomImages carries allowedImages ∪ defaultImage as suggestions (defaultImage first, deduped)', () => {
    const r = resolveTemplateControls(tmpl({ defaultImage: 'a:1', allowedImages: ['a:1', 'b:2'], allowCustomImages: true }));
    expect(r.image.mode).toBe('free');
    expect(r.image.value).toBe('a:1');
    expect(r.image.options).toEqual(['a:1', 'b:2']); // defaultImage first, not duplicated
  });

  test('allowCustomImages with no defaultImage → suggestions are just allowedImages (no empty entry)', () => {
    const r = resolveTemplateControls(tmpl({ allowedImages: ['b:2'], allowCustomImages: true }));
    expect(r.image.options).toEqual(['b:2']);
  });

  test('populated allowedImages → select, preselect defaultImage, NO prepend', () => {
    const r = resolveTemplateControls(tmpl({ defaultImage: 'a:1', allowedImages: ['a:1', 'b:2'] }));
    expect(r.image.mode).toBe('select');
    expect(r.image.value).toBe('a:1');
    expect(r.image.options).toEqual(['a:1', 'b:2']); // defaultImage not prepended
  });

  test('empty allowedImages, no custom → fixed (defaultImage only)', () => {
    const r = resolveTemplateControls(tmpl({ defaultImage: 'only:1' }));
    expect(r.image.mode).toBe('fixed');
    expect(r.image.value).toBe('only:1');
  });
});

describe('resolveTemplateControls — idle three states', () => {
  test('no defaultIdleShutdown → unavailable', () => {
    expect(resolveTemplateControls(tmpl({})).idle).toEqual({ available: false });
  });

  test('allow:true → interactive, timeout bounds from overrides, detection echoed', () => {
    const detection = { httpGet: { port: 8888 } };
    const r = resolveTemplateControls(
      tmpl({
        defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 60, detection },
        idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 15, maxIdleTimeoutInMinutes: 480 },
      }),
    );
    expect(r.idle).toEqual({
      available: true,
      enabledDefault: true,
      toggleFrozen: false,
      timeout: { min: 15, max: 480, default: 60, step: IDLE_SHUTDOWN_DEFAULTS.STEP },
      detection,
    });
  });

  test('overrides block present but allow unset → interactive (freeze only on allow===false)', () => {
    // A served template can't actually carry an unset allow (the API server fills allow:true
    // whenever the block is present), but if one does we must NOT freeze — the operator would
    // admit toggling idle. Freeze is gated on an explicit allow===false, not allow!==true.
    const r = resolveTemplateControls(tmpl({ defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30 }, idleShutdownOverrides: {} }));
    expect(r.idle).toMatchObject({ available: true, toggleFrozen: false, timeout: { min: 1, max: IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT } });
  });

  test('defaultIdleShutdown but NO overrides block → interactive, editable 1..480', () => {
    // Absent overrides block: the operator skips idle validation entirely, so the user is
    // free to toggle idle and set any timeout. (Regression: previously froze the toggle.)
    const r = resolveTemplateControls(tmpl({ defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30 } }));
    expect(r.idle).toMatchObject({ available: true, toggleFrozen: false, timeout: { min: 1, max: IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT, default: 30 } });
  });

  test('allow:false + both bounds omitted → timeout pinned to default (min=max=default)', () => {
    const r = resolveTemplateControls(tmpl({ defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30 }, idleShutdownOverrides: { allow: false } }));
    expect(r.idle).toMatchObject({ available: true, toggleFrozen: true, timeout: { min: 30, max: 30, default: 30 } });
  });

  test('allow:true, bounds omitted → 1..480 window', () => {
    const r = resolveTemplateControls(tmpl({ defaultIdleShutdown: { enabled: false, idleTimeoutInMinutes: 45 }, idleShutdownOverrides: { allow: true } }));
    expect(r.idle).toMatchObject({ available: true, toggleFrozen: false, timeout: { min: 1, max: IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT, default: 45 } });
  });
});

describe('resolveTemplateControls — access seed', () => {
  test('seeds accessType and ownershipType independently from template defaults', () => {
    const r = resolveTemplateControls(tmpl({ defaultAccessType: 'Public', defaultOwnershipType: 'OwnerOnly' }));
    expect(r.accessType).toBe('Public');
    expect(r.ownershipType).toBe('OwnerOnly');
  });

  test('falls back to Public/OwnerOnly when template omits them', () => {
    const r = resolveTemplateControls(tmpl({}));
    expect(r.accessType).toBe('Public');
    expect(r.ownershipType).toBe('OwnerOnly');
  });
});

describe('resolveDefaultTemplate — A8 own-ns beats shared-ns precedence', () => {
  const ns = { own: 'user-ns', shared: 'shared-ns' };
  function disc(name: string, sourceNamespace: string, isDefault: boolean): DiscoveredTemplate {
    return {
      metadata: { name, namespace: sourceNamespace, ...(isDefault && { labels: { [DEFAULT_TEMPLATE_LABEL]: 'true' } }) },
      spec: {},
      sourceNamespace,
    };
  }

  test('returns null when none is flagged', () => {
    expect(resolveDefaultTemplate([disc('a', 'user-ns', false), disc('b', 'shared-ns', false)], ns)).toBeNull();
  });

  test('picks the own-namespace default over a shared-namespace default', () => {
    const result = resolveDefaultTemplate([disc('shared-def', 'shared-ns', true), disc('own-def', 'user-ns', true)], ns);
    expect(result?.metadata.name).toBe('own-def');
  });

  test('falls back to the shared default when no own-ns default exists', () => {
    const result = resolveDefaultTemplate([disc('a', 'user-ns', false), disc('shared-def', 'shared-ns', true)], ns);
    expect(result?.metadata.name).toBe('shared-def');
  });

  test('without namespace context, returns any flagged default', () => {
    const result = resolveDefaultTemplate([disc('a', 'x', false), disc('def', 'y', true)], undefined);
    expect(result?.metadata.name).toBe('def');
  });
});

describe('conformAxis', () => {
  const control = { min: 1, max: 4, default: 2, step: 1 };

  test('in-bounds value is unchanged, no adjustment', () => {
    expect(conformAxis('cpu', 3, control, 'cores')).toEqual({ value: 3, adjustments: [] });
  });

  test('above-max value clamps down and records the adjustment', () => {
    const r = conformAxis('cpu', 6, control, 'cores');
    expect(r.value).toBe(4);
    expect(r.adjustments).toEqual([{ field: 'cpu', from: '6 cores', to: '4 cores' }]);
  });

  test('below-min value clamps up and records the adjustment', () => {
    const r = conformAxis('memory', 0.5, control, 'GB');
    expect(r.value).toBe(1);
    expect(r.adjustments[0]).toMatchObject({ field: 'memory', to: '1 GB' });
  });
});

describe('conformImage', () => {
  test('free mode keeps any stored image', () => {
    expect(conformImage('anything:1', { mode: 'free', value: '', options: [] })).toEqual({ value: 'anything:1', adjustments: [] });
  });

  test('select mode keeps a permitted image', () => {
    expect(conformImage('a:1', { mode: 'select', value: 'a:1', options: ['a:1', 'b:2'] }).adjustments).toEqual([]);
  });

  test('select mode resets a non-permitted image to the default and records it', () => {
    const r = conformImage('evil:1', { mode: 'select', value: 'a:1', options: ['a:1', 'b:2'] });
    expect(r.value).toBe('a:1');
    expect(r.adjustments).toEqual([{ field: 'image', from: 'evil:1', to: 'a:1' }]);
  });

  test('fixed mode resets a differing image to the fixed default', () => {
    const r = conformImage('other:1', { mode: 'fixed', value: 'only:1', options: [] });
    expect(r.value).toBe('only:1');
    expect(r.adjustments[0]).toMatchObject({ from: 'other:1', to: 'only:1' });
  });
});

describe('computeCpuRequest / computeMemoryRequest', () => {
  test('template source returns the verbatim value', () => {
    expect(computeCpuRequest({ source: 'template', value: '500m' }, 4)).toBe('500m');
    expect(computeMemoryRequest({ source: 'template', value: '1Gi' }, 8)).toBe('1Gi');
  });

  test('ratio source = limit × ratio, floored by MIN_<RES>_REQUEST (no static-bounds floor)', () => {
    expect(computeCpuRequest({ source: 'ratio' }, 4)).toBe(`${4 * RESOURCE_DEFAULTS.CPU_REQUEST_RATIO}`);
    // tiny limit floored by MIN_CPU_REQUEST
    expect(computeCpuRequest({ source: 'ratio' }, 0.1)).toBe(`${RESOURCE_DEFAULTS.MIN_CPU_REQUEST}`);
    expect(computeMemoryRequest({ source: 'ratio' }, 8)).toBe(`${8 * RESOURCE_DEFAULTS.MEMORY_REQUEST_RATIO}Gi`);
  });
});
