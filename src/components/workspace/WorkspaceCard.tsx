import { Card, CardContent, Typography, IconButton, Chip, Button, Menu, MenuItem, ListItemIcon, Stack, Box, Divider } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { PlayArrow, Stop, OpenInNew, MoreVert, Delete, Circle, Memory, Storage, Info } from '@mui/icons-material';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workspace } from '../../types';
import { useStartWorkspace, useStopWorkspace, useDeleteWorkspace } from '../../api';
import { useAuth } from '../../context';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { getWorkspaceStatus, isOwner as checkIsOwner, type WorkspaceStatus } from '../../utils';
import { strings } from '../../constants';
import styles from './WorkspaceCard.module.css';

interface WorkspaceCardProps {
  workspace: Workspace;
}

export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const startMutation = useStartWorkspace();
  const stopMutation = useStopWorkspace();
  const deleteMutation = useDeleteWorkspace();

  const { metadata, spec, status } = workspace;
  const workspaceStatus = getWorkspaceStatus(workspace);
  const accessURL = status?.accessURL;

  const owner = metadata.annotations?.['workspace.jupyter.org/created-by'];
  const ownerMatch = checkIsOwner(owner, user?.username);

  const canOpen = workspaceStatus === 'Running' && accessURL && (ownerMatch || spec.accessType === 'Public');
  const isRunning = spec.desiredStatus === 'Running';

  const handleOpen = () => {
    if (accessURL && canOpen) window.open(accessURL, '_blank', 'noopener,noreferrer');
  };

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget);
  const handleMenuClose = () => setAnchorEl(null);

  const handleDeleteClick = () => {
    handleMenuClose();
    setDeleteDialogOpen(true);
  };

  const handleViewDetails = () => navigate(`/workspace/${metadata.name}`);

  const handleDeleteConfirm = () => {
    deleteMutation.mutate(metadata.name, { onSettled: () => setDeleteDialogOpen(false) });
  };

  const handleStart = () => startMutation.mutate(metadata.name);
  const handleStop = () => stopMutation.mutate(metadata.name);
  const handleCancelDelete = () => setDeleteDialogOpen(false);

  return (
    <>
      <Card className={styles.card} aria-label={strings.a11y.workspaceCard(spec.displayName ?? metadata.name, workspaceStatus)}>
        <CardContent className={styles.cardContent}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" component="h3" noWrap sx={{ mb: 0.5 }}>
                {spec.displayName ?? metadata.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {metadata.name}
              </Typography>
            </Box>
            <IconButton size="small" onClick={handleMenuOpen} aria-label={strings.workspace.moreOptions}>
              <MoreVert />
            </IconButton>
          </Stack>

          <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 2.5, flexWrap: 'wrap' }}>
            <Chip
              icon={<Circle sx={{ fontSize: 8 }} />}
              label={workspaceStatus}
              size="small"
              sx={(theme) => {
                const colorMap: Record<WorkspaceStatus, string> = {
                  Running: theme.palette.success.main,
                  Starting: theme.palette.warning.main,
                  Stopping: theme.palette.warning.main,
                  Degraded: theme.palette.error.main,
                  Deleting: theme.palette.error.main,
                  Stopped: theme.palette.text.disabled,
                  Unknown: theme.palette.text.disabled,
                };
                const color = colorMap[workspaceStatus];
                return { bgcolor: alpha(color, 0.1), color, border: 'none', '& .MuiChip-icon': { color } };
              }}
            />
            <Chip label={spec.image?.split('/').pop() ?? spec.image} size="small" variant="outlined" className={styles.imageChip} title={spec.image} />
            {spec.accessType === 'OwnerOnly' && <Chip label={strings.common.private} size="small" className={styles.privateChip} />}
          </Stack>

          <Stack direction="row" gap={2} sx={{ color: 'text.secondary' }}>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Memory sx={{ fontSize: 16 }} />
              <Typography variant="caption">{spec.resources?.limits?.cpu ?? '—'} CPU</Typography>
            </Stack>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Storage sx={{ fontSize: 16 }} />
              <Typography variant="caption">{spec.resources?.limits?.memory ?? '—'}</Typography>
            </Stack>
          </Stack>
        </CardContent>

        <Box className={styles.actions}>
          <Button size="small" startIcon={<Info fontSize="small" />} onClick={handleViewDetails} color="secondary">
            {strings.workspace.details}
          </Button>
          {canOpen && (
            <Button size="small" startIcon={<OpenInNew fontSize="small" />} onClick={handleOpen} color="primary">
              {strings.workspace.open}
            </Button>
          )}
          {ownerMatch &&
            (isRunning ? (
              <Button size="small" startIcon={<Stop fontSize="small" />} onClick={handleStop} disabled={stopMutation.isPending} color="secondary">
                {strings.workspace.stop}
              </Button>
            ) : (
              <Button size="small" startIcon={<PlayArrow fontSize="small" />} onClick={handleStart} disabled={startMutation.isPending} color="primary">
                {strings.workspace.start}
              </Button>
            ))}
        </Box>

        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
          <MenuItem onClick={handleViewDetails}>
            <ListItemIcon>
              <Info fontSize="small" />
            </ListItemIcon>
            <Typography variant="body2">{strings.workspace.viewDetails}</Typography>
          </MenuItem>
          {ownerMatch && <Divider />}
          {ownerMatch && (
            <MenuItem onClick={handleDeleteClick}>
              <ListItemIcon>
                <Delete fontSize="small" color="error" />
              </ListItemIcon>
              <Typography variant="body2" color="error">
                {strings.common.delete}
              </Typography>
            </MenuItem>
          )}
        </Menu>
      </Card>

      {ownerMatch && (
        <ConfirmDialog
          open={deleteDialogOpen}
          title={strings.workspace.deleteTitle}
          message={strings.workspace.deleteMessage(spec.displayName ?? metadata.name)}
          confirmLabel={strings.common.delete}
          onConfirm={handleDeleteConfirm}
          onCancel={handleCancelDelete}
          isDestructive
          isLoading={deleteMutation.isPending}
        />
      )}
    </>
  );
}
