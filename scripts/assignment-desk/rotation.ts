// The static schedule table (brief section 7) plus reactive-trigger
// detection off the transaction poller. Reactive pieces sit outside the
// rotation but still count against the daily circuit breaker.
import { getSeasonPhase } from '../lib/season.ts';
import { hasReacted } from '../lib/circuit-breakers.ts';
import { readJSON } from '../lib/fsjson.ts';
import type { WriterId } from './context.ts';

// 0=Sun ... 6=Sat. No day exceeds 2 writers, so the rotation alone never
// breaches the 2-article daily cap on its own.
const IN_SEASON_ROTATION: Record<number, WriterId[]> = {
  0: ['doyle'],
  1: ['wolf'],
  2: ['vail', 'doyle'],
  3: ['wolf'],
  4: ['vail', 'doyle'],
  5: ['wolf'],
  6: ['vail'],
};

const PRESEASON_ROTATION: Record<number, WriterId[]> = {
  0: ['doyle'],
  1: ['wolf'],
  2: ['vail'],
  // TEMPORARY: Wednesday added for a one-time catch-up after a few missed
  // days — revert once Doyle's extra article has published.
  3: ['doyle'],
};

// The last of each writer's three weekly slots is their wildcard slot.
const WILDCARD_DAY: Record<WriterId, number> = { wolf: 5, vail: 6, doyle: 4 };

export interface ScheduledSlot {
  writer: WriterId;
  isWildcard: boolean;
}

export async function getScheduledSlotsForToday(now = new Date()): Promise<ScheduledSlot[]> {
  const phase = await getSeasonPhase();
  const day = now.getDay();
  if (phase === 'offseason') return [];
  const table = phase === 'preseason' ? PRESEASON_ROTATION : IN_SEASON_ROTATION;
  const writers = table[day] ?? [];
  return writers.map((writer) => ({
    writer,
    isWildcard: phase !== 'preseason' && WILDCARD_DAY[writer] === day,
  }));
}

interface RawTransaction {
  transaction_id: string;
  type: string;
  status: string;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
}

async function describeTrade(tx: RawTransaction): Promise<string> {
  const [{ teams }, players] = await Promise.all([
    readJSON<{ teams: { roster_id: number; team_name: string }[] }>('data/cache/team_directory.json', { teams: [] }),
    readJSON<Record<string, { full_name: string }>>('data/cache/players.json', {}),
  ]);
  const teamByRoster = new Map(teams.map((t) => [t.roster_id, t.team_name]));
  const teamNames = tx.roster_ids.map((id) => teamByRoster.get(id) ?? `Roster ${id}`).join(' <-> ');
  const adds = tx.adds ? Object.keys(tx.adds).map((id) => players[id]?.full_name ?? id).join(', ') : '';
  return `Trade between ${teamNames}${adds ? `, involving: ${adds}` : ''}`;
}

// Wolf and Vail both carry trade_grade; Doyle carries the_wire. Pick whoever
// has published least recently among writers who can actually take the
// format, so reactions don't pile onto one byline.
export async function getReactiveAssignments(): Promise<
  { writer: WriterId; transactionId: string; format: string; description: string }[]
> {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const dir = 'data/cache/transactions';
  if (!existsSync(dir)) return [];

  const all: RawTransaction[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const txs = JSON.parse(readFileSync(`${dir}/${file}`, 'utf-8')) as RawTransaction[];
    all.push(...txs.filter((t) => t.type === 'trade' && t.status === 'complete'));
  }

  const { entries: ledger } = await readJSON<{ entries: { writer: WriterId; date: string }[] }>('data/ledger.json', { entries: [] });
  const lastPublishedAt = new Map<WriterId, number>();
  for (const e of ledger) {
    const t = new Date(e.date).getTime();
    if (!lastPublishedAt.has(e.writer) || t > lastPublishedAt.get(e.writer)!) lastPublishedAt.set(e.writer, t);
  }
  const candidates: { writer: WriterId; format: string }[] = [
    { writer: 'wolf', format: 'trade_grade' },
    { writer: 'vail', format: 'trade_grade' },
    { writer: 'doyle', format: 'the_wire' },
  ];

  const assignments: { writer: WriterId; transactionId: string; format: string; description: string }[] = [];
  for (const tx of all) {
    if (await hasReacted(tx.transaction_id)) continue;
    const pick = [...candidates].sort((a, b) => (lastPublishedAt.get(a.writer) ?? 0) - (lastPublishedAt.get(b.writer) ?? 0))[0];
    assignments.push({ writer: pick.writer, transactionId: tx.transaction_id, format: pick.format, description: await describeTrade(tx) });
  }
  return assignments;
}
