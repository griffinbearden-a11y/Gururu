import { readJSON } from './fsjson.ts';

export type SeasonPhase = 'preseason' | 'in_season' | 'playoffs' | 'offseason';

interface LeagueCache {
  status: string;
  settings: { playoff_week_start: number; leg: number };
}

// Maps Sleeper's league status + current leg onto the four windows the
// format library uses. Sleeper has no explicit "playoffs" status distinct
// from in_season, so infer it from playoff_week_start.
export async function getSeasonPhase(): Promise<SeasonPhase> {
  const league = await readJSON<LeagueCache | null>('data/cache/league.json', null);
  if (!league) return 'offseason';
  if (league.status === 'complete') return 'offseason';
  if (league.status === 'pre_draft' || league.status === 'drafting') return 'preseason';
  if (league.status === 'in_season') {
    return league.settings.leg >= league.settings.playoff_week_start ? 'playoffs' : 'in_season';
  }
  return 'offseason';
}
