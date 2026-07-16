import { useMemo } from 'react';
import { Autocomplete, TextField, FormControl } from '@mui/material';
import { useTemplates } from '../../../api';
import type { DiscoveredTemplate } from '../../../types';
import { strings } from '../../../constants';

export interface TemplateSelectProps {
  /** Selected template name, or null for "use namespace default". */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Surfaces the resolved template object to the parent (drives image-enum + guidance). */
  onTemplateResolved?: (template: DiscoveredTemplate | null) => void;
}

/**
 * Template picker that lives above the YAML editor. `templateRef` is owned here, not
 * in the buffer — its onChange is the discrete trigger for re-patching the schema's
 * image enum and refreshing the guidance panel.
 *
 * Uses a free-solo Autocomplete so it degrades to manual entry when discovery is
 * unavailable: the user can type a template name even if their RBAC won't let them
 * list templates.
 */
export function TemplateSelect({ value, onChange, onTemplateResolved }: TemplateSelectProps) {
  const { workspace: ws } = strings;
  const { data, isError } = useTemplates();

  const templates = useMemo(() => data?.items ?? [], [data]);
  const options = useMemo(() => templates.map((t) => t.metadata.name), [templates]);

  // Discovery "failed" enough to warrant the manual-entry notice when the request
  // errored outright, or when neither namespace was listable.
  const discoveryUnavailable = isError || (data?.access.user === 'denied' && data?.access.shared === 'denied');

  const handleChange = (next: string | null) => {
    const name = next && next.length > 0 ? next : null;
    onChange(name);
    onTemplateResolved?.(name ? (templates.find((t) => t.metadata.name === name) ?? null) : null);
  };

  return (
    <FormControl fullWidth size="small">
      <Autocomplete
        freeSolo
        size="small"
        options={options}
        value={value}
        onChange={(_e, next) => handleChange(next)}
        onInputChange={(_e, next, reason) => {
          if (reason === 'input') handleChange(next);
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={ws.advancedTemplateLabel}
            placeholder={ws.advancedTemplateNone}
            helperText={discoveryUnavailable ? ws.advancedTemplatesUnavailable : undefined}
          />
        )}
      />
    </FormControl>
  );
}
