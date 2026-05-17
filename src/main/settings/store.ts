import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NodePdfError } from '~shared/types/errors.js';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from '~shared/types/settings.js';

const FILE = 'settings.json';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE);
}

// In-process cache so reads are O(1) once warmed. Settings are only mutated
// by IPC handlers in this process, so we don't need to invalidate on file
// changes — every writer goes through `setSettings` below.
let cache: AppSettings | null = null;

async function readFromDisk(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    // Defaults sit underneath the file contents so a settings.json written by
    // an older build keeps working when we add new keys.
    return { ...DEFAULT_SETTINGS, ...(parsed as Partial<AppSettings>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw new NodePdfError('READ_FAILED', 'Failed to read settings.json', err);
  }
}

export async function getSettings(): Promise<AppSettings> {
  if (!cache) cache = await readFromDisk();
  return cache;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = { ...current, ...patch };
  try {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to write settings.json', err);
  }
  cache = next;
  return next;
}
