// Build-time reads of /data and /writers, which live outside src/ since
// the assignment-desk scripts write to them directly and git is the
// database. Astro renders these pages at build time in Node, so plain fs
// reads are fine — no client bundle cost.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import matter from 'gray-matter';

// Deliberately not resolved via import.meta.url: after bundling, chunk
// files live under dist/.prerender/ so a URL relative to the source file's
// location breaks. Astro always builds/dev-serves from the project root, so
// cwd is reliable here.
const ROOT = process.cwd() + '/';

function readJSON<T>(relPath: string, fallback: T): T {
  const full = ROOT + relPath;
  if (!existsSync(full)) return fallback;
  return JSON.parse(readFileSync(full, 'utf-8'));
}

export interface LedgerEntry {
  writer: string;
  date: string;
  slug: string;
  format: string;
  subject_teams: number[];
  thesis: string;
}

export interface PredictionEntry {
  writer: string;
  article_slug: string;
  claim: string;
  subject: string;
  resolution_date: string;
  outcome: 'pending' | 'hit' | 'miss' | 'push';
  verified: boolean;
}

export interface CommissionerLedgerEntry {
  transaction_id: string;
  date: string;
  type: string;
  status: string;
  teams_affected: string[];
  added_player_ids: string[];
  dropped_player_ids: string[];
  is_override: boolean;
}

export interface SpikedEntry {
  writer: string;
  headline: string;
  thesis: string;
  format: string;
  reason_stage: 'filter' | 'critic';
  reason_code: string;
  reason_detail: string;
  spiked_at: string;
}

export interface TeamDirectoryEntry {
  roster_id: number;
  owner_id: string;
  owner_username: string;
  team_name: string;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  division: number | null;
}

export interface WriterState {
  grudges: { target: string; team?: string; incident: string; status: string; since: string }[];
  positions: { claim: string; since: string; status: string }[];
  track_record: { verified_hits: number; verified_total: number; claimed_hits: number; claimed_total: number; last_updated: string | null };
}

export const getLedger = () => readJSON<{ entries: LedgerEntry[] }>('data/ledger.json', { entries: [] }).entries;
export const getPredictions = () =>
  readJSON<{ entries: PredictionEntry[] }>('data/predictions.json', { entries: [] }).entries;
export const getCommissionerLedger = () =>
  readJSON<{ entries: CommissionerLedgerEntry[] }>('data/commissioner_ledger.json', { entries: [] }).entries;
export const getSpiked = () => readJSON<{ entries: SpikedEntry[] }>('data/spiked.json', { entries: [] }).entries;
export const getTeamDirectory = () =>
  readJSON<{ teams: TeamDirectoryEntry[] }>('data/cache/team_directory.json', { teams: [] }).teams;
export const getWriterState = () =>
  readJSON<Record<'wolf' | 'vail' | 'doyle', WriterState>>('data/writer_state.json', {} as any);
export const getFormats = () =>
  readJSON<{ formats: { key: string; display_name: string; description: string; season_window: string; league_wide: boolean }[] }>(
    'data/formats.json',
    { formats: [] }
  ).formats;

export interface WriterMeta {
  id: 'wolf' | 'vail' | 'doyle';
  name: string;
  byline: string;
  beat: string;
  color: string;
  hired: number;
}

export function getWriterMeta(id: 'wolf' | 'vail' | 'doyle'): WriterMeta {
  const raw = readFileSync(`${ROOT}writers/${id}.md`, 'utf-8');
  const { data } = matter(raw);
  return data as WriterMeta;
}

export const WRITER_IDS = ['wolf', 'vail', 'doyle'] as const;

export interface RawTransaction {
  transaction_id: string;
  type: string;
  status: string;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
}

interface PlayerRecord {
  full_name: string;
  position: string;
  team: string | null;
}

let playerCache: Record<string, PlayerRecord> | null = null;
export function getPlayerMap(): Record<string, PlayerRecord> {
  if (playerCache) return playerCache;
  playerCache = readJSON<Record<string, PlayerRecord>>('data/cache/players.json', {});
  return playerCache;
}

export function getRecentTransactions(limit = 5): RawTransaction[] {
  const dir = `${ROOT}data/cache/transactions`;
  if (!existsSync(dir)) return [];
  const all: RawTransaction[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const txs = JSON.parse(readFileSync(`${dir}/${file}`, 'utf-8')) as RawTransaction[];
    all.push(...txs.filter((t) => t.status === 'complete'));
  }
  all.sort((a, b) => b.status_updated - a.status_updated);
  return all.slice(0, limit);
}

export function describeTransaction(
  tx: RawTransaction,
  teamByRosterId: Map<number, string>,
  players: Record<string, PlayerRecord>
): string {
  const teamNames = tx.roster_ids.map((id) => teamByRosterId.get(id) ?? `Roster ${id}`);
  const adds = tx.adds ? Object.keys(tx.adds).map((id) => players[id]?.full_name ?? id) : [];
  const drops = tx.drops ? Object.keys(tx.drops).map((id) => players[id]?.full_name ?? id) : [];
  if (tx.type === 'trade') return `Trade: ${teamNames.join(' ↔ ')}`;
  if (adds.length && drops.length) return `${teamNames[0]}: added ${adds.join(', ')}, dropped ${drops.join(', ')}`;
  if (adds.length) return `${teamNames[0]}: added ${adds.join(', ')}`;
  if (drops.length) return `${teamNames[0]}: dropped ${drops.join(', ')}`;
  return `${teamNames.join(', ')}: ${tx.type}`;
}
