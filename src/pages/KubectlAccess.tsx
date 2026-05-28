import { useState } from 'react';
import { Box, Typography, Button, Alert, CircularProgress, Stack, Paper, ToggleButtonGroup, ToggleButton, Chip } from '@mui/material';
import { ContentCopy, Check, Download } from '@mui/icons-material';
import { useClusterAccess } from '../api';
import { strings } from '../constants';
import type { ClusterAccessInfo } from '../types';
import styles from './KubectlAccess.module.css';

type OS = 'mac' | 'linux' | 'windows';

function generateScript(data: ClusterAccessInfo, os: OS): string {
  const { clusterName, apiServer, caCertBase64, oidcIssuerUrl, oidcClientId, oidcClientSecret, oidcCallbackPort } = data;

  if (os === 'windows') {
    return `# PowerShell — Run as Administrator
# Install kubelogin plugin
winget install kubectl
winget install int128.kubelogin

# Kill any process on callback port
$proc = Get-NetTCPConnection -LocalPort ${oidcCallbackPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }

# Write cluster CA certificate
New-Item -ItemType Directory -Force -Path $env:TEMP\\eks-certs | Out-Null
[System.IO.File]::WriteAllBytes("$env:TEMP\\eks-certs\\${clusterName}-ca.crt", [System.Convert]::FromBase64String("${caCertBase64}"))

# Configure kubectl
kubectl config set-cluster ${clusterName} --embed-certs --certificate-authority="$env:TEMP\\eks-certs\\${clusterName}-ca.crt" --server ${apiServer}

kubectl config set-credentials ${clusterName}-oidc --exec-api-version=client.authentication.k8s.io/v1 --exec-interactive-mode=IfAvailable --exec-command=kubectl --exec-arg=oidc-login --exec-arg=get-token --exec-arg="--oidc-issuer-url=${oidcIssuerUrl}" --exec-arg="--oidc-client-id=${oidcClientId}" --exec-arg="--oidc-client-secret=${oidcClientSecret}" --exec-arg="--listen-address=localhost:${oidcCallbackPort}" --exec-arg="--oidc-extra-scope=profile" --exec-arg="--oidc-extra-scope=groups"

kubectl config set-context ${clusterName} --cluster=${clusterName} --user=${clusterName}-oidc

kubectl config use-context ${clusterName}

Write-Host "Done! Run 'kubectl get workspaces' to verify."`;
  }

  const installCmd = os === 'mac' ? 'brew install kubelogin' : 'krew install oidc-login';
  const killCmd =
    os === 'mac'
      ? `PID=$(lsof -i :${oidcCallbackPort} 2>/dev/null | awk 'NR>1 {print $2}' || true)
if [ -n "$PID" ]; then
    echo "Terminating existing process on port ${oidcCallbackPort}"
    kill -9 $PID
fi`
      : `PID=$(ss -tlnp 2>/dev/null | grep :${oidcCallbackPort} | awk '{print $6}' | grep -oP '\\d+' || true)
if [ -n "$PID" ]; then
    echo "Terminating existing process on port ${oidcCallbackPort}"
    kill -9 $PID
fi`;

  return `bash << 'KUBECONFIG_SETUP'
set -eo pipefail

# Install kubelogin plugin
command -v kubectl-oidc_login >/dev/null 2>&1 || ${installCmd}

# Kill any process on callback port
${killCmd}

# Write cluster CA certificate
mkdir -p /tmp/eks-certs
printf '%s' '${caCertBase64}' | base64 --decode > /tmp/eks-certs/${clusterName}-ca.crt

# Configure kubectl
kubectl config set-cluster ${clusterName} --embed-certs --certificate-authority=/tmp/eks-certs/${clusterName}-ca.crt --server ${apiServer}

kubectl config set-credentials ${clusterName}-oidc --exec-api-version=client.authentication.k8s.io/v1 --exec-interactive-mode=IfAvailable --exec-command=kubectl --exec-arg=oidc-login --exec-arg=get-token --exec-arg="--oidc-issuer-url=${oidcIssuerUrl}" --exec-arg="--oidc-client-id=${oidcClientId}" --exec-arg="--oidc-client-secret=${oidcClientSecret}" --exec-arg="--listen-address=localhost:${oidcCallbackPort}" --exec-arg="--oidc-extra-scope=profile" --exec-arg="--oidc-extra-scope=groups"

kubectl config set-context ${clusterName} --cluster=${clusterName} --user=${clusterName}-oidc

kubectl config use-context ${clusterName}

echo "Done! Run 'kubectl get workspaces' to verify."
KUBECONFIG_SETUP`;
}

