import { Stack, Chip, Alert, Typography } from '@mui/material';
import { CheckCircle, Error as ErrorIcon, HelpOutline } from '@mui/icons-material';
import type { ValidationResult } from '../../../api/client';
import { strings } from '../../../constants';

export interface ValidationStatusProps {
  /** Local YAML syntax error, or null when the buffer parses. */
  syntaxError: string | null;
  /** Whether the CRD schema validation (Monaco markers) found errors. */
  schemaHasErrors: boolean;
  /** The last server dry-run result, or null if the user hasn't validated. */
  dryRun: ValidationResult | null;
}

type ChipState = 'ok' | 'error' | 'unknown';

function stateChip(label: string, state: ChipState) {
  const props = {
    ok: { color: 'success' as const, icon: <CheckCircle fontSize="small" /> },
    error: { color: 'error' as const, icon: <ErrorIcon fontSize="small" /> },
    unknown: { color: 'default' as const, icon: <HelpOutline fontSize="small" /> },
  }[state];
  return <Chip size="small" variant="outlined" color={props.color} icon={props.icon} label={label} />;
}

/**
 * Compact status strip for the editor's validation state. YAML-syntax and CRD-schema
 * checks are continuous (from Monaco markers); the dry-run result is on-demand (the
 * user clicks Validate). The dry-run's authoritative webhook message is rendered as a
 * readable block rather than an inline squiggle, since the API returns a message
 * string with no line/column to anchor to.
 */
export function ValidationStatus({ syntaxError, schemaHasErrors, dryRun }: ValidationStatusProps) {
  const { workspace: ws } = strings;

  const syntaxState: ChipState = syntaxError ? 'error' : 'ok';
  // If YAML doesn't parse, schema validity is unknowable.
  const schemaState: ChipState = syntaxError ? 'unknown' : schemaHasErrors ? 'error' : 'ok';

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {stateChip(ws.advancedSyntaxOk, syntaxState)}
        {stateChip(ws.advancedSchemaOk, schemaState)}
      </Stack>

      {syntaxError && <Alert severity="error">{syntaxError}</Alert>}

      {dryRun && dryRun.valid && <Alert severity="success">{ws.advancedValidationPassed}</Alert>}

      {dryRun && !dryRun.valid && (
        <Alert severity="error">
          <Typography variant="body2" fontWeight={600}>
            {dryRun.message}
          </Typography>
          {dryRun.details && (
            <Typography variant="caption" component="pre" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
              {dryRun.details}
            </Typography>
          )}
        </Alert>
      )}
    </Stack>
  );
}
