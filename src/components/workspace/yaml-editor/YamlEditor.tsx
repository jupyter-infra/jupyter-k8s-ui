import { useEffect, useRef } from 'react';
// Set MonacoEnvironment.getWorker as a module-load side effect BEFORE importing the
// monaco API below — import order matters (see monacoSetup.ts).
import './monacoSetup';
// We import the FULL `monaco-editor` module here (not the `editor.api` entry). Trimming
// to `editor.api` via a vite alias would give monaco-yaml's worker a different monaco
// module instance and break validation ("Missing method: doValidation") — see the note
// in vite.config.ts. The full monaco chunk is route-lazy (this editor is only loaded on
// the advanced-editor route), so it never lands in the main bundle. monaco-yaml supplies
// the YAML language itself.
import * as monaco from 'monaco-editor';
import { configureMonacoYaml, type MonacoYaml } from 'monaco-yaml';
import { useTheme } from '@mui/material';

// A synthetic in-memory URI the schema is bound to. monaco-yaml matches schemas to
// models by URI via `fileMatch`, so the editor model must use this same path.
const MODEL_URI = 'inmemory://workspace/spec.yaml';
const SCHEMA_URI = 'inmemory://workspace/spec-schema.json';

export interface YamlEditorProps {
  value: string;
  /**
   * Called on content change. `isUserEdit` is false for programmatic changes —
   * i.e. our own `value` updates and Monaco's mount-time normalization (flush) — and
   * true only for genuine user input, so callers can track a "dirty" state reliably.
   */
  onChange: (value: string, isUserEdit: boolean) => void;
  /**
   * JSON schema for the language service (CRD spec sub-schema, possibly with dynamic
   * enums injected). When undefined, the editor still works as a plain YAML editor
   * (graceful degradation — schema unavailable).
   */
  schema?: Record<string, unknown>;
  /**
   * Called whenever the language service's diagnostics change. Markers cover both
   * YAML syntax errors and CRD-schema violations — the caller uses them to gate Save.
   */
  onMarkers?: (markers: monaco.editor.IMarker[]) => void;
  readOnly?: boolean;
  height?: number | string;
}

// The single monaco-yaml handle for this monaco instance. Module-scoped because
// monaco itself is a singleton — there is one language registration shared across all
// editor mounts. null until first configured; reused via .update() thereafter.
let monacoYaml: MonacoYaml | null = null;

/**
 * Monaco + monaco-yaml editor bound to the workspace spec schema. Rendered only via
 * a lazy import, so Monaco stays out of the main bundle.
 */
export function YamlEditor({ value, onChange, schema, onMarkers, readOnly = false, height = 480 }: YamlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const theme = useTheme();

  // Keep the latest onChange/onMarkers without re-creating the editor.
  const onChangeRef = useRef(onChange);
  const onMarkersRef = useRef(onMarkers);
  onChangeRef.current = onChange;
  onMarkersRef.current = onMarkers;

  // Create the editor once on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Expose the monaco namespace for E2E tests, which drive the buffer via the model
    // API (simulated keystrokes are unreliable headless). Harmless in prod — it's just
    // a reference to the already-loaded editor library, on an advanced-only route.
    (window as unknown as { monaco?: typeof monaco }).monaco = monaco;

    const uri = monaco.Uri.parse(MODEL_URI);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, 'yaml', uri);

    const editor = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      readOnly,
      theme: theme.palette.mode === 'dark' ? 'vs-dark' : 'vs',
    });
    editorRef.current = editor;

    const changeSub = editor.onDidChangeModelContent((e) => {
      // `isFlush` is true for programmatic model resets (our setValue) and Monaco's
      // mount-time normalization — never for real typing. So a non-flush change is a
      // genuine user edit.
      onChangeRef.current(editor.getValue(), !e.isFlush);
    });

    // Diagnostics fire asynchronously from the worker; subscribe to marker changes
    // for the whole model set and filter to our model.
    const markerSub = monaco.editor.onDidChangeMarkers(() => {
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      onMarkersRef.current?.(markers);
    });

    return () => {
      changeSub.dispose();
      markerSub.dispose();
      editor.dispose();
      model.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes into the model (e.g. seeding from a fetched spec)
  // without clobbering the user's cursor when the value already matches.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  // React to theme flips.
  useEffect(() => {
    monaco.editor.setTheme(theme.palette.mode === 'dark' ? 'vs-dark' : 'vs');
  }, [theme.palette.mode]);

  // monaco-yaml must be configured EXACTLY ONCE per monaco instance: each
  // configureMonacoYaml() call registers a new set of language providers, so calling
  // it repeatedly stacks duplicate completion/hover providers (symptom: enum values
  // listed multiple times). We init once and then use the returned handle's update()
  // for schema changes (e.g. when a template injects allowed-image enums).
  useEffect(() => {
    const schemas = schema ? [{ uri: SCHEMA_URI, fileMatch: [MODEL_URI], schema }] : [];
    const options = { enableSchemaRequest: false, validate: true, hover: true, completion: true, schemas };

    if (monacoYaml) {
      monacoYaml.update(options);
    } else {
      monacoYaml = configureMonacoYaml(monaco, options);
    }
  }, [schema]);

  return <div ref={containerRef} style={{ height, width: '100%', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 4 }} data-testid="yaml-editor" />;
}
