/**
 * three.js re-export bridge — `@pi-desktop/canvas/three`.
 *
 * The desktop app deliberately does NOT depend on `three` itself; the canvas
 * package owns the (heavy) 3D runtime for its model surface. Consumers that
 * need a raw three scene (e.g. the Tripo workspace viewer) import THIS subpath
 * from inside a React.lazy chunk, so the bundler folds three into that lazy
 * chunk exactly like `surfaces/model-surface.tsx` does — three never touches
 * the main bundle unless a 3D view is actually opened.
 */
export * as THREE from 'three';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
