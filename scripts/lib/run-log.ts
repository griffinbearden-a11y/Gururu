// A minimal run log every scheduled script appends to. The health email
// reads it for "last successful poll" and "cron failures this week" without
// needing GitHub Actions billing/run-history API access.
import { readJSON, writeJSON } from './fsjson.ts';

const LOG_PATH = 'data/cache/run_log.json';
const MAX_ENTRIES = 500;

export interface RunLogEntry {
  script: string;
  status: 'success' | 'failure';
  detail?: string;
  at: string;
}

export async function logRun(script: string, status: 'success' | 'failure', detail?: string): Promise<void> {
  const data = await readJSON<{ entries: RunLogEntry[] }>(LOG_PATH, { entries: [] });
  data.entries.push({ script, status, detail, at: new Date().toISOString() });
  if (data.entries.length > MAX_ENTRIES) data.entries = data.entries.slice(-MAX_ENTRIES);
  await writeJSON(LOG_PATH, data);
}

export async function getRunLog(): Promise<RunLogEntry[]> {
  const data = await readJSON<{ entries: RunLogEntry[] }>(LOG_PATH, { entries: [] });
  return data.entries;
}
