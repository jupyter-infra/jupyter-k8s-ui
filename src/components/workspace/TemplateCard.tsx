import { Box, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { Check, BuildCircle } from '@mui/icons-material';
import type { KeyboardEvent, ReactNode } from 'react';
import type { WorkspaceTemplate } from '../../types';
import { strings } from '../../constants';
import { getAppTypeLogo } from '../icons/appTypeLogo';
import styles from './TemplateCard.module.css';

interface TemplateCardBaseProps {
  selected: boolean;
  onClick: () => void;
}

interface TemplateCardProps extends TemplateCardBaseProps {
  template: WorkspaceTemplate;
}

// Card content is just: displayName (title), then name + namespace (both dimmed). The
// description, when present, is surfaced on hover via a tooltip rather than inline.
function CardShell({
  selected,
  onClick,
  icon,
  title,
  subtitle,
  tooltip,
  ariaLabel,
}: TemplateCardBaseProps & { icon: ReactNode; title: string; subtitle?: ReactNode; tooltip?: string; ariaLabel: string }) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const card = (
    <Paper
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      elevation={0}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={ariaLabel}
    >
      {selected && <Check className={styles.checkIcon} />}
      <Stack spacing={1.5} alignItems="flex-start" height="100%">
        <Box className={styles.icon}>{icon}</Box>
        <Box>
          <Typography className={styles.name}>{title}</Typography>
          {subtitle}
        </Box>
      </Stack>
    </Paper>
  );

  // Only wrap in a Tooltip when there's description text to show.
  return tooltip ? (
    <Tooltip title={tooltip} placement="top">
      {card}
    </Tooltip>
  ) : (
    card
  );
}

export function TemplateCard({ template, selected, onClick }: TemplateCardProps) {
  const title = template.spec.displayName ?? template.metadata.name;
  return (
    <CardShell
      selected={selected}
      onClick={onClick}
      icon={getAppTypeLogo(template.spec.appType)}
      title={title}
      subtitle={
        <>
          <Typography className={styles.meta}>{template.metadata.name}</Typography>
          <Typography className={styles.meta}>{template.metadata.namespace}</Typography>
        </>
      }
      tooltip={template.spec.description || undefined}
      ariaLabel={strings.a11y.templateCard(title)}
    />
  );
}

// The explicit "no template" card — a bare workspace with static bounds and no templateRef.
export function NoTemplateCard({ selected, onClick }: TemplateCardBaseProps) {
  const { workspace: ws } = strings;
  return (
    <CardShell
      selected={selected}
      onClick={onClick}
      icon={<BuildCircle sx={{ fontSize: 28 }} aria-hidden="true" />}
      title={ws.templateNoTemplateName}
      tooltip={ws.templateNoTemplateDescription}
      ariaLabel={strings.a11y.templateCard(ws.templateNoTemplateName)}
    />
  );
}
