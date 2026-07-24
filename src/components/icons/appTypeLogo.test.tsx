import { describe, test, expect, beforeEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { getAppTypeLogo } from './appTypeLogo';

// getAppTypeLogo is a lookup table with a non-obvious key transform (normalize: lowercase,
// strip -/_/space). Each case here fails for a distinct reason: the branded SVG carries a
// `app-type-logo-svg` testid, the neutral fallback (<Apps/>) does NOT — so its presence is
// the observable difference between "logo resolved" and "fell back".
function hasBrandedLogo(appType?: string): boolean {
  render(<div>{getAppTypeLogo(appType)}</div>);
  return screen.queryByTestId('app-type-logo-svg') !== null;
}

describe('getAppTypeLogo', () => {
  beforeEach(cleanup);

  test.each(['jupyter', 'jupyterlab'])('exact registry key %p resolves to the branded logo', (appType) => {
    expect(hasBrandedLogo(appType)).toBe(true);
  });

  test.each(['jupyter-lab', 'jupyter_lab', 'JupyterLab', 'Jupyter Lab', 'JUPYTER'])(
    'normalized variant %p resolves to the same branded logo (not the fallback)',
    (appType) => {
      expect(hasBrandedLogo(appType)).toBe(true);
    },
  );

  test.each([undefined, '', 'code-server', 'vscode', 'rstudio'])('unknown / unset appType %p falls back to the neutral icon', (appType) => {
    expect(hasBrandedLogo(appType)).toBe(false);
  });
});
