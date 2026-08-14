// Builds and reads the daily FantasyCalc value cache. Player values get the
// league-bias adjustments (flex depth boost, QB adjustment) and the manual
// override layer applied here, once, at cache-build time — everything
// downstream (grading, UI) reads pre-adjusted numbers straight off disk.
//
// Pick pseudo-player entries are kept separate and unadjusted (round/class
// pricing happens in picks.ts, which needs the raw FantasyCalc numbers).
import { readJSON } from '../fsjson.ts';
import type { FantasyCalcEntry } from './fantasycalc-client.ts';
import { FLEX_DEPTH_BOOST, FLEX_DEPTH_BOOST_MIN_RANK, QB_ADJUSTMENT } from './config.ts';

export const VALUES_CACHE_PATH = 'data/cache/trade_values.json';
export const OVERRIDES_PATH = 'data/trade_value_overrides.json';

export interface PlayerValueEntry {
  sleeperId: string;
  name: string;
  position: string;
  age: number | null;
  team: string | null;
  fantasyCalcValue: number; // straight off the API
  value: number; // after flex/QB adjustment + manual override
  overallRank: number;
  positionRank: number;
  trend30Day: number;
  overrideMultiplier: number | null;
}

// Exact next-draft slot, e.g. "2026 Pick 1.02" -> { year: 2026, round: 1, pickInRound: 2 }.
export interface ExactPickValueEntry {
  value: number;
  overallRank: number;
}

// Bucketed future-year pick, e.g. "2027 1st (Early)".
export type PickBucket = 'early' | 'mid' | 'late';
export interface BucketedPickValueEntry {
  value: number;
  overallRank: number;
}

// Generic year+round pick with no slot/bucket info, e.g. "2028 1st".
export interface GenericPickValueEntry {
  value: number;
  overallRank: number;
}

export interface TradeValueCache {
  fetchedAt: string;
  playerCount: number;
  players: Record<string, PlayerValueEntry>; // keyed by sleeperId
  exactPicks: Record<string, ExactPickValueEntry>; // key `${year}_${round}_${pickInRound}`
  bucketedPicks: Record<string, BucketedPickValueEntry>; // key `${year}_${round}_${bucket}`
  genericPicks: Record<string, GenericPickValueEntry>; // key `${year}_${round}`
}

const EMPTY_CACHE: TradeValueCache = {
  fetchedAt: '',
  playerCount: 0,
  players: {},
  exactPicks: {},
  bucketedPicks: {},
  genericPicks: {},
};

const EXACT_RE = /^(\d{4}) Pick (\d+)\.(\d+)$/;
const BUCKETED_RE = /^(\d{4}) (\d+)(?:st|nd|rd|th) \((Early|Mid|Late)\)$/;
const GENERIC_RE = /^(\d{4}) (\d+)(?:st|nd|rd|th)$/;

interface Overrides {
  overrides: Record<string, number>;
}

export async function loadOverrides(): Promise<Record<string, number>> {
  const { overrides } = await readJSON<Overrides>(OVERRIDES_PATH, { overrides: {} });
  return overrides;
}

export async function buildValueCache(
  raw: FantasyCalcEntry[],
  overrides: Record<string, number>
): Promise<TradeValueCache> {
  const players: Record<string, PlayerValueEntry> = {};
  const exactPicks: Record<string, ExactPickValueEntry> = {};
  const bucketedPicks: Record<string, BucketedPickValueEntry> = {};
  const genericPicks: Record<string, GenericPickValueEntry> = {};

  for (const entry of raw) {
    if (entry.player.position === 'PICK') {
      const name = entry.player.name;
      const exact = name.match(EXACT_RE);
      if (exact) {
        const [, year, round, pickInRound] = exact;
        exactPicks[`${year}_${round}_${pickInRound}`] = { value: entry.value, overallRank: entry.overallRank };
        continue;
      }
      const bucketed = name.match(BUCKETED_RE);
      if (bucketed) {
        const [, year, round, bucket] = bucketed;
        bucketedPicks[`${year}_${round}_${bucket.toLowerCase()}`] = { value: entry.value, overallRank: entry.overallRank };
        continue;
      }
      const generic = name.match(GENERIC_RE);
      if (generic) {
        const [, year, round] = generic;
        genericPicks[`${year}_${round}`] = { value: entry.value, overallRank: entry.overallRank };
      }
      continue;
    }

    if (!entry.player.sleeperId) continue; // no join key back to our rosters — skip

    let value = entry.value;
    if (entry.player.position === 'QB') {
      value *= QB_ADJUSTMENT;
    } else if (entry.overallRank > FLEX_DEPTH_BOOST_MIN_RANK) {
      value *= FLEX_DEPTH_BOOST;
    }

    const overrideMultiplier = overrides[entry.player.sleeperId] ?? null;
    if (overrideMultiplier !== null) value *= overrideMultiplier;

    players[entry.player.sleeperId] = {
      sleeperId: entry.player.sleeperId,
      name: entry.player.name,
      position: entry.player.position,
      age: entry.player.maybeAge,
      team: entry.player.maybeTeam,
      fantasyCalcValue: entry.value,
      value,
      overallRank: entry.overallRank,
      positionRank: entry.positionRank,
      trend30Day: entry.trend30Day,
      overrideMultiplier,
    };
  }

  return {
    fetchedAt: new Date().toISOString(),
    playerCount: Object.keys(players).length,
    players,
    exactPicks,
    bucketedPicks,
    genericPicks,
  };
}

let cached: TradeValueCache | null = null;

export async function getValueCache(): Promise<TradeValueCache> {
  if (cached) return cached;
  cached = await readJSON<TradeValueCache>(VALUES_CACHE_PATH, EMPTY_CACHE);
  return cached;
}

export function getPlayerValue(cache: TradeValueCache, sleeperId: string): PlayerValueEntry | null {
  return cache.players[sleeperId] ?? null;
}
