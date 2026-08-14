// Assembles per-team context the fit axis needs: contention score, derived
// from value concentrated in starters, average starter age, and record.
// fs-backed (server-only) — the output is a plain, JSON-serializable
// Record<rosterId, TeamContext> so it can be embedded straight into a page
// for the client-side grader (pure.ts) to consume.
import { readJSON } from '../fsjson.ts';
import type { SleeperLeague, SleeperRoster, SleeperUser } from '../sleeper.ts';
import type { TradeValueCache, TeamContext } from './pure.ts';
import { getPlayerValue } from './pure.ts';

interface PlayerRecord {
  full_name: string;
  position: string;
  age: number | null;
}

export interface LeagueRosterContext {
  teams: Record<number, TeamContext>;
  rosters: Record<number, SleeperRoster>;
}

function rankNormalize(values: (number | null)[]): number[] {
  // Rank-based normalization to [-1, 1] — robust to outliers, avoids one
  // huge/old roster skewing every other team's z-score.
  const indexed = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null) as { v: number; i: number }[];
  const sorted = [...indexed].sort((a, b) => a.v - b.v);
  const n = sorted.length;
  const out = new Array(values.length).fill(0);
  sorted.forEach((entry, rank) => {
    out[entry.i] = n > 1 ? (rank / (n - 1)) * 2 - 1 : 0;
  });
  return out;
}

export async function buildLeagueRosterContext(cache: TradeValueCache): Promise<LeagueRosterContext> {
  const [league, rosters, users, players] = await Promise.all([
    readJSON<SleeperLeague | null>('data/cache/league.json', null),
    readJSON<SleeperRoster[]>('data/cache/rosters.json', []),
    readJSON<SleeperUser[]>('data/cache/users.json', []),
    readJSON<Record<string, PlayerRecord>>('data/cache/players.json', {}),
  ]);

  const userByUserId = new Map(users.map((u) => [u.user_id, u]));
  const rosterRecord: Record<number, SleeperRoster> = {};
  for (const r of rosters) rosterRecord[r.roster_id] = r;

  const usesCurrentRecord = rosters.some((r) => r.settings.wins + r.settings.losses > 0);
  let winPctByRoster: Map<number, number>;
  if (usesCurrentRecord) {
    winPctByRoster = new Map(
      rosters.map((r) => {
        const games = r.settings.wins + r.settings.losses + r.settings.ties;
        return [r.roster_id, games > 0 ? (r.settings.wins + r.settings.ties * 0.5) / games : 0.5];
      })
    );
  } else {
    // Preseason/pre-draft: no games played yet this year. Fall back to the
    // most recently completed season's record as the best available signal.
    const { history } = await readJSON<{ history: { season: string }[] }>('data/cache/season_history.json', {
      history: [],
    });
    const mostRecent = history[0]?.season;
    const prevRosters = mostRecent
      ? await readJSON<SleeperRoster[]>(`data/cache/previous_seasons/${mostRecent}/rosters.json`, [])
      : [];
    winPctByRoster = new Map(
      prevRosters.map((r) => {
        const games = r.settings.wins + r.settings.losses + r.settings.ties;
        return [r.roster_id, games > 0 ? (r.settings.wins + r.settings.ties * 0.5) / games : 0.5];
      })
    );
  }

  const rawTeams = rosters.map((r) => {
    const playerIds = (r.players ?? []).filter((id) => !Number.isNaN(Number(id)));
    const starterIds = (r.starters ?? []).filter((id) => id !== '0' && !Number.isNaN(Number(id)));

    const rosterValue = playerIds.reduce((sum, id) => sum + (getPlayerValue(cache, id)?.value ?? 0), 0);
    const starterValue = starterIds.reduce((sum, id) => sum + (getPlayerValue(cache, id)?.value ?? 0), 0);
    const starterConcentration = rosterValue > 0 ? starterValue / rosterValue : 0;

    const starterAges = starterIds
      .map((id) => getPlayerValue(cache, id)?.age ?? players[id]?.age ?? null)
      .filter((a): a is number => a !== null);
    const avgStarterAge = starterAges.length ? starterAges.reduce((a, b) => a + b, 0) / starterAges.length : null;

    const user = userByUserId.get(r.owner_id);
    const teamName = user?.metadata?.team_name?.trim() || user?.display_name || `Roster ${r.roster_id}`;

    return {
      rosterId: r.roster_id,
      teamName,
      winPct: winPctByRoster.get(r.roster_id) ?? 0.5,
      starterConcentration,
      avgStarterAge,
    };
  });

  const winPctNorm = rankNormalize(rawTeams.map((t) => t.winPct));
  const concentrationNorm = rankNormalize(rawTeams.map((t) => t.starterConcentration));
  const ageNorm = rankNormalize(rawTeams.map((t) => t.avgStarterAge));

  const rawScores = rawTeams.map((_, i) => 0.5 * winPctNorm[i] + 0.3 * concentrationNorm[i] + 0.2 * ageNorm[i]);

  // Blending three independent-ish rank-normalized signals means almost no
  // team ever reaches the full +-1 the blend is mathematically capable of —
  // that requires being simultaneously the most winning, most
  // starter-concentrated, AND oldest/youngest roster in the league. But
  // CONTENDER_FIT / REBUILDER_FIT's stated bumps (the ones that let a
  // genuine win-win trade grade out as an A) are calibrated against that
  // full +-1. Left unscaled, they're a ceiling nobody in a real league ever
  // touches. Rescale so this league's actual most extreme contender and
  // rebuilder reach the full +-1, and everyone else scales relative to
  // them — the fit multipliers stay meaningful for the teams they're
  // supposed to describe instead of being permanently damped.
  const maxAbsScore = Math.max(...rawScores.map((s) => Math.abs(s)), 0.0001);

  const teams: Record<number, TeamContext> = {};
  rawTeams.forEach((t, i) => {
    const contentionScore = Math.max(-1, Math.min(1, rawScores[i] / maxAbsScore));
    teams[t.rosterId] = { rosterId: t.rosterId, teamName: t.teamName, contentionScore };
  });

  return { teams, rosters: rosterRecord };
}
