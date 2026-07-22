// Read-only "Template" section shown when the template is locked (can't be changed from
// the simple form). Used by simple-edit (a workspace already references a template) and by
// simple-create when the environment enforces a single template (the picker is hidden).
//
// The lock affordance is a mouse-over: an icon carrying a tooltip that explains why the
// field is fixed and points at the YAML editor. The copy differs create vs. edit, so the
// tooltip text is passed in.

import { Stack, Paper, Typography, Tooltip } from '@mui/material';
import { LockOutlined } from '@mui/icons-material';
import { strings } from '../../constants';

interface LockedTemplateFieldProps {
  /** Template display label (display name, template name, or a "no template" label). */
  label: string;
  /** Mouse-over copy explaining the lock (create vs. edit differ). */
  tooltip: string;
}

export function LockedTemplateField({ label, tooltip }: LockedTemplateFieldProps) {
  const { workspace: ws } = strings;
  return (
    <Paper variant="outlined">
      <Stack spacing={1} padding={3}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Typography variant="subtitle2">{ws.sectionTemplate}</Typography>
          <Tooltip title={tooltip}>
            <LockOutlined color="disabled" fontSize="small" />
          </Tooltip>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Paper>
  );
}
