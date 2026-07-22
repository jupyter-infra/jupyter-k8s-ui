// Template selection grid for the simple create form.
//
// Renders a responsive grid of template cards plus (conditionally) a "no template" card,
// implementing preselection matrix and the own-ns-beats-shared default precedence.
// Selection model: `selected: DiscoveredTemplate | null`, where null == the
// no-template card (static bounds, no templateRef).
//
// Preselection matrix (create):
//   | 0 templates                       | render nothing; parent treats as no-template     |
//   | 1 template flagged default        | render nothing; auto-select that template         |
//   | 1 template not flagged            | grid: it + no-template; preselect no-template     |
//   | ≥2, one flagged default           | grid: all (NO no-template card); preselect default |
//   | ≥2, none flagged                  | grid: all + no-template; preselect no-template    |
//
// No-template visibility rule: show it whenever the grid shows EXCEPT when a default is
// flagged (respect admin intent — and the operator would inject the default onto a
// ref-less submit anyway, so no-template isn't a real outcome there).

import { useEffect, useMemo } from 'react';
import { Box, Skeleton, Stack, Typography, Alert } from '@mui/material';
import type { DiscoveredTemplate, DiscoveryResponse } from '../../types';
import { strings } from '../../constants';
import { resolveDefaultTemplate } from '../../utils';
import { TemplateCard, NoTemplateCard } from './TemplateCard';

interface TemplatePickerProps {
  query: {
    data?: DiscoveryResponse<DiscoveredTemplate>;
    isLoading: boolean;
    isError: boolean;
  };
  selected: DiscoveredTemplate | null;
  onSelect: (template: DiscoveredTemplate | null) => void;
  // Reports the initial (auto-)selection to the parent so it can seed its shared state.
  // Called once when the template list first resolves. `hidden` = the picker renders
  // nothing (0 templates, or a single flagged default) and the parent should just adopt
  // the reported selection silently.
  onInitialResolved?: (result: { selection: DiscoveredTemplate | null; hidden: boolean }) => void;
}

const GRID_SX = {
  display: 'grid',
  gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
  gap: 2,
} as const;

export function TemplatePicker({ query, selected, onSelect, onInitialResolved }: TemplatePickerProps) {
  const { workspace: ws } = strings;
  const templates = useMemo(() => query.data?.items ?? [], [query.data]);
  const namespaces = query.data?.namespaces;

  const defaultTemplate = useMemo(() => resolveDefaultTemplate(templates, namespaces), [templates, namespaces]);
  const hasDefault = defaultTemplate !== null;

  // Whether the picker renders nothing (parent adopts selection silently).
  const hidden = !query.isLoading && !query.isError && (templates.length === 0 || (templates.length === 1 && hasDefault));

  // No-template card shows whenever the grid shows EXCEPT when a default is flagged.
  const showNoTemplate = !hasDefault;

  // Report the initial selection once, when data first resolves.
  useEffect(() => {
    if (query.isLoading || query.isError || !onInitialResolved) return;
    if (templates.length === 0) {
      onInitialResolved({ selection: null, hidden: true });
    } else if (templates.length === 1 && hasDefault) {
      onInitialResolved({ selection: defaultTemplate, hidden: true });
    } else if (hasDefault) {
      onInitialResolved({ selection: defaultTemplate, hidden: false });
    } else {
      onInitialResolved({ selection: null, hidden: false }); // preselect no-template
    }
    // Run only when the resolved data identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isLoading, query.isError, query.data]);

  if (query.isLoading) {
    return (
      <Box sx={GRID_SX}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={168} />
        ))}
      </Box>
    );
  }

  // On error, fall back to static bounds with a non-blocking warning (don't hard-fail
  // create). The parent's selection stays null (no-template / static).
  if (query.isError) {
    return <Alert severity="warning">{ws.templateLoadError}</Alert>;
  }

  // Hidden: 0 templates, or a single flagged default is auto-used. Nothing to render.
  if (hidden) return null;

  const isSelected = (t: DiscoveredTemplate) =>
    selected !== null && selected.metadata.name === t.metadata.name && selected.metadata.namespace === t.metadata.namespace;

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">{ws.templatePickerTitle}</Typography>
      {query.data?.access.shared === 'denied' && (
        <Typography variant="caption" color="text.secondary">
          {ws.templateSharedDenied}
        </Typography>
      )}
      <Box sx={GRID_SX}>
        {templates.map((t) => (
          <TemplateCard key={`${t.metadata.namespace}/${t.metadata.name}`} template={t} selected={isSelected(t)} onClick={() => onSelect(t)} />
        ))}
        {showNoTemplate && <NoTemplateCard selected={selected === null} onClick={() => onSelect(null)} />}
      </Box>
    </Stack>
  );
}
