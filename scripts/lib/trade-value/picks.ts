// Draft pick ownership (Part 2 of the brief) — the fs-backed half. Pure
// slotting/pricing math (valuePick, bucketing) lives in pure.ts so it can
// also be bundled client-side; this file assembles the plain-data context
// pure.ts's valuePick() needs, from Sleeper's cached JSON.
import { readJSON } from '../fsjson.ts';
import type { SleeperLeague, SleeperRoster, SleeperTradedPick } from '../sleeper.ts';
import { PICK_OWNERSHIP_YEARS_AHEAD } from './config.ts';
import type { TradeValueCache, PickValuationContext } from './pure.ts';

export interface PickOwnership {
  season: string;
  round: number;
  originalRosterId: number;
  ownerRosterId: number;
}

export async function computePickOwnership(): Promise<PickOwnership[]> {
  const league = await readJSON<SleeperLeague | null>('data/cache/league.json', null);
  const tradedPicks = await readJSON<SleeperTradedPick[]>('data/cache/traded_picks.json', []);
  if (!league) return [];

  const rounds = (league.settings as unknown as { draft_rounds?: number })?.draft_rounds ?? 4;
  const teamCount = league.settings?.num_teams ?? 12;
  const startSeason = Number(league.season);

  const ownership = new Map<string, PickOwnership>();
  for (let yearOffset = 0; yearOffset < PICK_OWNERSHIP_YEARS_AHEAD; yearOffset++) {
    const season = String(startSeason + yearOffset);
    for (let round = 1; round <= rounds; round++) {
      for (let rosterId = 1; rosterId <= teamCount; rosterId++) {
        const key = `${season}_${round}_${rosterId}`;
        ownership.set(key, { season, round, originalRosterId: rosterId, ownerRosterId: rosterId });
      }
    }
  }

  for (const tp of tradedPicks) {
    const key = `${tp.season}_${tp.round}_${tp.roster_id}`;
    const entry = ownership.get(key);
    if (entry) entry.ownerRosterId = tp.owner_id;
  }

  return Array.from(ownership.values());
}

// The upcoming rookie draft's season. If the league hasn't drafted yet this
// season, that's the next draft; otherwise it's next year's.
export function nextDraftSeason(league: SleeperLeague): number {
  const season = Number(league.season);
  return league.status === 'pre_draft' ? season : season + 1;
}

// Reverse-standings draft order for the upcoming rookie draft, derived from
// the most recently completed season on record. Approximation: sorts by
// wins desc then points-for desc as a tiebreak (real Sleeper standings also
// factor in playoff results for the top seeds) — good enough for pick
// slotting and easy to refine later with winners_bracket.json.
export async function projectedFinishOrder(): Promise<number[] /* roster_id, best to worst */> {
  const { history } = await readJSON<{ history: { season: string }[] }>('data/cache/season_history.json', {
    history: [],
  });
  const mostRecent = history[0]?.season;
  if (!mostRecent) return [];
  const rosters = await readJSON<SleeperRoster[]>(`data/cache/previous_seasons/${mostRecent}/rosters.json`, []);
  return rosters
    .slice()
    .sort((a, b) => {
      const winsA = a.settings.wins,
        winsB = b.settings.wins;
      if (winsA !== winsB) return winsB - winsA;
      const pfA = (a.settings.fpts ?? 0) + (a.settings.fpts_decimal ?? 0) / 100;
      const pfB = (b.settings.fpts ?? 0) + (b.settings.fpts_decimal ?? 0) / 100;
      return pfB - pfA;
    })
    .map((r) => r.roster_id);
}

export async function buildPickValuationContext(cache: TradeValueCache): Promise<PickValuationContext | null> {
  const league = await readJSON<SleeperLeague | null>('data/cache/league.json', null);
  if (!league) return null;
  const finishOrder = await projectedFinishOrder();
  return { nextDraftSeason: nextDraftSeason(league), finishOrder, cache };
}
