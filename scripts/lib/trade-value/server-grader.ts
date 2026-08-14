// Server-side convenience wrapper around pure.ts's gradeTrade: builds an
// AssetResolver closure over a fs-backed value cache + pick context so
// callers (the sanity-check script, the writer hook) don't have to.
import type { Trade, TradeAsset } from './types.ts';
import type { TradeValueCache, PickValuationContext, ResolvedAsset, TradeGradeResult } from './pure.ts';
import { getPlayerValue, valuePick, categorizePlayer, gradeTrade as gradeTradePure } from './pure.ts';
import type { LeagueRosterContext } from './roster-context.ts';

function resolveAsset(asset: TradeAsset, cache: TradeValueCache, pickCtx: PickValuationContext | null): ResolvedAsset {
  if (asset.assetType === 'player') {
    const p = getPlayerValue(cache, asset.assetId);
    return { label: p?.name ?? asset.assetId, marketValue: p?.value ?? 0, category: categorizePlayer(p?.age ?? null) };
  }
  const [season, roundStr, originalRosterIdStr] = asset.assetId.split('_');
  const round = Number(roundStr);
  const originalRosterId = Number(originalRosterIdStr);
  if (!pickCtx) return { label: asset.assetId, marketValue: 0, category: 'pick' };
  const result = valuePick(pickCtx, season, round, originalRosterId);
  return { label: result.label, marketValue: result.value, category: 'pick' };
}

export function gradeTrade(
  trade: Trade,
  cache: TradeValueCache,
  pickCtx: PickValuationContext | null,
  rosterCtx: LeagueRosterContext
): TradeGradeResult {
  return gradeTradePure(trade, (asset) => resolveAsset(asset, cache, pickCtx), rosterCtx.teams);
}
