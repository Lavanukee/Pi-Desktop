import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connectLlm } from './state/llm-store';
import { connectPi } from './state/pi-connect';
import { connectSettings } from './state/settings-store';
import './styles/global.css';

// Attach the pi + inference event streams before React mounts so nothing
// buffered (pre-mount events) is lost, and load settings (theme is applied from
// them). The standalone canvas pop-out window (?canvasPopout=1) mounts only the
// canvas, so it needs none of these.
if (!new URLSearchParams(window.location.search).has('canvasPopout')) {
  connectPi();
  connectLlm();
  connectSettings();
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html is missing the #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
