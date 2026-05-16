import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { HomeFolder } from '~shared/types/ipc.js';
import { handle } from './register.js';

const CANDIDATE_FOLDERS = ['Downloads', 'Desktop', 'Documents'] as const;

export function registerShellIpc(): void {
  // Lightweight directory listing for the "Your computer" pane in the home
  // view. Clicking a folder in the UI re-opens the system "Open PDF" dialog
  // rooted at that folder (see pdf:open), so all we need here is name +
  // path for the home subdirectories that actually exist on this machine.
  handle<[], HomeFolder[]>(IPC_CHANNELS.shell.homeFolders, async () => {
    const home = os.homedir();
    const folders: HomeFolder[] = [];
    for (const name of CANDIDATE_FOLDERS) {
      const folderPath = path.join(home, name);
      try {
        const stat = await fs.stat(folderPath);
        if (stat.isDirectory()) folders.push({ name, path: folderPath });
      } catch {
        // Folder doesn't exist on this machine — skip it.
      }
    }
    return folders;
  });
}