export function KubectlAccess() {
  const { data, isLoading, error } = useClusterAccess();
  const [os, setOs] = useState<OS>('mac');
  const [copied, setCopied] = useState(false);

  const script = data ? generateScript(data, os) : '';
  const issuerHostname = data ? (URL.canParse(data.oidcIssuerUrl) ? new URL(data.oidcIssuerUrl).hostname : data.oidcIssuerUrl) : '';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(script);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!data) return;
    const ext = os === 'windows' ? 'ps1' : 'sh';
    const mime = os === 'windows' ? 'text/plain' : 'text/x-shellscript';
    const blob = new Blob([script], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `set-kubeconfig-${data.clusterName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="60vh">
        <CircularProgress size={32} />
      </Box>
    );
  }

  if (error || !data) {
    return (
      <Stack spacing={2}>
        <Typography variant="h5" fontWeight={600}>
          {strings.kubectl.title}
        </Typography>
        <Alert severity="info">{strings.kubectl.unavailable}</Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={2} height="calc(100vh - 64px - 64px)">
      {/* Header */}
      <Box>
        <Typography variant="h5" fontWeight={600}>
          {strings.kubectl.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {strings.kubectl.description}
        </Typography>
      </Box>

      {/* Cluster info */}
      <Paper variant="outlined">
        <Stack direction="row" spacing={4} padding={2} alignItems="center" flexWrap="wrap">
          <Stack>
            <Typography variant="caption" color="text.secondary" fontWeight={600} textTransform="uppercase" letterSpacing={0.5}>
              {strings.kubectl.clusterLabel}
            </Typography>
            <Typography variant="body2" fontWeight={600} fontFamily="monospace">
              {data.clusterName}
            </Typography>
          </Stack>
          <Stack>
            <Typography variant="caption" color="text.secondary" fontWeight={600} textTransform="uppercase" letterSpacing={0.5}>
              {strings.kubectl.issuerLabel}
            </Typography>
            <Typography variant="body2" fontWeight={600} fontFamily="monospace">
              {issuerHostname}
            </Typography>
          </Stack>
          <Stack>
            <Typography variant="caption" color="text.secondary" fontWeight={600} textTransform="uppercase" letterSpacing={0.5}>
              {strings.kubectl.clientLabel}
            </Typography>
            <Typography variant="body2" fontWeight={600} fontFamily="monospace">
              {data.oidcClientId}
            </Typography>
          </Stack>
        </Stack>
      </Paper>

      {/* Instruction */}
      <Typography variant="body2">{strings.kubectl.instruction}</Typography>

      {/* Script card */}
      <Paper variant="outlined" component={Stack} flex={1} minHeight={0} overflow="hidden">
        <Stack direction="row" justifyContent="space-between" alignItems="center" padding={1.5} paddingX={2} borderBottom={1} borderColor="divider">
          <ToggleButtonGroup value={os} exclusive onChange={(_, v) => v && setOs(v)} size="small">
            <ToggleButton value="mac">{strings.kubectl.osMac}</ToggleButton>
            <ToggleButton value="linux">{strings.kubectl.osLinux}</ToggleButton>
            <ToggleButton value="windows">{strings.kubectl.osWindows}</ToggleButton>
          </ToggleButtonGroup>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              startIcon={copied ? <Check /> : <ContentCopy />}
              onClick={handleCopy}
              color={copied ? 'success' : 'primary'}
            >
              {copied ? strings.kubectl.copied : strings.kubectl.copy}
            </Button>
            <Button size="small" startIcon={<Download />} onClick={handleDownload} color="secondary">
              {strings.kubectl.download}
            </Button>
          </Stack>
        </Stack>
        <Box overflow="auto" padding={2.5} flex={1} bgcolor="background.default" className={styles.codeBlock}>
          <pre>
            {script.split('\n').map((line, i) => (
              <span key={i} className={line.trimStart().startsWith('#') ? styles.comment : undefined}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </Box>
      </Paper>

      {/* Verify hint */}
      <Alert severity="success" variant="outlined">
        {strings.kubectl.verifyHint} <Chip label={strings.kubectl.verifyCommand} size="small" variant="outlined" />
      </Alert>
    </Stack>
  );
}
