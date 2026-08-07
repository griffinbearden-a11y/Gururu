// Thin client for the read-only Sleeper API. No auth, no key.
// Keeps requests well under the documented rate limit by spacing calls
// and lets ingest-sleeper.ts decide what to fetch and how often.

const BASE_URL = 'https://api.sleeper.app/v1';
const MIN_INTERVAL_MS = 700; // ~85 req/min ceiling, under the 90/min target

let lastRequestAt = 0;

async function throttledFetch(url: string): Promise<Response> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Sleeper API ${res.status} ${res.statusText} for ${url}`);
  }
  return res;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await throttledFetch(`${BASE_URL}${path}`);
  return (await res.json()) as T;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  status: string;
  previous_league_id: string | null;
  draft_id: string | null;
  roster_positions: string[];
  settings: Record<string, number>;
  scoring_settings: Record<string, number>;
}

export interface SleeperUser {
  user_id: string;
  display_name: string;
  metadata: { team_name?: string } | null;
  avatar: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string;
  players: string[] | null;
  starters: string[] | null;
  taxi: string[] | null;
  reserve: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts: number;
    fpts_decimal?: number;
    fpts_against: number;
    fpts_against_decimal?: number;
    division?: number;
  };
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: string[];
  players: string[];
}

export interface SleeperTransaction {
  transaction_id: string;
  type: 'trade' | 'waiver' | 'free_agent' | 'commissioner';
  status: string;
  status_updated: number;
  creator: string;
  roster_ids: number[];
  consenter_ids: number[] | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: unknown[];
  waiver_budget: { sender: number; receiver: number; amount: number }[];
  leg: number;
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
}

export interface SleeperDraft {
  draft_id: string;
  season: string;
  status: string;
  type: string;
}

export interface SleeperDraftPick {
  round: number;
  pick_no: number;
  roster_id: number;
  player_id: string;
  picked_by: string;
  metadata: Record<string, string>;
}

export interface SleeperBracketMatch {
  r: number;
  m: number;
  t1: number | { w: number } | { l: number } | null;
  t2: number | { w: number } | { l: number } | null;
  w: number | null;
  l: number | null;
  p?: number;
}

export const getLeague = (leagueId: string) => getJSON<SleeperLeague>(`/league/${leagueId}`);
export const getUsers = (leagueId: string) => getJSON<SleeperUser[]>(`/league/${leagueId}/users`);
export const getRosters = (leagueId: string) => getJSON<SleeperRoster[]>(`/league/${leagueId}/rosters`);
export const getMatchups = (leagueId: string, week: number) =>
  getJSON<SleeperMatchup[]>(`/league/${leagueId}/matchups/${week}`);
export const getTransactions = (leagueId: string, week: number) =>
  getJSON<SleeperTransaction[]>(`/league/${leagueId}/transactions/${week}`);
export const getTradedPicks = (leagueId: string) =>
  getJSON<SleeperTradedPick[]>(`/league/${leagueId}/traded_picks`);
export const getDrafts = (leagueId: string) => getJSON<SleeperDraft[]>(`/league/${leagueId}/drafts`);
export const getDraftPicks = (draftId: string) => getJSON<SleeperDraftPick[]>(`/draft/${draftId}/picks`);
export const getWinnersBracket = (leagueId: string) =>
  getJSON<SleeperBracketMatch[]>(`/league/${leagueId}/winners_bracket`);

// ~5MB. Fetch at most once per 24h, cached to disk by the caller.
export const getAllPlayersNFL = () => getJSON<Record<string, unknown>>(`/players/nfl`);
