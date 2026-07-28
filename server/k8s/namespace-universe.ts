// The namespace "universe" — the set of candidate namespaces the switcher may offer,
// before any per-user RBAC gate. Refreshed by a periodic SA re-LIST poll (NOT a watch:
// nothing consumes the universe in real time, so a poll has strictly fewer failure modes
// than a long-lived cluster-wide watch).
//
// The candidate source is try-then-fall-back, re-evaluated statelessly EVERY poll:
//   - SA listNamespace (label-selected) succeeds  -> universe = labeled set (+ default)
//   - 403 / Forbidden (SA lacks cluster list)      -> universe = static list (+ default)
//   - transient / 5xx / timeout                    -> keep last-known-good, retry next tick
// The configured `default` namespace is ALWAYS unioned in, so the universe (and the
// switcher/list) is never empty — full back-compat for a zero-config install.
//
// This is only a CANDIDATE list. Visibility is decided per-user by checkNamespaceAccess
// (SSAR with the user's token) — the universe never grants visibility on its own.

import { CoreV1Api, V1NamespaceList } from '@kubernetes/client-node';
import { loadKubeConfigBestEffort } from './client';
import { serverConfig, isLocalDevelopment } from './config';
import { log } from '../logger';

interface UniverseState {
  namespaces: string[];
  // Whether the last poll used the sa-list source (true) or the static fallback (false).
  // Only sa-list has a real universe to page; static's candidate set IS the config.
  fromSaList: boolean;
  // Set once the first poll resolves (success or fallback) — gates readiness.
  ready: boolean;
}

let state: UniverseState = { namespaces: [], fromSaList: false, ready: false };
let pollTimer: ReturnType<typeof setInterval> | null = null;

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number; code?: number })?.statusCode ?? (error as { code?: number })?.code;
}

/** Union the configured default into a candidate set, de-duplicated, order-stable. */
function withDefault(namespaces: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ns of [...namespaces, serverConfig.namespace]) {
    if (ns && !seen.has(ns)) {
      seen.add(ns);
      out.push(ns);
    }
  }
  return out;
}

/** The static-fallback candidate set (configured list, always incl. default). */
function staticUniverse(): string[] {
  return withDefault(serverConfig.namespaceSelection.staticNamespaces);
}

/**
 * One refresh cycle: try the SA label-list, fall back to static on 403, keep last-known-good
 * on transient errors. Stateless — no sticky "mode"; the source is re-decided every tick,
 * so an added/removed SA grant self-heals on the next poll. Called once at init, then
 * repeatedly by the poll timer.
 */
async function refreshNamespaceUniverse(coreApi: CoreV1Api): Promise<void> {
  try {
    const res = await coreApi.listNamespace(
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // _continue
      undefined, // fieldSelector
      serverConfig.namespaceSelection.labelSelector,
    );
    const list = res.body as V1NamespaceList;
    const names = (list.items ?? []).map((ns) => ns.metadata?.name).filter((n): n is string => Boolean(n));
    state = { namespaces: withDefault(names), fromSaList: true, ready: true };
  } catch (error) {
    const code = statusCodeOf(error);
    if (code === 403) {
      // Authorization failure: this install didn't grant the SA cluster-wide list.
      // Fall back to the static list. Warn — if we were previously on sa-list this is an
      // unexpected mid-run regression, not a normal steady state.
      if (state.fromSaList) {
        log('warn', 'SA lost cluster-wide list namespaces (403) — falling back to static namespace list');
      } else {
        log('info', 'SA cannot list namespaces (403) — using static namespace list');
      }
      state = { namespaces: staticUniverse(), fromSaList: false, ready: true };
    } else {
      // Transient / 5xx / timeout: DO NOT fall back (that would mask a reachable cluster
      // as "no access"). Keep last-known-good and retry next tick.
      log('warn', `Namespace universe poll failed (transient) — keeping last-known-good: ${error instanceof Error ? error.message : String(error)}`);
      if (!state.ready) {
        // Never resolved yet: seed with static so we can serve *something* and become
        // ready, rather than blocking startup on a flaky first call.
        state = { namespaces: staticUniverse(), fromSaList: false, ready: true };
      }
    }
  }
}

/**
 * Start the universe poll. In dev (no cluster) the universe is the static list and never
 * polls — the SA has nothing to hit and SSAR is bypassed (see access.ts). Resolves once
 * the first poll settles (readiness gate); subsequent polls run on the interval.
 */
export async function initNamespaceUniverse(): Promise<void> {
  if (isLocalDevelopment()) {
    state = { namespaces: staticUniverse(), fromSaList: false, ready: true };
    log('info', `Dev mode: static namespace universe [${state.namespaces.join(', ')}]`);
    return;
  }

  const kc = loadKubeConfigBestEffort();
  if (!kc) {
    log('error', 'Cannot load kubeconfig for namespace universe — using static list');
    state = { namespaces: staticUniverse(), fromSaList: false, ready: true };
    return;
  }

  const coreApi = kc.makeApiClient(CoreV1Api);

  // First refresh gates readiness (see isNamespaceUniverseReady).
  await refreshNamespaceUniverse(coreApi);

  const intervalMs = Math.max(5, serverConfig.namespaceSelection.pollIntervalSecs) * 1000;
  pollTimer = setInterval(() => {
    void refreshNamespaceUniverse(coreApi);
  }, intervalMs);

  log(
    'info',
    `Namespace universe poll started (every ${serverConfig.namespaceSelection.pollIntervalSecs}s, source=${state.fromSaList ? 'sa-list' : 'static'})`,
  );
}

/** Current candidate namespaces (always non-empty once ready — includes default). */
export function getNamespaceUniverse(): string[] {
  return state.namespaces;
}

/** True once the first poll has settled — used to gate pod readiness. */
export function isNamespaceUniverseReady(): boolean {
  return state.ready;
}

/** Whether the active source is sa-list (a real enumerable universe) vs. static config. */
export function isUniverseFromSaList(): boolean {
  return state.fromSaList;
}

/** Stop the poll (graceful shutdown). */
export function stopNamespaceUniverse(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
