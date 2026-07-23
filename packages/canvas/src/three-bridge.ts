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
// Loaders: GLTFLoader decodes the studio's bundled sample GLBs (offline via
// .parse) AND drag-and-dropped .glb/.gltf files; OBJ/STL cover the other
// import formats the 3D studio accepts.
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
export { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
// Exporters: the studio's Export dialog writes real files with these.
export { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
export { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
export { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
export { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
