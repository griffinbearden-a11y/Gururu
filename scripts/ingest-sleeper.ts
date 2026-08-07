// Pulls everything the site and the writers need from the Sleeper API and
// caches it to /data/cache as plain JSON. Safe to run every poll — cheap
// endpoints are refetched in full each time (git diff shows what changed),
// the ~5MB player map is refreshed at most once every 24h.
//
// Usage: SLEEPER_LEAGUE_ID=... tsx scripts/ingest-sleeper.ts

import { stat } from 'node:fs/promises';
import {
  getLeague,
  getUsers,
  getRosters,
  getMatchups,
  getTransactions,
  getTradedPicks,
  getDrafts,
  getDraftPicks,
  getWinnersBracket,
  getAllPlayersNFL,
  type SleeperLeague,
  type SleeperTransaction,
} from './lib/sleeper.ts';
import { writeJSON, readJSON } from './lib/fsjson.ts';

const CACHE_DIR = 'data/cache';
const WEEKS_TO_FETCH = 18;
const PLAYERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function fileAgeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

// Sleeper's raw player objects carry ~50 fields, most of them third-party ID
// crosswalks (sportradar, yahoo, kalshi, oddsjam...) nobody here reads. Keep
// only what writers and the site actually use, and drop anyone with no
// fantasy_positions (mascots, retired, non-skill roster fillers). Cuts the
// ~19MB raw dump to ~4MB, which matters since this file gets committed daily.
const PLAYER_FIELDS_TO_KEEP = [
  'player_id',
  'full_name',
  'first_name',
  'last_name',
  'position',
  'fantasy_positions',
  'team',
  'status',
  'injury_status',
  'age',
  'years_exp',
  'college',
  'number',
  'depth_chart_position',
  'depth_chart_order',
  'active',
] as const;

function trimPlayer(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PLAYER_FIELDS_TO_KEEP) out[field] = p[field] ?? null;
  return out;
}

async function ingestPlayersNFL() {
  const path = `${CACHE_DIR}/players.json`;
  const age = await fileAgeMs(path);
  if (age !== null && age < PLAYERS_MAX_AGE_MS) {
    console.log(`players.json is ${Math.round(age / 60000)}m old, skipping refetch`);
    return;
  }
  console.log('Fetching /players/nfl (~19MB raw, once daily)...');
  const players = await getAllPlayersNFL();
  const trimmed: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(players)) {
    const player = p as Record<string, unknown>;
    if (!player.fantasy_positions || (player.fantasy_positions as unknown[]).length === 0) continue;
    trimmed[id] = trimPlayer(player);
  }
  await writeJSON(path, trimmed);
  console.log(`Kept ${Object.keys(trimmed).length} fantasy-relevant players.`);
}

async function walkPreviousSeasons(currentLeague: SleeperLeague) {
  // The Sleeper API only sees leagues that exist there. This league has
  // exactly one prior season on record — walk previous_league_id until it
  // runs out and cache whatever we find. Anything older lives in league_lore.md.
  const history: { league_id: string; season: string; name: string }[] = [];
  let prevId = currentLeague.previous_league_id;
  let hops = 0;
  while (prevId && hops < 5) {
    const prev = await getLeague(prevId);
    history.push({ league_id: prev.league_id, season: prev.season, name: prev.name });
    const [prevUsers, prevRosters, prevBracket] = await Promise.all([
      getUsers(prevId),
      getRosters(prevId),
      getWinnersBracket(prevId).catch(() => []),
    ]);
    await writeJSON(`${CACHE_DIR}/previous_seasons/${prev.season}/league.json`, prev);
    await writeJSON(`${CACHE_DIR}/previous_seasons/${prev.season}/users.json`, prevUsers);
    await writeJSON(`${CACHE_DIR}/previous_seasons/${prev.season}/rosters.json`, prevRosters);
    await writeJSON(`${CACHE_DIR}/previous_seasons/${prev.season}/winners_bracket.json`, prevBracket);
    prevId = prev.previous_league_id;
    hops += 1;
  }
  await writeJSON(`${CACHE_DIR}/season_history.json`, { history });
  return history;
}

