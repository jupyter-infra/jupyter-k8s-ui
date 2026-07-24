import { Paper, Stack, Typography, Chip, Box, Divider } from '@mui/material';
import type { DiscoveredTemplate } from '../../../types';
import { strings } from '../../../constants';

export interface TemplateGuidancePanelProps {
  template: DiscoveredTemplate | null;
}

function range(min?: string, max?: string, fallback?: string): string | null {
  return min || max ? `[${min ?? '—'}, ${max ?? '—'}]` : (fallback ?? null);
}

// A row in the outer bounds grid: a label in the first column, its value(s) in the
// second. Rendered via the parent's CSS grid (two columns).
function boundsRow(label: string, value: React.ReactNode) {
  return (
    <>
      <Typography variant="caption" fontWeight={600} color="text.secondary" sx={{ pr: 1 }}>
        {label}
      </Typography>
      <Box sx={{ minWidth: 0 }}>{value}</Box>
    </>
  );
}

// A set of `label: value` pairs (e.g. CPU/Memory, Size) laid out as a nested two-column
// grid so the colons/values align.
function pairGrid(pairs: Array<{ label: string; value: string }>) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 0.75, rowGap: 0.25, alignItems: 'baseline' }}>
      {pairs.map(({ label, value }) => (
        <Box key={label} sx={{ display: 'contents' }}>
          <Typography variant="caption" color="text.secondary">{`${label}:`}</Typography>
          <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Read-only reference for the selected template, rendered as a strip above the editor:
 * a header (display name + source-namespace pill, then description) over a labeled
 * "Bounds" grid (Images / Resources / Storage / Idle shutdown). Purely informational —
 * it never gates anything; the server dry-run is the authoritative check.
 */
export function TemplateGuidancePanel({ template }: TemplateGuidancePanelProps) {
  const { workspace: ws } = strings;
  if (!template) return null;
  const spec = template.spec;
  const bounds = spec.resourceBounds?.resources;
  const storage = spec.primaryStorage;
  const idle = spec.idleShutdownOverrides;

  const cpu = range(bounds?.cpu?.min, bounds?.cpu?.max);
  const memory = range(bounds?.memory?.min, bounds?.memory?.max);
  const gpu = range(bounds?.['nvidia.com/gpu']?.min, bounds?.['nvidia.com/gpu']?.max);
  const storageRange = range(storage?.minSize, storage?.maxSize, storage?.defaultSize);
  const idleRange =
    idle && (idle.minIdleTimeoutInMinutes != null || idle.maxIdleTimeoutInMinutes != null)
      ? range(idle.minIdleTimeoutInMinutes?.toString(), idle.maxIdleTimeoutInMinutes?.toString())
      : null;
  // Idle: line 1 is a bare status word — "Required" (the on/off toggle is fixed, allow ===
  // false) or "Optional" — and line 2 is the timeout range. Shown whenever the template
  // declares an idleShutdownOverrides block. Mirrors resolveIdle's freeze condition:
  // only an explicit allow:false locks the toggle; an unset allow (block present) is
  // Optional.
  const idleNode = idle ? (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <Typography variant="caption">{idle.allow === false ? ws.guidanceIdleRequired : ws.guidanceIdleOptional}</Typography>
      {idleRange && (
        <Typography variant="caption" color="text.secondary">
          {`${ws.guidanceIdleTimeout}: ${idleRange}`}
        </Typography>
      )}
    </Stack>
  ) : null;

  // Images: one image per line. A template can allow custom images AND still curate an
  // allowedImages list (suggestions) — show both: list the images under a "custom also
  // allowed" note. Custom-only (no list) → "any image"; no custom → the fixed list or the
  // default-image-only fallback.
  const hasAllowed = spec.allowedImages != null && spec.allowedImages.length > 0;
  const imageLines = spec.allowCustomImages
    ? hasAllowed
      ? [ws.guidanceAnyImagePlus, ...spec.allowedImages!]
      : [ws.guidanceAnyImage]
    : hasAllowed
      ? spec.allowedImages!
      : [spec.defaultImage ?? ws.guidanceDefaultImageOnly];

  // Resources: one `label: range` pair per constrained resource (CPU / Memory / GPU).
  const resourcePairs: Array<{ label: string; value: string }> = [];
  if (cpu) resourcePairs.push({ label: ws.guidanceCpu, value: cpu });
  if (memory) resourcePairs.push({ label: ws.guidanceMemory, value: memory });
  if (gpu) resourcePairs.push({ label: ws.guidanceGpu, value: gpu });

  return (
    <Paper variant="outlined">
      <Stack spacing={1} padding={2}>
        {/* Header: display name + source namespace, then description */}
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2">{spec.displayName || template.metadata.name}</Typography>
            <Chip size="small" variant="outlined" label={template.sourceNamespace} />
          </Stack>
          {spec.description && (
            <Typography variant="caption" color="text.secondary">
              {spec.description}
            </Typography>
          )}
        </Stack>

        <Divider />

        {/* Bounds section: label | value grid */}
        <Typography variant="caption" fontWeight={600}>
          {ws.guidanceBoundsHeader}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.5, alignItems: 'baseline' }}>
          {boundsRow(
            ws.guidanceImages,
            <Stack spacing={0.25} sx={{ minWidth: 0 }}>
              {imageLines.map((img, i) => (
                <Typography key={i} variant="caption" sx={{ wordBreak: 'break-all' }}>
                  {img}
                </Typography>
              ))}
            </Stack>,
          )}
          {resourcePairs.length > 0 && boundsRow(ws.guidanceResources, pairGrid(resourcePairs))}
          {storageRange && boundsRow(ws.guidanceStorage, pairGrid([{ label: ws.guidanceStorageSize, value: storageRange }]))}
          {idleNode && boundsRow(ws.guidanceIdleShutdown, idleNode)}
        </Box>
      </Stack>
    </Paper>
  );
}
