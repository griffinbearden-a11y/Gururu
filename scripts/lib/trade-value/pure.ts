// Pure, fs-free trade valuation and grading math (Part 3 of the brief).
// This file must never import node:fs (directly or transitively) — it gets
// bundled into the browser for Vail's Trade Tools' live grade panel and
// Trade Finder, in addition to being used server-side by the writer hook
// and the sanity-check script. config.ts and types.ts are also fs-free, so
// importing them here is safe.
import {
  CONSOLIDATION_FACTOR,
  CONTENDER_FIT,
  REBUILDER_FIT,
  YOUNG_PLAYER_MAX_AGE,
  FIT_MULTIPLIER_BOUNDS,
  FIT_MAX_GRADE_STEPS,
  MARKET_FLOOR_DELTA,
  MARKET_FLOOR_GRADE,
  MARKET_GRADE_CURVE,
  CLASS_STRENGTH_MULTIPLIER,
  FUTURE_PICK_DECAY,
} from './config.ts';
import type { Trade, TradeAsset } from './types.ts';

// ---------------------------------------------------------------------------
// Value cache shape (mirrors values.ts's TradeValueCache; duplicated here as
// a type-only contract so this file stays import-free of values.ts, which
// pulls in node:fs for its cache-building functions).
// ---------------------------------------------------------------------------
export interface PlayerValueEntry {
  sleeperId: string;
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  value: number;
}
export interface PickPriceEntry {
  value: number;
}
export interface TradeValueCache {
  players: Record<string, PlayerValueEntry>;
  exactPicks: Record<string, PickPriceEntry>; // key `${year}_${round}_${paddedSlot}`
  bucketedPicks: Record<string, PickPriceEntry>; // key `${year}_${round}_${bucket}`
  genericPicks: Record<string, PickPriceEntry>; // key `${year}_${round}`
}

export function getPlayerValue(cache: TradeValueCache, sleeperId: string): PlayerValueEntry | null {
  return cache.players[sleeperId] ?? null;
}

// ---------------------------------------------------------------------------
// Pick slotting (Part 2). ctx.finishOrder and ctx.nextDraftSeason are plain
// data computed server-side (from Sleeper standings) and either used
// directly at build time or serialized into the page for client-side reuse.
// ---------------------------------------------------------------------------
export type PickBucket = 'early' | 'mid' | 'late';

export interface PickValuationContext {
  nextDraftSeason: number;
  finishOrder: number[]; // roster_id, best team to worst
  cache: TradeValueCache;
}

function bucketForFinish(finishRank: number, teamCount: number): PickBucket {
  const third = teamCount / 3;
  if (finishRank <= third) return 'late'; // good teams draft late
  if (finishRank <= third * 2) return 'mid';
  return 'early';
}

export interface PickValueResult {
  value: number;
  basis: 'exact' | 'bucketed' | 'generic' | 'unpriced';
  label: string;
}

export function valuePick(ctx: PickValuationContext, season: string, round: number, originalRosterId: number): PickValueResult {
  const seasonNum = Number(season);
  const teamCount = ctx.finishOrder.length || 12;
  const yearsOut = seasonNum - ctx.nextDraftSeason;

  let value: number;
  let basis: PickValueResult['basis'];
  let label: string;

  if (yearsOut <= 0 && ctx.finishOrder.length) {
    const finishRank = ctx.finishOrder.indexOf(originalRosterId) + 1;
    const slot = teamCount - finishRank + 1;
    const slotKey = String(slot).padStart(2, '0');
    const entry = ctx.cache.exactPicks[`${season}_${round}_${slotKey}`];
    if (entry) {
      value = entry.value;
      basis = 'exact';
      label = `${season} Pick ${round}.${slotKey}`;
    } else {
      const g = ctx.cache.genericPicks[`${season}_${round}`];
      value = g?.value ?? 0;
      basis = g ? 'generic' : 'unpriced';
      label = `${season} round ${round} (slot unknown)`;
    }
  } else if (ctx.finishOrder.length) {
    const finishRank = ctx.finishOrder.indexOf(originalRosterId) + 1;
    const bucket = bucketForFinish(finishRank || Math.ceil(teamCount / 2), teamCount);
    const bucketed = ctx.cache.bucketedPicks[`${season}_${round}_${bucket}`];
    if (bucketed) {
      value = bucketed.value;
      basis = 'bucketed';
      label = `${season} round ${round} (${bucket})`;
    } else {
      const g = ctx.cache.genericPicks[`${season}_${round}`];
      value = g?.value ?? 0;
      basis = g ? 'generic' : 'unpriced';
      label = `${season} round ${round}`;
    }
  } else {
    const g = ctx.cache.genericPicks[`${season}_${round}`];
    value = g?.value ?? 0;
    basis = g ? 'generic' : 'unpriced';
    label = `${season} round ${round}`;
  }

  if (round === 1) value *= CLASS_STRENGTH_MULTIPLIER[season] ?? 1;
  if (yearsOut > 0) value *= Math.pow(FUTURE_PICK_DECAY, yearsOut);

  return { value, basis, label };
}

