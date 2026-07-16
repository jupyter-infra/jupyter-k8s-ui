// Local re-export of monaco-yaml's worker. Importing the package worker directly via
// `?worker` breaks under Vite ("Unexpected usage" / EditorSimpleWorker); the official
// monaco-yaml Vite workaround is to re-export it from a first-party file and load THAT
// with `?worker`. See monaco-yaml README, "Why doesn't it work with Vite?".
import 'monaco-yaml/yaml.worker';
