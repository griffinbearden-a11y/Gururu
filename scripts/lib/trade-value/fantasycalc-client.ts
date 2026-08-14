// Thin client for FantasyCalc's public values endpoint. No auth, no key.
// Mirrors the style of scripts/lib/sleeper.ts: a plain fetch wrapper, no
// caching or adjustment logic here — that lives in values.ts.
import { FANTASYCALC_PARAMS } from './config.ts';

const BASE_URL = 'https://api.fantasycalc.com/values/current';

export interface FantasyCalcPlayer {
  id: number;
  name: string;
  sleeperId: string | null;
  position: string; // 'QB' | 'RB' | 'WR' | 'TE' | 'PICK'
  maybeAge: number | null;
  maybeTeam: string | null;
}

export interface FantasyCalcEntry {
  player: FantasyCalcPlayer;
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
}

interface RawFantasyCalcEntry {
  player: {
    id: number;
    name: string;
    sleeperId?: string;
    position: string;
    maybeAge?: number;
    maybeTeam?: string;
  };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
}

export async function fetchFantasyCalcValues(): Promise<FantasyCalcEntry[]> {
  const params = new URLSearchParams({
    isDynasty: String(FANTASYCALC_PARAMS.isDynasty),
    numQbs: String(FANTASYCALC_PARAMS.numQbs),
    numTeams: String(FANTASYCALC_PARAMS.numTeams),
    ppr: String(FANTASYCALC_PARAMS.ppr),
  });
  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`FantasyCalc API ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawFantasyCalcEntry[];
  return raw.map((e) => ({
    player: {
      id: e.player.id,
      name: e.player.name,
      sleeperId: e.player.sleeperId ?? null,
      position: e.player.position,
      maybeAge: e.player.maybeAge ?? null,
      maybeTeam: e.player.maybeTeam ?? null,
    },
    value: e.value,
    overallRank: e.overallRank,
    positionRank: e.positionRank,
    trend30Day: e.trend30Day,
  }));
}
