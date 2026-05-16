import type { NodePdfApi } from '~preload/index.js';

declare global {
  interface Window {
    nodePdf: NodePdfApi;
  }
}

export const ipc = window.nodePdf;
