// Pulls public nflverse release CSVs (weekly player stats, snap counts,
// depth charts) so writers have real NFL context without a web search on
// every draft call. Refreshed weekly by cron, not per-request.
//
// nflverse's per-season file naming isn't reliable close to "now" — e.g.
// player_stats_2025.csv doesn't exist even well after that season ended,
// only the ~33MB combined player_stats.csv does. So player_stats is always
// pulled from the combined file and filtered client-side to the current and
// previous season. snap_counts and depth_charts do publish per-year files;
// depth_charts' per-year file is a full history of daily snapshots (~40MB),
// so it's filtered down to just the most recent snapshot before saving.
//
// Usage: tsx scripts/ingest-nflverse.ts

import { readJSON, writeJSON } from './lib/fsjson.ts';
import { mkdir, writeFile, stat } from 'node:fs/promises';

const OUT_DIR = 'data/nflverse';
const RELEASE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function fileAgeMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function urlExists(url: string): Promise<boolean> {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  return res.ok;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function writeCsv(destPath: string, text: string) {
  await mkdir(destPath.substring(0, destPath.lastIndexOf('/')), { recursive: true });
  await writeFile(destPath, text, 'utf-8');
}

// Minimal RFC4180-ish CSV line splitter (handles quoted fields with commas).
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

async function currentSeasonYear(): Promise<number> {
  const league = await readJSON<{ season?: string } | null>('data/cache/league.json', null);
  if (league?.season) return parseInt(league.season, 10);
  return new Date().getFullYear();
}

async function ingestPlayerStats(season: number) {
  const destCsv = `${OUT_DIR}/player_stats.csv`;
  const age = await fileAgeMs(destCsv);
  if (age !== null && age < MAX_AGE_MS) {
    console.log(`player_stats: ${Math.round(age / 3600000)}h old, skipping`);
    return;
  }
  const url = `${RELEASE_BASE}/player_stats/player_stats.csv`;
  console.log('player_stats: fetching combined file (~33MB)...');
  const text = await fetchText(url);
  const lines = text.split('\n');
  const header = lines[0];
  const seasonIdx = parseCsvLine(header).indexOf('season');

  // nflverse's combined file can lag behind the real-world current season by
  // a year or more (publication delay). Don't assume `season`/`season - 1`
  // exist — find whatever the two most recent seasons actually present are.
  let maxSeasonInFile = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const s = parseInt(parseCsvLine(lines[i])[seasonIdx], 10);
    if (s > maxSeasonInFile) maxSeasonInFile = s;
  }
  const seasonsToKeep = new Set([maxSeasonInFile, maxSeasonInFile - 1]);

  const keep = [header];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const s = parseInt(parseCsvLine(line)[seasonIdx], 10);
    if (seasonsToKeep.has(s)) keep.push(line);
  }
  await writeCsv(destCsv, keep.join('\n') + '\n');
  await writeJSON(`${OUT_DIR}/player_stats.meta.json`, {
    dataset: 'player_stats',
    source_url: url,
    league_season: season,
    reflects_seasons: Array.from(seasonsToKeep).sort(),
    note: maxSeasonInFile < season ? `nflverse lags the league's current season (${season}); most recent available is ${maxSeasonInFile}.` : null,
    fetched_at: new Date().toISOString(),
  });
  console.log(`player_stats: kept ${keep.length - 1} rows for seasons ${Array.from(seasonsToKeep).sort().join(', ')}`);
}

async function ingestSnapCounts(season: number) {
  const destCsv = `${OUT_DIR}/snap_counts.csv`;
  const age = await fileAgeMs(destCsv);
  if (age !== null && age < MAX_AGE_MS) {
    console.log(`snap_counts: ${Math.round(age / 3600000)}h old, skipping`);
    return;
  }
  let year = season;
  let url = `${RELEASE_BASE}/snap_counts/snap_counts_${year}.csv`;
  if (!(await urlExists(url))) {
    year = season - 1;
    url = `${RELEASE_BASE}/snap_counts/snap_counts_${year}.csv`;
    if (!(await urlExists(url))) {
      console.warn(`snap_counts: no file for ${season} or ${year}, skipping`);
      return;
    }
    console.log(`snap_counts: ${season} not yet published, using ${year}`);
  }
  const text = await fetchText(url);
  await writeCsv(destCsv, text);
  await writeJSON(`${OUT_DIR}/snap_counts.meta.json`, {
    dataset: 'snap_counts',
    source_url: url,
    reflects_season: year,
    fetched_at: new Date().toISOString(),
  });
  console.log(`snap_counts: fetched snap_counts_${year}.csv`);
}

async function ingestDepthCharts(season: number) {
  const destCsv = `${OUT_DIR}/depth_charts.csv`;
  const age = await fileAgeMs(destCsv);
  if (age !== null && age < MAX_AGE_MS) {
    console.log(`depth_charts: ${Math.round(age / 3600000)}h old, skipping`);
    return;
  }
  let year = season;
  let url = `${RELEASE_BASE}/depth_charts/depth_charts_${year}.csv`;
  if (!(await urlExists(url))) {
    year = season - 1;
    url = `${RELEASE_BASE}/depth_charts/depth_charts_${year}.csv`;
    if (!(await urlExists(url))) {
      console.warn(`depth_charts: no file for ${season} or ${year}, skipping`);
      return;
    }
    console.log(`depth_charts: ${season} not yet published, using ${year}`);
  }
  console.log('depth_charts: fetching per-year file (full daily-snapshot history) and keeping latest snapshot only...');
  const text = await fetchText(url);
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0];
  const dtIdx = parseCsvLine(header).indexOf('dt');
  let latestDt = '';
  for (let i = 1; i < lines.length; i++) {
    const dt = parseCsvLine(lines[i])[dtIdx];
    if (dt > latestDt) latestDt = dt;
  }
  const keep = [header, ...lines.slice(1).filter((line) => parseCsvLine(line)[dtIdx] === latestDt)];
  await writeCsv(destCsv, keep.join('\n') + '\n');
  await writeJSON(`${OUT_DIR}/depth_charts.meta.json`, {
    dataset: 'depth_charts',
    source_url: url,
    reflects_season: year,
    snapshot_dt: latestDt,
    fetched_at: new Date().toISOString(),
  });
  console.log(`depth_charts: kept ${keep.length - 1} rows from snapshot ${latestDt}`);
}

async function main() {
  const season = await currentSeasonYear();
  console.log(`Target season: ${season}`);
  await ingestPlayerStats(season);
  await ingestSnapCounts(season);
  await ingestDepthCharts(season);
  const { logRun } = await import('./lib/run-log.ts');
  await logRun('ingest-nflverse', 'success');
}

main().catch(async (err) => {
  console.error(err);
  const { logRun } = await import('./lib/run-log.ts');
  await logRun('ingest-nflverse', 'failure', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
