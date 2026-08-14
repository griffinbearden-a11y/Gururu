// Sanity-check script for Parts 1-3 (value layer, pick valuation, grading
// engine) — per the build order, UI does not get built until this output
// has been reviewed against what actually happened in the league.
//
// Pulls every real 'trade' transaction out of data/cache/transactions/,
// converts it to our flat asset-list Trade model, and prints market delta,
// fit delta, both grades, the verdict line, and the per-asset values that
// produced them for each team in the deal.
//
// Usage: tsx scripts/trade-value/test-grader.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fetchFantasyCalcValues } from '../lib/trade-value/fantasycalc-client.ts';
import { buildValueCache, getValueCache, loadOverrides, VALUES_CACHE_PATH } from '../lib/trade-value/values.ts';
import { writeJSON, readJSON } from '../lib/fsjson.ts';
import { buildPickValuationContext } from '../lib/trade-value/picks.ts';
import { buildLeagueRosterContext } from '../lib/trade-value/roster-context.ts';
import { gradeTrade } from '../lib/trade-value/server-grader.ts';
import type { Trade, TradeAsset } from '../lib/trade-value/types.ts';

interface RawTrade {
  transaction_id: string;
  status: string;
  type: string;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: { season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }[];
}

async function ensureValueCache() {
  let cache = await getValueCache();
  if (cache.playerCount > 0) return cache;
  console.log('No cached values found — fetching FantasyCalc now...');
  const [raw, overrides] = await Promise.all([fetchFantasyCalcValues(), loadOverrides()]);
  cache = await buildValueCache(raw, overrides);
  await writeJSON(VALUES_CACHE_PATH, cache);
  return cache;
}

function loadRealTrades(): RawTrade[] {
  const dir = 'data/cache/transactions';
  if (!existsSync(dir)) return [];
  const all: RawTrade[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const txs = JSON.parse(readFileSync(`${dir}/${file}`, 'utf-8')) as RawTrade[];
    all.push(...txs.filter((t) => t.type === 'trade' && t.status === 'complete'));
  }
  all.sort((a, b) => a.status_updated - b.status_updated);
  return all;
}

function toTrade(raw: RawTrade): { trade: Trade; playerAssetIds: string[] } {
  const assets: TradeAsset[] = [];
  const playerAssetIds: string[] = [];

  if (raw.adds && raw.drops) {
    for (const [playerId, toRosterId] of Object.entries(raw.adds)) {
      const fromRosterId = raw.drops[playerId];
      if (fromRosterId === undefined) continue; // e.g. straight FAAB entries — not a player asset
      assets.push({ assetId: playerId, assetType: 'player', fromRosterId, toRosterId });
      playerAssetIds.push(playerId);
    }
  }
  for (const pick of raw.draft_picks ?? []) {
    assets.push({
      assetId: `${pick.season}_${pick.round}_${pick.roster_id}`,
      assetType: 'pick',
      fromRosterId: pick.previous_owner_id,
      toRosterId: pick.owner_id,
    });
  }
  return { trade: { assets }, playerAssetIds };
}

function fmt(n: number): string {
  return n.toFixed(0);
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

function printTradeResult(
  heading: string,
  trade: Trade,
  cache: Awaited<ReturnType<typeof ensureValueCache>>,
  pickCtx: Awaited<ReturnType<typeof buildPickValuationContext>>,
  rosterCtx: Awaited<ReturnType<typeof buildLeagueRosterContext>>,
  players: Record<string, { full_name: string }>
) {
  console.log(`\n${heading}`);

  const result = gradeTrade(trade, cache, pickCtx, rosterCtx);

  for (const team of result.teams) {
    console.log(`\n  ${team.teamName}  [contention score: ${team.contentionScore.toFixed(2)}]`);
    console.log(
      `    Sends:    ${team.sent
        .map((l) => `${players[l.assetId]?.full_name ?? l.label} (market ${fmt(l.marketValue)}, fit ${fmt(l.fitValue)})`)
        .join('; ') || '(nothing)'}`
    );
    console.log(
      `    Receives: ${team.received
        .map((l) => `${players[l.assetId]?.full_name ?? l.label} (market ${fmt(l.marketValue)}, fit ${fmt(l.fitValue)})`)
        .join('; ') || '(nothing)'}`
    );
    console.log(
      `    Market: sent ${fmt(team.market.sentValue)} / received ${fmt(team.market.receivedValue)} / delta ${fmtPct(
        team.market.delta
      )} -> ${team.market.grade}`
    );
    console.log(
      `    Fit:    sent ${fmt(team.fit.sentValue)} / received ${fmt(team.fit.receivedValue)} / delta ${fmtPct(
        team.fit.delta
      )} -> ${team.fit.grade}`
    );
    console.log(`    Final grade: ${team.finalGrade}`);
  }

  console.log(`\n  Verdict: ${result.verdict}`);
  console.log(`  ${result.explanation}`);
  console.log('\n' + '='.repeat(100));
}

// Real league history (9 completed trades) doesn't include a pure
// picks-only deal, so this one is invented to exercise that path: a
// win-now team (Buckhead Beavers, roster 7) packages two future firsts to
// jump up for a rebuilding team's (JUICE, roster 9) immediate first-rounder.
// Uses real rosters/contention scores — only the trade itself is made up.
const HYPOTHETICALS: { heading: string; trade: Trade }[] = [
  {
    heading: 'HYPOTHETICAL (picks-only): Buckhead Beavers trade up, sending two future 1sts for a current 1st',
    trade: {
      assets: [
        { assetId: '2027_1_7', assetType: 'pick', fromRosterId: 7, toRosterId: 9 },
        { assetId: '2028_1_7', assetType: 'pick', fromRosterId: 7, toRosterId: 9 },
        { assetId: '2026_1_9', assetType: 'pick', fromRosterId: 9, toRosterId: 7 },
      ],
    },
  },
];

async function main() {
  const cache = await ensureValueCache();
  const pickCtx = await buildPickValuationContext(cache);
  const rosterCtx = await buildLeagueRosterContext(cache);
  const players = await readJSON<Record<string, { full_name: string }>>('data/cache/players.json', {});

  const rawTrades = loadRealTrades();
  console.log(`\nFound ${rawTrades.length} completed real trades in league history.\n`);
  console.log('='.repeat(100));

  for (const raw of rawTrades) {
    const { trade } = toTrade(raw);
    const date = new Date(raw.status_updated).toISOString().slice(0, 10);
    printTradeResult(`Trade ${raw.transaction_id}  (${date})`, trade, cache, pickCtx, rosterCtx, players);
  }

  console.log(`\n${HYPOTHETICALS.length} hypothetical trade(s) — not from real league history:\n`);
  for (const { heading, trade } of HYPOTHETICALS) {
    printTradeResult(heading, trade, cache, pickCtx, rosterCtx, players);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
