// Every hard limit from brief section 12, in one place. State persists to
// disk (committed like the rest of /data/cache) so it survives across the
// stateless GitHub Actions runners.
import { readJSON, writeJSON } from './fsjson.ts';

const STATE_PATH = 'data/cache/circuit_breaker_state.json';
const MAX_ARTICLES_PER_DAY = 2;
const MAX_CONSECUTIVE_PITCH_FAILURES = 3;

interface CircuitState {
  paused: boolean;
  paused_reason: string | null;
  paused_at: string | null;
  daily_publish_counts: Record<string, number>; // YYYY-MM-DD -> count
  consecutive_pitch_failures: number;
  reacted_transaction_ids: string[];
}

const DEFAULT_STATE: CircuitState = {
  paused: false,
  paused_reason: null,
  paused_at: null,
  daily_publish_counts: {},
  consecutive_pitch_failures: 0,
  reacted_transaction_ids: [],
};

async function load(): Promise<CircuitState> {
  return readJSON<CircuitState>(STATE_PATH, DEFAULT_STATE);
}
async function save(state: CircuitState): Promise<void> {
  await writeJSON(STATE_PATH, state);
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function isPaused(): Promise<{ paused: boolean; reason: string | null }> {
  const state = await load();
  return { paused: state.paused, reason: state.paused_reason };
}

export async function pauseSystem(reason: string): Promise<void> {
  const state = await load();
  state.paused = true;
  state.paused_reason = reason;
  state.paused_at = new Date().toISOString();
  await save(state);
}

// Not exposed for automated use — the brief's "published boolean +
// password-protected admin route" is the intended way to flip this back on.
// This helper exists for scripts (e.g. after a human fixes the underlying
// problem) rather than for the pipeline to call on itself.
export async function resumeSystem(): Promise<void> {
  const state = await load();
  state.paused = false;
  state.paused_reason = null;
  state.paused_at = null;
  state.consecutive_pitch_failures = 0;
  await save(state);
}

export async function todaysPublishCount(): Promise<number> {
  const state = await load();
  return state.daily_publish_counts[todayKey()] ?? 0;
}

export async function dailyLimitReached(): Promise<boolean> {
  return (await todaysPublishCount()) >= MAX_ARTICLES_PER_DAY;
}

export async function recordPublish(): Promise<void> {
  const state = await load();
  const key = todayKey();
  state.daily_publish_counts[key] = (state.daily_publish_counts[key] ?? 0) + 1;
  await save(state);
}

export async function recordPitchFailure(): Promise<void> {
  const state = await load();
  state.consecutive_pitch_failures += 1;
  if (state.consecutive_pitch_failures >= MAX_CONSECUTIVE_PITCH_FAILURES) {
    state.paused = true;
    state.paused_reason = `${MAX_CONSECUTIVE_PITCH_FAILURES} consecutive pitch-step failures`;
    state.paused_at = new Date().toISOString();
  }
  await save(state);
}

export async function recordPitchSuccess(): Promise<void> {
  const state = await load();
  state.consecutive_pitch_failures = 0;
  await save(state);
}

export async function hasReacted(transactionId: string): Promise<boolean> {
  const state = await load();
  return state.reacted_transaction_ids.includes(transactionId);
}

export async function markReacted(transactionId: string): Promise<void> {
  const state = await load();
  if (!state.reacted_transaction_ids.includes(transactionId)) {
    state.reacted_transaction_ids.push(transactionId);
  }
  await save(state);
}
