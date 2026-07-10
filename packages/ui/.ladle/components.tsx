/**
 * Ladle global provider: renders every story under the 4-way theme matrix.
 * data-mode follows Ladle's own theme switcher (?theme=light|dark); data-flavor
 * comes from the ?flavor= query param (used by scripts/screenshot-stories.mjs)
 * or the floating toggle rendered in browse mode.
 */

import type { GlobalProvider } from '@ladle/react';
import { useEffect, useState } from 'react';
import { TooltipProvider } from '../src/index.ts';
import '@pi-desktop/themes/themes.css';
import '../src/styles.css';
import './ladle.css';

type Flavor = 'claude' | 'codex';

// Captured before Ladle normalizes the URL.
const initialFlavor: Flavor =
  new URLSearchParams(window.location.search).get('flavor') === 'codex' ? 'codex' : 'claude';

export const Provider: GlobalProvider = ({ children, globalState }) => {
  const [flavor, setFlavor] = useState<Flavor>(initialFlavor);
  const mode =
    globalState.theme === 'dark' ||
    (globalState.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark'
      : 'light';

  useEffect(() => {
    document.documentElement.setAttribute('data-flavor', flavor);
    document.documentElement.setAttribute('data-mode', mode);
  }, [flavor, mode]);

  return (
    <TooltipProvider delayDuration={200}>
      {globalState.mode !== 'preview' ? (
        <button
          type="button"
          className="ladle-flavor-toggle"
          onClick={() => setFlavor(flavor === 'claude' ? 'codex' : 'claude')}
        >
          flavor: {flavor}
        </button>
      ) : null}
      {children}
    </TooltipProvider>
  );
};