// ---------------------------------------------------------------------------
// Grading (Part 3): market axis, fit axis, guardrails, verdict.
// ---------------------------------------------------------------------------
const GRADE_ORDER = ['F', 'D', 'C', 'B', 'A'] as const;
type BaseGrade = (typeof GRADE_ORDER)[number];
const FINAL_GRADE_BLEND_WEIGHT_FIT = 0.5;

function baseGradeFromDelta(delta: number): BaseGrade {
  for (const band of MARKET_GRADE_CURVE) {
    if (delta >= band.min) return band.grade as BaseGrade;
  }
  return 'F';
}

function gradeModifier(delta: number, grade: BaseGrade): string {
  const bandWidth = 0.10;
  const bounds: Record<BaseGrade, number> = { A: 0.15, B: 0.06, C: -0.05, D: -0.15, F: -0.30 };
  const lo = bounds[grade];
  const pos = grade === 'F' ? (lo - delta) / bandWidth : (delta - lo) / bandWidth;
  if (grade === 'A') return pos > 0.66 ? '+' : '';
  if (grade === 'F') return '';
  if (pos < 0.33) return '-';
  if (pos > 0.66) return '+';
  return '';
}

export function displayGrade(delta: number): string {
  const base = baseGradeFromDelta(delta);
  return `${base}${gradeModifier(delta, base)}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export type AssetCategory = 'pick' | 'young' | 'veteran';

export function categorizePlayer(age: number | null | undefined): AssetCategory {
  if (age !== null && age !== undefined && age <= YOUNG_PLAYER_MAX_AGE) return 'young';
  return 'veteran';
}

export function fitMultiplier(category: AssetCategory, contentionScore: number): number {
  let m = 1;
  if (category === 'pick') {
    m =
      contentionScore >= 0
        ? lerp(1, CONTENDER_FIT.PICK_MULTIPLIER, contentionScore)
        : lerp(1, REBUILDER_FIT.PICK_MULTIPLIER, -contentionScore);
  } else if (category === 'young') {
    m = contentionScore >= 0 ? 1 : lerp(1, REBUILDER_FIT.YOUNG_MULTIPLIER, -contentionScore);
  } else {
    m =
      contentionScore >= 0
        ? lerp(1, CONTENDER_FIT.VETERAN_MULTIPLIER, contentionScore)
        : lerp(1, REBUILDER_FIT.VETERAN_MULTIPLIER, -contentionScore);
  }
  return clamp(m, FIT_MULTIPLIER_BOUNDS.min, FIT_MULTIPLIER_BOUNDS.max);
}

// Sum of a package's assets, sorted desc, weighted by CONSOLIDATION_FACTOR^i
// (0-indexed) — quantity gets discounted since taking back a pile of assets
// means cutting real players to fit a 17-man roster.
export function consolidatedValue(values: number[]): number {
  return values
    .slice()
    .sort((a, b) => b - a)
    .reduce((sum, v, i) => sum + v * Math.pow(CONSOLIDATION_FACTOR, i), 0);
}

export interface ResolvedAsset {
  label: string;
  marketValue: number;
  category: AssetCategory;
}
export type AssetResolver = (asset: TradeAsset) => ResolvedAsset;

export interface TeamContext {
  rosterId: number;
  teamName: string;
  contentionScore: number; // -1 (rebuilder) .. +1 (contender)
}

export interface TeamAssetLine {
  assetId: string;
  assetType: 'player' | 'pick';
  label: string;
  marketValue: number;
  fitValue: number;
}

export interface TeamGradeResult {
  rosterId: number;
  teamName: string;
  contentionScore: number;
  sent: TeamAssetLine[];
  received: TeamAssetLine[];
  market: { sentValue: number; receivedValue: number; delta: number; grade: string };
  fit: { sentValue: number; receivedValue: number; delta: number; grade: string };
  finalGrade: string;
}

export interface TradeGradeResult {
  teams: TeamGradeResult[];
  verdict: string;
  explanation: string;
}

function gradeStep(grade: BaseGrade): number {
  return GRADE_ORDER.indexOf(grade);
}

function finalGradeFor(marketDelta: number, blendedDelta: number): string {
  const marketBase = baseGradeFromDelta(marketDelta);
  const blendedBase = baseGradeFromDelta(blendedDelta);
  const marketIdx = gradeStep(marketBase);
  let blendedIdx = gradeStep(blendedBase);
  blendedIdx = clamp(blendedIdx, marketIdx - FIT_MAX_GRADE_STEPS, marketIdx + FIT_MAX_GRADE_STEPS);
  if (marketDelta < MARKET_FLOOR_DELTA) {
    blendedIdx = Math.min(blendedIdx, gradeStep(MARKET_FLOOR_GRADE as BaseGrade));
  }
  const finalBase = GRADE_ORDER[blendedIdx];
  return `${finalBase}${gradeModifier(blendedDelta, finalBase)}`;
}

export function gradeTrade(trade: Trade, resolveAsset: AssetResolver, teams: Record<number, TeamContext>): TradeGradeResult {
  const rosterIds = Array.from(new Set(trade.assets.flatMap((a) => [a.fromRosterId, a.toRosterId])));

  const teamResults: TeamGradeResult[] = rosterIds.map((rosterId) => {
    const teamCtx = teams[rosterId];
    const contentionScore = teamCtx?.contentionScore ?? 0;
    const teamName = teamCtx?.teamName ?? `Roster ${rosterId}`;

    const sentAssets = trade.assets.filter((a) => a.fromRosterId === rosterId);
    const receivedAssets = trade.assets.filter((a) => a.toRosterId === rosterId);

    const toLine = (asset: TradeAsset): TeamAssetLine => {
      const { marketValue, label, category } = resolveAsset(asset);
      const fitValue = marketValue * fitMultiplier(category, contentionScore);
      return { assetId: asset.assetId, assetType: asset.assetType, label, marketValue, fitValue };
    };

    const sent = sentAssets.map(toLine);
    const received = receivedAssets.map(toLine);

    const marketSent = consolidatedValue(sent.map((l) => l.marketValue));
    const marketReceived = consolidatedValue(received.map((l) => l.marketValue));
    const marketDelta = marketSent > 0 ? (marketReceived - marketSent) / marketSent : 0;

    const fitSent = consolidatedValue(sent.map((l) => l.fitValue));
    const fitReceived = consolidatedValue(received.map((l) => l.fitValue));
    const fitDelta = fitSent > 0 ? (fitReceived - fitSent) / fitSent : 0;

    const blendedDelta = (1 - FINAL_GRADE_BLEND_WEIGHT_FIT) * marketDelta + FINAL_GRADE_BLEND_WEIGHT_FIT * fitDelta;

    return {
      rosterId,
      teamName,
      contentionScore,
      sent,
      received,
      market: { sentValue: marketSent, receivedValue: marketReceived, delta: marketDelta, grade: displayGrade(marketDelta) },
      fit: { sentValue: fitSent, receivedValue: fitReceived, delta: fitDelta, grade: displayGrade(fitDelta) },
      finalGrade: finalGradeFor(marketDelta, blendedDelta),
    };
  });

  const { verdict, explanation } = buildVerdict(teamResults);
  return { teams: teamResults, verdict, explanation };
}

function buildVerdict(teams: TeamGradeResult[]): { verdict: string; explanation: string } {
  if (teams.length === 0) return { verdict: 'Fair swap', explanation: 'No assets routed yet.' };

  const fitDeltas = teams.map((t) => t.fit.delta);
  const allPositive = fitDeltas.every((d) => d > 0);
  const allFair = fitDeltas.every((d) => Math.abs(d) <= 0.05);
  const spread = Math.max(...fitDeltas) - Math.min(...fitDeltas);
  const anyFleeced = teams.some((t) => t.market.delta < MARKET_FLOOR_DELTA);

  const winner = teams.reduce((a, b) => (b.fit.delta > a.fit.delta ? b : a));
  const loser = teams.reduce((a, b) => (b.fit.delta < a.fit.delta ? b : a));

  const role = (t: TeamGradeResult) => (t.contentionScore >= 0 ? 'contender' : 'rebuilder');
  const stance = (t: TeamGradeResult) => (t.contentionScore >= 0 ? 'buying time to win now' : 'spending assets on future upside');

  if (allFair) {
    return {
      verdict: 'Fair swap',
      explanation: `Both sides land within a nickel of even value — neither team is meaningfully better or worse off.`,
    };
  }
  if (allPositive) {
    return {
      verdict: 'Win-win',
      explanation:
        role(winner) !== role(loser)
          ? `Both sides gain because ${winner.teamName} is ${stance(winner)} and ${loser.teamName} is ${stance(loser)}.`
          : `Both sides gain — each team walks away with assets that fit its timeline better than what it gave up.`,
    };
  }
  if (anyFleeced || spread > 0.30) {
    return {
      verdict: 'Lopsided',
      explanation: `${winner.teamName} comes out well ahead of ${loser.teamName} even after accounting for team fit — this isn't a case where a bad market trade is actually justified by need.`,
    };
  }
  return {
    verdict: `Tilted toward ${winner.teamName}`,
    explanation: `${winner.teamName} gets the better end once fit is factored in, though ${loser.teamName} isn't giving up value for nothing.`,
  };
}