function buildCommissionerLedger(
  allTransactions: SleeperTransaction[],
  teamByRosterId: Map<number, { team_name: string; owner: string }>
) {
  const commissionerTxs = allTransactions.filter((tx) => tx.type === 'commissioner');
  const entries = commissionerTxs
    .map((tx) => {
      const teams = tx.roster_ids.map((rid) => teamByRosterId.get(rid)?.team_name ?? `Roster ${rid}`);
      const addedPlayers = tx.adds ? Object.keys(tx.adds) : [];
      const droppedPlayers = tx.drops ? Object.keys(tx.drops) : [];
      return {
        transaction_id: tx.transaction_id,
        date: new Date(tx.status_updated).toISOString(),
        type: tx.type,
        status: tx.status,
        teams_affected: teams,
        added_player_ids: addedPlayers,
        dropped_player_ids: droppedPlayers,
        is_override: true,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return entries;
}

async function main() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID;
  if (!leagueId) throw new Error('SLEEPER_LEAGUE_ID is not set');

  console.log(`Ingesting league ${leagueId}...`);

  const league = await getLeague(leagueId);
  const [users, rosters, tradedPicks, drafts, winnersBracket] = await Promise.all([
    getUsers(leagueId),
    getRosters(leagueId),
    getTradedPicks(leagueId),
    getDrafts(leagueId),
    getWinnersBracket(leagueId).catch(() => []),
  ]);

  await writeJSON(`${CACHE_DIR}/league.json`, league);
  await writeJSON(`${CACHE_DIR}/users.json`, users);
  await writeJSON(`${CACHE_DIR}/rosters.json`, rosters);
  await writeJSON(`${CACHE_DIR}/traded_picks.json`, tradedPicks);
  await writeJSON(`${CACHE_DIR}/drafts.json`, drafts);
  await writeJSON(`${CACHE_DIR}/winners_bracket.json`, winnersBracket);

  for (const draft of drafts) {
    const picks = await getDraftPicks(draft.draft_id);
    await writeJSON(`${CACHE_DIR}/draft_picks/${draft.draft_id}.json`, picks);
  }

  const { overrides: teamNameOverrides } = await readJSON<{ overrides: Record<string, string> }>(
    'data/team_name_overrides.json',
    { overrides: {} }
  );
  const userByUserId = new Map(users.map((u) => [u.user_id, u]));
  const teamByRosterId = new Map(
    rosters.map((r) => {
      const user = userByUserId.get(r.owner_id);
      const username = user?.display_name ?? 'unknown';
      return [
        r.roster_id,
        {
          roster_id: r.roster_id,
          owner_id: r.owner_id,
          owner_username: username,
          team_name:
            user?.metadata?.team_name?.trim() || teamNameOverrides[username] || username || `Roster ${r.roster_id}`,
          wins: r.settings.wins,
          losses: r.settings.losses,
          ties: r.settings.ties,
          points_for: (r.settings.fpts ?? 0) + (r.settings.fpts_decimal ?? 0) / 100,
          points_against: (r.settings.fpts_against ?? 0) + (r.settings.fpts_against_decimal ?? 0) / 100,
          division: r.settings.division ?? null,
        },
      ];
    })
  );
  await writeJSON(`${CACHE_DIR}/team_directory.json`, { teams: Array.from(teamByRosterId.values()) });

  const allTransactions: SleeperTransaction[] = [];
  for (let week = 1; week <= WEEKS_TO_FETCH; week++) {
    const [matchups, transactions] = await Promise.all([
      getMatchups(leagueId, week).catch(() => []),
      getTransactions(leagueId, week).catch(() => []),
    ]);
    if (matchups.length) await writeJSON(`${CACHE_DIR}/matchups/week_${week}.json`, matchups);
    if (transactions.length) {
      await writeJSON(`${CACHE_DIR}/transactions/week_${week}.json`, transactions);
      allTransactions.push(...transactions);
    }
  }

  const commissionerLedger = buildCommissionerLedger(
    allTransactions,
    new Map(Array.from(teamByRosterId.entries()).map(([id, t]) => [id, { team_name: t.team_name, owner: t.owner_username }]))
  );
  await writeJSON('data/commissioner_ledger.json', {
    _comment:
      'Auto-populated from Sleeper transactions where type === "commissioner". Never written by a model. Rebuilt in full on every ingest run.',
    entries: commissionerLedger,
  });

  await walkPreviousSeasons(league);
  await ingestPlayersNFL();

  console.log(`Done. ${allTransactions.length} transactions across ${WEEKS_TO_FETCH} weeks, ${commissionerLedger.length} commissioner actions.`);
  const { logRun } = await import('./lib/run-log.ts');
  await logRun('ingest-sleeper', 'success');
}

main().catch(async (err) => {
  console.error(err);
  const [{ pauseSystem }, { logRun }] = await Promise.all([
    import('./lib/circuit-breakers.ts'),
    import('./lib/run-log.ts'),
  ]);
  const message = err instanceof Error ? err.message : String(err);
  await logRun('ingest-sleeper', 'failure', message);
  await pauseSystem(`Sleeper ingestion failed: ${message}`);
  process.exitCode = 1;
});
