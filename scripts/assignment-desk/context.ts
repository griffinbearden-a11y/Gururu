// Assembles what gets fed to each Claude call: the writer's persona as the
// system prompt, plus a context bundle of current league state, lore, and
// recent ledger history as the user turn.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import matter from 'gray-matter';
import { readJSON } from '../lib/fsjson.ts';

export type WriterId = 'wolf' | 'vail' | 'doyle';

export interface WriterPersona {
  id: WriterId;
  frontmatter: { name: string; byline: string; beat: string; color: string; hired: number };
  systemPrompt: string;
  formatWhitelist: string[];
}

export function loadWriterPersona(writerId: WriterId): WriterPersona {
  const raw = readFileSync(`writers/${writerId}.md`, 'utf-8');
  const { data, content } = matter(raw);

  const sectionMatch = content.match(/## Formats you may pitch\s*\n+([\s\S]*?)(?=\n## |\n?$)/);
  const formatWhitelist = sectionMatch
    ? sectionMatch[1]
        .split(/[·\n]/)
        .map((s) => s.replace(/\([^)]*\)/g, '').trim())
        .filter(Boolean)
    : [];

  return {
    id: writerId,
    frontmatter: data as WriterPersona['frontmatter'],
    systemPrompt: content.trim(),
    formatWhitelist,
  };
}

export function loadLore(): string {
  const path = 'data/league_lore.md';
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

export interface LedgerEntry {
  writer: WriterId;
  date: string;
  slug: string;
  format: string;
  subject_teams: number[];
  thesis: string;
}

export async function getRecentLedger(limit = 20): Promise<LedgerEntry[]> {
  const { entries } = await readJSON<{ entries: LedgerEntry[] }>('data/ledger.json', { entries: [] });
  return entries.slice(-limit);
}

export async function getFullLedger(): Promise<LedgerEntry[]> {
  const { entries } = await readJSON<{ entries: LedgerEntry[] }>('data/ledger.json', { entries: [] });
  return entries;
}

export interface TeamDirectoryEntry {
  roster_id: number;
  team_name: string;
  owner_username: string;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  division: number | null;
}

export async function getTeamDirectory(): Promise<TeamDirectoryEntry[]> {
  const { teams } = await readJSON<{ teams: TeamDirectoryEntry[] }>('data/cache/team_directory.json', { teams: [] });
  return teams;
}

export async function getLeagueSummary(): Promise<string> {
  const teams = await getTeamDirectory();
  const league = await readJSON<Record<string, unknown> | null>('data/cache/league.json', null);
  const lines = [
    `League status: ${league?.status ?? 'unknown'}, season ${league?.season ?? 'unknown'}`,
    '',
    'Standings (roster_id: team_name, W-L-T, PF-PA):',
    ...teams
      .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for)
      .map((t) => `  ${t.roster_id}: ${t.team_name} (${t.owner_username}), ${t.wins}-${t.losses}-${t.ties}, ${t.points_for.toFixed(1)}-${t.points_against.toFixed(1)}`),
  ];
  return lines.join('\n');
}

export async function getRecentTransactionsSummary(limit = 15): Promise<string> {
  const dir = 'data/cache/transactions';
  if (!existsSync(dir)) return 'No transaction data available.';
  const players = await readJSON<Record<string, { full_name: string }>>('data/cache/players.json', {});
  const teams = await getTeamDirectory();
  const teamByRoster = new Map(teams.map((t) => [t.roster_id, t.team_name]));

  const all: { status_updated: number; type: string; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null }[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const txs = JSON.parse(readFileSync(`${dir}/${file}`, 'utf-8'));
    all.push(...txs.filter((t: { status: string }) => t.status === 'complete'));
  }
  all.sort((a, b) => b.status_updated - a.status_updated);

  return all
    .slice(0, limit)
    .map((tx) => {
      // Group added players by the specific roster they landed on. A flat
      // "added: A, B, C" list across a multi-team trade is ambiguous about
      // who actually got what — that ambiguity is what caused a real
      // published error (a trade's two sides got swapped in an article).
      const byDestination = new Map<number, string[]>();
      if (tx.adds) {
        for (const [playerId, rosterId] of Object.entries(tx.adds)) {
          const name = players[playerId]?.full_name ?? playerId;
          if (!byDestination.has(rosterId)) byDestination.set(rosterId, []);
          byDestination.get(rosterId)!.push(name);
        }
      }
      const parts = tx.roster_ids.map((id) => {
        const team = teamByRoster.get(id) ?? `Roster ${id}`;
        const gained = byDestination.get(id);
        return gained?.length ? `${team} gets: ${gained.join(', ')}` : team;
      });
      return `  [${new Date(tx.status_updated).toISOString().slice(0, 10)}] ${tx.type} — ${parts.join(' | ')}`;
    })
    .join('\n');
}

export interface WriterStateEntry {
  grudges: { target: string; team?: string; incident: string; status: string; since: string }[];
  positions: { claim: string; since: string; status: string }[];
  track_record: { verified_hits: number; verified_total: number; claimed_hits: number; claimed_total: number; last_updated: string | null };
}

export async function getWriterState(writerId: WriterId): Promise<WriterStateEntry> {
  const all = await readJSON<Record<WriterId, WriterStateEntry>>('data/writer_state.json', {} as any);
  return all[writerId];
}

export async function buildContextBundle(writerId: WriterId): Promise<string> {
  const [lore, leagueSummary, recentTx, ledger, state] = await Promise.all([
    loadLore(),
    getLeagueSummary(),
    getRecentTransactionsSummary(),
    getRecentLedger(20),
    getWriterState(writerId),
  ]);

  return [
    '# League lore (static, hand-written)',
    lore || '(none provided yet)',
    '',
    '# Current league state',
    leagueSummary,
    '',
    '# Recent transactions',
    recentTx || '(none)',
    '',
    '# Last 20 published articles (ledger)',
    ledger.length
      ? ledger.map((e) => `  [${e.date.slice(0, 10)}] ${e.writer}/${e.format} — subjects:[${e.subject_teams.join(',')}] — "${e.thesis}"`).join('\n')
      : '(none published yet)',
    '',
    '# Your standing state',
    `Grudges: ${JSON.stringify(state?.grudges ?? [])}`,
    `Positions: ${JSON.stringify(state?.positions ?? [])}`,
    `Track record: ${JSON.stringify(state?.track_record ?? {})}`,
  ].join('\n');
}
