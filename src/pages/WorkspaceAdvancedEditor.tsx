import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Typography, Stack, Container, CircularProgress, Box, Alert, Button } from '@mui/material';
import { WorkspaceSpecEditor } from '../components/workspace/yaml-editor/WorkspaceSpecEditor';
import { SimpleWorkspaceEditor } from '../components/workspace/SimpleWorkspaceEditor';
import { useWorkspace } from '../api';
import { useAuth } from '../context';
import { getWorkspaceOwner, getWorkspaceStatus, isOwner } from '../utils';
import { strings } from '../constants';

// A full-page notice shown when the workspace can't be edited (mirrors WorkspaceSpecEditor's
// EditNotice — used here for the simple-edit guard path).
function EditNotice({ title, message, onBack, backLabel }: { title?: string; message: string; onBack: () => void; backLabel: string }) {
  return (
    <Stack spacing={2} paddingBottom={8}>
      <Alert severity={title ? 'warning' : 'error'}>
        {title && (
          <Typography variant="body2" fontWeight={600}>
            {title}
          </Typography>
        )}
        <Typography variant="body2">{message}</Typography>
      </Alert>
      <Box>
        <Button variant="outlined" onClick={onBack}>
          {backLabel}
        </Button>
      </Box>
    </Stack>
  );
}

// The workspace EDIT page (`/workspace/:name/edit`). Defaults to the slider-based simple
// editor; a "Use YAML editor" button switches to the Monaco spec editor (symmetric with
// create). The YAML editor is the single path to YAML — no ?mode= deep-link.
export function WorkspaceAdvancedEditor() {
  const { name: routeName } = useParams();
  const navigate = useNavigate();
  const { workspace: ws } = strings;
  const { user } = useAuth();

  const [useYaml, setUseYaml] = useState(false);
  // name/displayName are lifted so they survive the simple ↔ YAML toggle. Both are derived
  // from the fetched workspace until the user edits them (override !== null), avoiding a
  // seed-in-effect (name is immutable on edit, but the YAML editor still reads it).
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(null);

  const { data: existing, isLoading, error } = useWorkspace(routeName ?? '');

  const name = nameOverride ?? existing?.metadata.name ?? routeName ?? '';
  const displayName = displayNameOverride ?? existing?.spec.displayName ?? existing?.metadata.name ?? '';

  const title = useYaml ? ws.advancedEditTitle : ws.editTitle;

  return (
    <Container maxWidth="md">
      <Stack spacing={3} paddingBottom={8}>
        <Typography variant="h4" fontWeight={600}>
          {title}
        </Typography>

        <EditBody
          useYaml={useYaml}
          setUseYaml={setUseYaml}
          isLoading={isLoading}
          error={error}
          existing={existing}
          username={user?.username}
          routeName={routeName}
          name={name}
          setName={setNameOverride}
          displayName={displayName}
          setDisplayName={setDisplayNameOverride}
          notice={EditNotice}
          onBack={() => navigate('/')}
          onBackDetail={() => existing && navigate(`/workspace/${existing.metadata.name}`)}
        />
      </Stack>
    </Container>
  );
}

interface EditBodyProps {
  useYaml: boolean;
  setUseYaml: (v: boolean) => void;
  isLoading: boolean;
  error: unknown;
  existing: ReturnType<typeof useWorkspace>['data'];
  username?: string;
  routeName?: string;
  name: string;
  setName: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  notice: typeof EditNotice;
  onBack: () => void;
  onBackDetail: () => void;
}

function EditBody({
  useYaml,
  setUseYaml,
  isLoading,
  error,
  existing,
  username,
  routeName,
  name,
  setName,
  displayName,
  setDisplayName,
  notice: Notice,
  onBack,
  onBackDetail,
}: EditBodyProps) {
  const { workspace: ws } = strings;

  // The YAML editor owns its own load/guard/seed lifecycle; hand off directly. It renders
  // its own name/displayName fields on the edit route (renderIdentityFields) — the simple
  // editor renders its own set, so only one is shown at a time.
  if (useYaml) {
    return (
      <WorkspaceSpecEditor
        mode="edit"
        name={name}
        onNameChange={setName}
        displayName={displayName}
        onDisplayNameChange={setDisplayName}
        routeName={routeName}
        renderIdentityFields
        onSwitchToForm={() => setUseYaml(false)}
      />
    );
  }

  // Simple-edit path: replicate the same load/guard checks the YAML editor enforces
  // (owner + Stopped + load-failure), since this branch fetches on its own.
  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" py={8}>
        <CircularProgress />
      </Box>
    );
  }
  if (error || !existing) {
    return <Notice message={error instanceof Error ? error.message : ws.advancedLoadError} onBack={onBack} backLabel={ws.advancedBack} />;
  }
  if (!isOwner(getWorkspaceOwner(existing), username)) {
    return <Notice title={ws.advancedEditNotAllowedTitle} message={ws.advancedEditNotOwner} onBack={onBack} backLabel={ws.advancedBack} />;
  }
  if (getWorkspaceStatus(existing) !== 'Stopped') {
    return <Notice title={ws.advancedEditNotAllowedTitle} message={ws.advancedEditNotStopped} onBack={onBackDetail} backLabel={ws.advancedBack} />;
  }

  return <SimpleWorkspaceEditor workspace={existing} displayName={displayName} onDisplayNameChange={setDisplayName} onSwitchToYaml={() => setUseYaml(true)} />;
}
