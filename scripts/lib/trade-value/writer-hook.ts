// Clean interface into the grading engine for the writer pipeline (Part 7).
// Turns a real completed Sleeper trade into the two-axis grades and a
// verdict sentence. Doesn't touch the assignment desk itself — just a
// plain async function it (or Howlin' Minute) can call.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { SleeperTransaction } from '../sleeper.ts';
import { getValueCache } from './values.ts';
import { buildPickValuationContext } from './picks.ts';
import { buildLeagueRosterContext } from './roster-context.ts';
import { gradeTrade } from './server-grader.ts';
import type { Trade, TradeAsset } from './types.ts';

export interface WriterTradeGrade {
  transactionId: string;
  teams: { teamName: string; rosterId: number; marketGrade: string; fitGrade: string; finalGrade: string }[];
  verdict: string;
  explanation: string;
}

interface RawDraftPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
}

function transactionToTrade(tx: SleeperTransaction): Trade {
  const assets: TradeAsset[] = [];
  if (tx.adds && tx.drops) {
    for (const [playerId, toRosterId] of Object.entries(tx.adds)) {
      const fromRosterId = tx.drops[playerId];
      if (fromRosterId === undefined) continue;
      assets.push({ assetId: playerId, assetType: 'player', fromRosterId, toRosterId });
    }
  }
  for (const pick of (tx.draft_picks ?? []) as unknown as RawDraftPick[]) {
    assets.push({
      assetId: `${pick.season}_${pick.round}_${pick.roster_id}`,
      assetType: 'pick',
      fromRosterId: pick.previous_owner_id,
      toRosterId: pick.owner_id,
    });
  }
  return { assets };
}

export async function gradeSleeperTrade(tx: SleeperTransaction): Promise<WriterTradeGrade | null> {
  if (tx.type !== 'trade' || tx.status !== 'complete') return null;
  const cache = await getValueCache();
  if (cache.playerCount === 0) return null; // no value data cached yet — degrade to no-op

  const trade = transactionToTrade(tx);
  if (trade.assets.length === 0) return null;

  const [pickCtx, rosterCtx] = await Promise.all([buildPickValuationContext(cache), buildLeagueRosterContext(cache)]);
  const result = gradeTrade(trade, cache, pickCtx, rosterCtx);

  return {
    transactionId: tx.transaction_id,
    teams: result.teams.map((t) => ({
      teamName: t.teamName,
      rosterId: t.rosterId,
      marketGrade: t.market.grade,
      fitGrade: t.fit.grade,
      finalGrade: t.finalGrade,
    })),
    verdict: result.verdict,
    explanation: result.explanation,
  };
}

// The N most recent completed trades, graded — for feeding straight into a
// writer's context bundle (see assignment-desk/context.ts).
export async function getRecentTradeGrades(limit = 5): Promise<WriterTradeGrade[]> {
  const dir = 'data/cache/transactions';
  if (!existsSync(dir)) return [];
  const all: SleeperTransaction[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const txs = JSON.parse(readFileSync(`${dir}/${file}`, 'utf-8')) as SleeperTransaction[];
    all.push(...txs.filter((t) => t.type === 'trade' && t.status === 'complete'));
  }
  all.sort((a, b) => b.status_updated - a.status_updated);

  const grades: WriterTradeGrade[] = [];
  for (const tx of all.slice(0, limit)) {
    const graded = await gradeSleeperTrade(tx);
    if (graded) grades.push(graded);
  }
  return grades;
}

// Compact one-line-per-team summary — e.g. for handing letter grades
// straight to the Howlin' Wolf.
export function formatGradesForWriter(grade: WriterTradeGrade): string {
  const lines = grade.teams.map((t) => `  ${t.teamName}: ${t.finalGrade} (market ${t.marketGrade}, fit ${t.fitGrade})`);
  return [`Trade ${grade.transactionId} — ${grade.verdict}`, `  ${grade.explanation}`, ...lines].join('\n');
}
