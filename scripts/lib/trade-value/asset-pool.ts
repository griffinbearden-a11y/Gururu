// Assembles the full tradeable-asset pool — every rostered player and every
// owned pick, for every team, pre-priced — for embedding into Vail's Trade
// Tools at build time. The page ships this flat array to the browser; the
// client never re-derives values, it only re-runs pure.ts's gradeTrade()
// against however the user has routed these pre-priced assets.
import { readJSON } from '../fsjson.ts';
import type { SleeperRoster } from '../sleeper.ts';
import { getPlayerValue, categorizePlayer, valuePick } from './pure.ts';
import type { TradeValueCache, PickValuationContext, AssetCategory } from './pure.ts';
import { computePickOwnership } from './picks.ts';

export interface PoolAsset {
  assetId: string;
  assetType: 'player' | 'pick';
  ownerRosterId: number;
  label: string;
  position: string | null;
  nflTeam: string | null;
  age: number | null;
  category: AssetCategory;
  marketValue: number;
}

interface PlayerRecord {
  full_name: string;
  position: string;
  team: string | null;
  age: number | null;
}

export async function buildAssetPool(cache: TradeValueCache, pickCtx: PickValuationContext | null): Promise<PoolAsset[]> {
  const [rosters, players] = await Promise.all([
    readJSON<SleeperRoster[]>('data/cache/rosters.json', []),
    readJSON<Record<string, PlayerRecord>>('data/cache/players.json', {}),
  ]);

  const pool: PoolAsset[] = [];

  for (const r of rosters) {
    for (const id of r.players ?? []) {
      if (Number.isNaN(Number(id))) continue; // team defenses ("GB", "MIN", ...) aren't in the value model
      const v = getPlayerValue(cache, id);
      const meta = players[id];
      const age = v?.age ?? meta?.age ?? null;
      pool.push({
        assetId: id,
        assetType: 'player',
        ownerRosterId: r.roster_id,
        label: v?.name ?? meta?.full_name ?? id,
        position: v?.position ?? meta?.position ?? null,
        nflTeam: v?.team ?? meta?.team ?? null,
        age,
        category: categorizePlayer(age),
        marketValue: v?.value ?? 0,
      });
    }
  }

  if (pickCtx) {
    const ownership = await computePickOwnership();
    for (const o of ownership) {
      const result = valuePick(pickCtx, o.season, o.round, o.originalRosterId);
      pool.push({
        assetId: `${o.season}_${o.round}_${o.originalRosterId}`,
        assetType: 'pick',
        ownerRosterId: o.ownerRosterId,
        label: result.label,
        position: null,
        nflTeam: null,
        age: null,
        category: 'pick',
        marketValue: result.value,
      });
    }
  }

  return pool;
}
