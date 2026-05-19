import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App.js';
import { ipc } from './lib/ipc.js';
import { applyTheme, readCachedTheme } from './lib/theme.js';
import './styles/global.css';

// Tag the body with the host OS so CSS can branch on platform without an
// `if (process.platform === …)` everywhere (e.g. titlebar icon offsets).
document.body.classList.add(`platform-${ipc.platform}`);

// Apply the cached theme attribute synchronously, BEFORE React mounts,
// so the user doesn't see a one-frame flash of the dark palette on
// cold start when their saved theme is light. App.tsx reconciles with
// the real settings value as soon as the settings IPC resolves.
applyTheme(readCachedTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
