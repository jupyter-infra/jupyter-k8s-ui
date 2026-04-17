// Preloaded by src/bunfig.toml before any test imports.
// Registers happy-dom globals (document, window, localStorage) so React
// component tests can render. Server tests have their own bunfig with no
// preload, since happy-dom's Request strips headers the server relies on.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
