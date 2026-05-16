import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App.js';
import { ipc } from './lib/ipc.js';
import './styles/global.css';

// Tag the body with the host OS so CSS can branch on platform without an
// `if (process.platform === …)` everywhere (e.g. titlebar icon offsets).
document.body.classList.add(`platform-${ipc.platform}`);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
