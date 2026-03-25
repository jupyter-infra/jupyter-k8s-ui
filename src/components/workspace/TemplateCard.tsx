import { Box, Paper, Stack, Typography } from '@mui/material';
import { Check, Code, Memory, School, Science } from '@mui/icons-material';
import type { ReactNode, KeyboardEvent } from 'react';
import type { WorkspaceTemplate } from '../../types';
import { strings } from '../../constants';
import styles from './TemplateCard.module.css';

const TEMPLATE_CONFIG: Record<string, { icon: ReactNode; tag: string }> = {
  starter: { icon: <School />, tag: 'Quick start' },
  'data-science': { icon: <Science />, tag: 'Full stack' },
  'ml-training': { icon: <Memory />, tag: 'High performance' },
  'code-editor': { icon: <Code />, tag: 'VS Code style' },
};

const DEFAULT_CONFIG = { icon: <Science />, tag: 'Custom' };

interface TemplateCardProps {
  template: WorkspaceTemplate;
  selected: boolean;
  onClick: () => void;
}

export function TemplateCard({ template, selected, onClick }: TemplateCardProps) {
  const config = TEMPLATE_CONFIG[template.name] || DEFAULT_CONFIG;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <Paper
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      elevation={0}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={strings.a11y.templateCard(template.displayName)}
    >
      {selected && <Check className={styles.checkIcon} />}
      <Stack direction="row" alignItems="center" gap={2}>
        <Box className={styles.icon}>{config.icon}</Box>
        <Box>
          <Typography className={styles.name}>{template.displayName}</Typography>
          <Typography className={styles.description}>{template.description}</Typography>
          <Typography className={styles.tag}>{config.tag}</Typography>
        </Box>
      </Stack>
    </Paper>
  );
}
