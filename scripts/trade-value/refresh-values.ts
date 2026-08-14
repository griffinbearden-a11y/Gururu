// Refreshes the FantasyCalc value cache. Cache once daily — call this from
// its own cron job, never from a page render. On fetch failure, leaves the
// last good cache in place rather than overwriting it with nothing.
//
// Usage: tsx scripts/trade-value/refresh-values.ts
//        FORCE_REFRESH=1 tsx scripts/trade-value/refresh-values.ts
import { stat } from 'node:fs/promises';
import { fetchFantasyCalcValues } from '../lib/trade-value/fantasycalc-client.ts';
import { buildValueCache, loadOverrides, VALUES_CACHE_PATH } from '../lib/trade-value/values.ts';
import { writeJSON } from '../lib/fsjson.ts';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function fileAgeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

async function main() {
  const age = await fileAgeMs(VALUES_CACHE_PATH);
  if (age !== null && age < MAX_AGE_MS && !process.env.FORCE_REFRESH) {
    console.log(`${VALUES_CACHE_PATH} is ${Math.round(age / 60000)}m old, skipping refetch`);
    return;
  }

  console.log('Fetching FantasyCalc values...');
  const [raw, overrides] = await Promise.all([fetchFantasyCalcValues(), loadOverrides()]);
  const cache = await buildValueCache(raw, overrides);
  await writeJSON(VALUES_CACHE_PATH, cache);
  console.log(
    `Cached ${cache.playerCount} players, ${Object.keys(cache.exactPicks).length} exact picks, ` +
      `${Object.keys(cache.bucketedPicks).length} bucketed picks, ${Object.keys(cache.genericPicks).length} generic picks.`
  );
  const { logRun } = await import('../lib/run-log.ts');
  await logRun('trade-value-refresh', 'success');
}

main().catch(async (err) => {
  console.error(err);
  console.error('Fetch failed — leaving existing cache in place.');
  const message = err instanceof Error ? err.message : String(err);
  const { logRun } = await import('../lib/run-log.ts');
  await logRun('trade-value-refresh', 'failure', message);
  process.exitCode = 1;
});
