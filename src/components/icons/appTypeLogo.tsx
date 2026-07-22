// App-type logo registry — maps a template's `spec.appType` to a brand logo.
//
// Derives the card icon from the *appType* (a stable, semantic field) rather than the
// template's `metadata.name` (which killed the old hardcoded per-name map). Unknown app
// types fall back to a neutral MUI icon so an unrecognized app never renders blank.
//
// The map is intentionally open: add a logo by dropping an SVG in src/assets/logos/ and
// adding one entry here.

import type { ComponentType, SVGProps, ReactNode } from 'react';
import { Apps } from '@mui/icons-material';
import JupyterLogo from '../../assets/logos/jupyter.svg?react';

type LogoComponent = ComponentType<SVGProps<SVGSVGElement>>;

// Keyed by lowercased appType. jupyter / jupyterlab share the Jupyter mark.
const APP_TYPE_LOGOS: Record<string, LogoComponent> = {
  jupyter: JupyterLogo,
  jupyterlab: JupyterLogo,
  // TODO: admin-supplied logos via GET /api/v1/config (follow-up PR). Also room here for
  // vscode, rstudio, … — one entry each, no structural change.
};

// Returns a rendered logo for the given appType, or a neutral <Apps/> fallback.
export function getAppTypeLogo(appType?: string, size = 28): ReactNode {
  const Logo = appType ? APP_TYPE_LOGOS[appType.toLowerCase()] : undefined;
  if (Logo) {
    return <Logo width={size} height={size} aria-hidden="true" focusable="false" />;
  }
  return <Apps sx={{ fontSize: size }} aria-hidden="true" />;
}
