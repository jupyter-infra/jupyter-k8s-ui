import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Typography, Stack, Container } from '@mui/material';
import { WorkspaceSpecEditor } from '../components/workspace/yaml-editor/WorkspaceSpecEditor';
import { strings } from '../constants';

// The workspace EDIT page (`/workspace/:name/edit`). Currently a YAML editor; a
// simplified edit UI can slot in here later behind the same route. Create no longer has
// its own page — it's an inline toggle on `/create` (see WorkspaceCreate). This page
// owns the name/displayName state and hands it to the shared WorkspaceSpecEditor, which
// seeds both from the fetched workspace on mount.
export function WorkspaceAdvancedEditor() {
  const { name: routeName } = useParams();
  const { workspace: ws } = strings;

  const [name, setName] = useState(routeName ?? '');
  const [displayName, setDisplayName] = useState('');

  return (
    <Container maxWidth="md">
      <Stack spacing={3} paddingBottom={8}>
        <Typography variant="h4" fontWeight={600}>
          {ws.advancedEditTitle}
        </Typography>
        <WorkspaceSpecEditor
          mode="edit"
          name={name}
          onNameChange={setName}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          routeName={routeName}
          renderIdentityFields
        />
      </Stack>
    </Container>
  );
}
