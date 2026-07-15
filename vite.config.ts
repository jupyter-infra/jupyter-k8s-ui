import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
    // NOTE: do NOT alias `monaco-editor` to its `editor.api` entry to trim bundled
    // languages — doing so makes monaco-yaml's worker protocol talk to a different
    // monaco module instance and breaks validation ("Missing method: doValidation").
    // The full monaco chunk is route-lazy (WorkspaceAdvancedEditor), so it never hits
    // the main bundle; working validation is worth the extra weight.
  },
  css: {
    modules: {
      // CSS Modules configuration
      localsConvention: 'camelCase',
      scopeBehaviour: 'local',
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8090',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React core
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // MUI
          'vendor-mui': ['@mui/material', '@mui/icons-material'],
          // Data fetching
          'vendor-query': ['@tanstack/react-query'],
          // NOTE: monaco-editor/monaco-yaml are intentionally NOT split into their own
          // manualChunk. Doing so reordered module init across chunks so that Monaco's
          // worker factory ran before monacoSetup could install MonacoEnvironment,
          // breaking the language worker. Left unsplit, they ride the lazy
          // WorkspaceAdvancedEditor chunk (still out of the main bundle, since that
          // route is lazy-loaded).
        },
      },
    },
  },
});
