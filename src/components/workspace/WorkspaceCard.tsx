import {
  Card, CardContent, Typography, IconButton, Chip, Tooltip, Menu, MenuItem,
  ListItemIcon, Stack, Box, Divider,
} from '@mui/material';
import {
  PlayArrow, Stop, OpenInNew, MoreVert, Delete, Circle, Memory,
  Storage, Info,
} from '@mui/icons-material';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workspace } from '../../types';
import { useStartWorkspace, useStopWorkspace, useDeleteWorkspace } from '../../api';
import { useAuth } from '../../context';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { getStatusColor, getStatusText } from '../../utils';
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
  const isRunning = spec.desiredStatus === 'Running';
  const isAvailable = status?.conditions?.find((c) => c.type === 'Available')?.status === 'True';
  const isPending = isRunning && !isAvailable;
  const accessURL = status?.accessURL;

  const owner = metadata.annotations?.['workspace.jupyter.org/created-by'];
  const isOwner = owner && user?.username && (
    owner === user.username ||
    owner === `github:${user.username}` ||
    owner.endsWith(`/${user.username}`) ||
    owner.includes(`:${user.username}`)
  );

  const canOpen = isRunning && isAvailable && accessURL && (isOwner || spec.accessType === 'Public');

  const statusColor = getStatusColor(isRunning, isAvailable, isPending);
  const statusText = getStatusText(isRunning, isAvailable, isPending);

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
      <Card className={styles.card} aria-label={strings.a11y.workspaceCard(spec.displayName, statusText)}>
        <CardContent className={styles.cardContent}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" component="h3" noWrap sx={{ mb: 0.5 }}>{spec.displayName}</Typography>
              <Typography variant="body2" color="text.secondary">{metadata.name}</Typography>
            </Box>
            <IconButton size="small" onClick={handleMenuOpen} aria-label={strings.workspace.moreOptions}>
              <MoreVert />
            </IconButton>
          </Stack>

          <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 2.5, flexWrap: 'wrap' }}>
            <Chip
              icon={<Circle sx={{ fontSize: 8, color: statusColor }} />}
              label={statusText}
              size="small"
              sx={{ bgcolor: `${statusColor}1a`, color: statusColor, border: 'none' }}
            />
            <Chip label={spec.image} size="small" variant="outlined" className={styles.imageChip} />
            {spec.accessType === 'OwnerOnly' && (
              <Chip label={strings.common.private} size="small" className={styles.privateChip} />
            )}
          </Stack>

          <Stack direction="row" gap={2} sx={{ color: 'text.secondary' }}>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Memory sx={{ fontSize: 16 }} />
              <Typography variant="caption">{spec.resources.limits.cpu} CPU</Typography>
            </Stack>
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Storage sx={{ fontSize: 16 }} />
              <Typography variant="caption">{spec.resources.limits.memory}</Typography>
            </Stack>
          </Stack>
        </CardContent>

        <Box className={styles.actions}>
          <Tooltip title={strings.workspace.viewDetails}>
            <IconButton size="small" onClick={handleViewDetails} aria-label={strings.workspace.viewDetails}>
              <Info fontSize="small" />
            </IconButton>
          </Tooltip>
          {canOpen && (
            <Tooltip title={strings.workspace.openWorkspace}>
              <IconButton size="small" onClick={handleOpen} aria-label={strings.workspace.openWorkspace} color="primary">
                <OpenInNew fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {isOwner && (
            isRunning ? (
              <Tooltip title={strings.workspace.stop}>
                <span>
                  <IconButton size="small" onClick={handleStop} disabled={stopMutation.isPending} aria-label={strings.workspace.stop}>
                    <Stop fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            ) : (
              <Tooltip title={strings.workspace.start}>
                <span>
                  <IconButton size="small" onClick={handleStart} disabled={startMutation.isPending} aria-label={strings.workspace.start} color="primary">
                    <PlayArrow fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )
          )}
        </Box>

        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
          <MenuItem onClick={handleViewDetails}>
            <ListItemIcon><Info fontSize="small" /></ListItemIcon>
            <Typography variant="body2">{strings.workspace.viewDetails}</Typography>
          </MenuItem>
          {isOwner && <Divider />}
          {isOwner && (
            <MenuItem onClick={handleDeleteClick}>
              <ListItemIcon><Delete fontSize="small" color="error" /></ListItemIcon>
              <Typography variant="body2" color="error">{strings.common.delete}</Typography>
            </MenuItem>
          )}
        </Menu>
      </Card>

      {isOwner && (
        <ConfirmDialog
          open={deleteDialogOpen}
          title={strings.workspace.deleteTitle}
          message={strings.workspace.deleteMessage(spec.displayName)}
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
