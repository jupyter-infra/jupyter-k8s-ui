// Monaco + monaco-yaml worker wiring for Vite.
//
// Monaco language services run in web workers. We register a MonacoEnvironment
// getWorker that returns the monaco-yaml language worker for the 'yaml' label and the
// generic editor worker otherwise.
//
// The YAML worker is imported through a LOCAL re-export (./yaml.worker) rather than
// the package's worker directly — that's the official monaco-yaml Vite workaround for
// the "Unexpected usage" error (see monaco-yaml README, "Why doesn't it work with
// Vite?"). The editor worker uses monaco-editor's ESM worker.
//
// IMPORTANT: this runs as a module-load side effect, imported at the very top of
// YamlEditor.tsx BEFORE the monaco API import, so MonacoEnvironment is set when the
// first editor mounts. This module is only reached via the lazy editor, so none of
// Monaco lands in the main bundle.

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import YamlWorker from './yaml.worker?worker';

// `MonacoEnvironment` is declared globally by monaco-editor (as
// `var MonacoEnvironment: Environment | undefined`), so no local type is needed.
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'yaml') {
      return new YamlWorker();
    }
    return new EditorWorker();
  },
};
