// "Advanced" box shown on the simple create AND edit pages: a short blurb pointing at
// kubectl + the CRD reference, and a button that switches to the YAML editor. Shared so
// the two pages stay consistent (same copy, same links).

import { Link as RouterLink } from 'react-router-dom';
import { Button, Link, Paper, Stack, Typography } from '@mui/material';
import { strings } from '../../constants';

interface AdvancedBoxProps {
  onSwitchToYaml: () => void;
}

export function AdvancedBox({ onSwitchToYaml }: AdvancedBoxProps) {
  const { workspace: ws } = strings;
  return (
    <Paper variant="outlined">
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between" padding={3}>
        <Stack>
          <Typography variant="subtitle2">{ws.advancedBoxTitle}</Typography>
          <Typography variant="caption" color="text.secondary">
            {ws.advancedBoxIntro}{' '}
            <Link component={RouterLink} to="/kubectl" underline="hover">
              {ws.advancedBoxKubectl}
            </Link>{' '}
            {ws.advancedBoxDocsMid}{' '}
            <Link href={ws.advancedHintDocsUrl} target="_blank" rel="noopener" underline="hover">
              {ws.advancedBoxDocsLink}
            </Link>
            .
          </Typography>
        </Stack>
        <Button onClick={onSwitchToYaml} variant="outlined" sx={{ flexShrink: 0 }}>
          {ws.advancedSwitchToYaml}
        </Button>
      </Stack>
    </Paper>
  );
}
