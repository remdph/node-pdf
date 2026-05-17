import { registerAppIpc } from './app.js';
import { registerCertsIpc } from './certs.js';
import { registerPdfIpc } from './pdf.js';
import { registerRecentsIpc } from './recents.js';
import { registerSettingsIpc } from './settings.js';
import { registerShellIpc } from './shell.js';
import { registerSignaturesIpc } from './signatures.js';
import { registerStampsIpc } from './stamps.js';
import { registerWindowIpc } from './window.js';

export function registerAllIpc(): void {
  registerAppIpc();
  registerWindowIpc();
  registerPdfIpc();
  registerShellIpc();
  registerStampsIpc();
  registerSignaturesIpc();
  registerCertsIpc();
  registerRecentsIpc();
  registerSettingsIpc();
}
