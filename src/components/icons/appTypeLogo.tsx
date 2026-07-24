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

// Keyed by NORMALIZED appType (lowercased, `-`/`_`/spaces stripped).
// jupyter / jupyterlab share the Jupyter mark.
// Normalizing means `jupyter-lab`, `jupyter_lab`, and `JupyterLab`
// resolve to the same entry instead of silently falling back.
const APP_TYPE_LOGOS: Record<string, LogoComponent> = {
  jupyter: JupyterLogo,
  jupyterlab: JupyterLogo,
  // future: admin-supplied logos.
};

function normalizeAppType(appType: string): string {
  return appType.toLowerCase().replace(/[-_\s]/g, '');
}

// Returns a rendered logo for the given appType, or a neutral <Apps/> fallback. The branded
// logo carries a `data-testid="app-type-logo-svg"` so tests can distinguish a real logo from
// the fallback (the fallback renders no such element).
export function getAppTypeLogo(appType?: string, size = 28): ReactNode {
  const Logo = appType ? APP_TYPE_LOGOS[normalizeAppType(appType)] : undefined;
  if (Logo) {
    return <Logo width={size} height={size} aria-hidden="true" focusable="false" data-testid="app-type-logo-svg" />;
  }
  return <Apps sx={{ fontSize: size }} aria-hidden="true" />;
}
