/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

// SVG-as-React-component imports (vite-plugin-svgr, `?react` query). App-type logos
// live in src/assets/logos/*.svg and are imported as components.
declare module '*.svg?react' {
  import type { FunctionComponent, SVGProps } from 'react';
  const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement> & { title?: string }>;
  export default ReactComponent;
}

// CSS Modules type declarations
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.sass' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
