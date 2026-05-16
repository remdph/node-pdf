import { registerAppIpc } from './app.js';
import { registerPdfIpc } from './pdf.js';
import { registerRecentsIpc } from './recents.js';
import { registerStampsIpc } from './stamps.js';
import { registerWindowIpc } from './window.js';

export function registerAllIpc(): void {
  registerAppIpc();
  registerWindowIpc();
  registerPdfIpc();
  registerStampsIpc();
  registerRecentsIpc();
}
