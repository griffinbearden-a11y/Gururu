// The assignment desk. Invoked on a cron by GitHub Actions. Walks today's
// rotation slots plus any un-reacted-to transactions, and for each: pitch ->
// filter -> draft -> critic -> commit, respecting every circuit breaker.
//
// Usage: tsx scripts/assignment-desk/run.ts
import { generatePitches, type Pitch } from './pitch.ts';
import { filterPitches } from './filter.ts';
import { writeDraft, type Draft } from './draft.ts';
import { critiqueDraft } from './critic.ts';
import { commitArticle, logSpiked } from './commit.ts';
import { getScheduledSlotsForToday, getReactiveAssignments } from './rotation.ts';
import type { WriterId } from './context.ts';
import {
  isPaused,
  dailyLimitReached,
  recordPublish,
  recordPitchFailure,
  recordPitchSuccess,
  markReacted,
} from '../lib/circuit-breakers.ts';
import { weeklySpendCapExceeded } from '../lib/anthropic.ts';
import { logRun } from '../lib/run-log.ts';

const MAX_REVISION_ATTEMPTS = 2;

// The workflow polls every 90 minutes (tighter on Sunday/Tuesday windows),
// but a rotation slot only needs to fill once a day. Without this guard,
// every poll after the first would re-pitch a slot that's already filled,
// burning API spend on pitches that go nowhere.
async function hasPublishedToday(writerId: WriterId): Promise<boolean> {
  const { readJSON } = await import('../lib/fsjson.ts');
  const { entries } = await readJSON<{ entries: { writer: WriterId; date: string }[] }>('data/ledger.json', { entries: [] });
  const today = new Date().toISOString().slice(0, 10);
  return entries.some((e) => e.writer === writerId && e.date.slice(0, 10) === today);
}

async function draftAndReview(writerId: WriterId, pitch: Pitch): Promise<Draft | null> {
  let draft = await writeDraft(writerId, pitch);
  let verdict = await critiqueDraft(writerId, pitch, draft);
  let attempts = 1;

  while (verdict.verdict === 'revise' && attempts <= MAX_REVISION_ATTEMPTS) {
    draft = await writeDraft(writerId, pitch, verdict.reasons);
    verdict = await critiqueDraft(writerId, pitch, draft);
    attempts++;
  }

  if (verdict.verdict === 'publish') return draft;

  await logSpiked(writerId, pitch, 'critic', {
    reason_code: verdict.verdict === 'kill' ? 'kill' : 'unresolved_after_revisions',
    reason_detail: verdict.reasons.join(' ') || '(no reasons given)',
  });
  return null;
}

async function processAssignment(
  writerId: WriterId,
  opts: { isWildcard: boolean; reactiveHint?: string }
): Promise<boolean> {
  if (await dailyLimitReached()) {
    console.log('Daily article cap reached — skipping remaining assignments.');
    return false;
  }
  if (await weeklySpendCapExceeded()) {
    console.log('Weekly API spend cap reached — skipping remaining assignments.');
    return false;
  }
  const { paused, reason } = await isPaused();
  if (paused) {
    console.log(`System paused (${reason}) — skipping.`);
    return false;
  }

  let pitches: Pitch[];
  try {
    pitches = await generatePitches(writerId, { wildcard: opts.isWildcard, reactiveHint: opts.reactiveHint });
    await recordPitchSuccess();
  } catch (err) {
    console.error(`Pitch step failed for ${writerId}:`, err);
    await recordPitchFailure();
    return false;
  }

  const { survivors, rejections } = await filterPitches(pitches, writerId, {
    isWildcardSlot: opts.isWildcard,
    isReactive: Boolean(opts.reactiveHint),
  });
  for (const r of rejections) await logSpiked(writerId, r.pitch, 'filter', r.rejection);

  if (survivors.length === 0) {
    console.log(`All pitches filtered out for ${writerId} — no slot filled today.`);
    return false;
  }

  for (const pitch of survivors) {
    const draft = await draftAndReview(writerId, pitch);
    if (draft) {
      const result = await commitArticle(writerId, pitch, draft);
      await recordPublish();
      console.log(`Published ${writerId}: ${result.slug}`);
      return true;
    }
    // Killed or unresolved after revisions — fall back to the next
    // surviving (already filter-approved) pitch rather than retry this one.
  }

  console.log(`Every surviving pitch for ${writerId} was killed or unresolved — slot skipped. A missed article beats a bad one.`);
  return false;
}

async function main() {
  const { paused, reason } = await isPaused();
  if (paused) {
    console.log(`System is paused: ${reason}. Nothing will run. Fix the underlying issue and flip the admin toggle.`);
    return;
  }

  const slots = await getScheduledSlotsForToday();
  console.log(`Rotation slots today: ${slots.map((s) => `${s.writer}${s.isWildcard ? ' (wildcard)' : ''}`).join(', ') || '(none)'}`);

  for (const slot of slots) {
    if (await hasPublishedToday(slot.writer)) {
      console.log(`${slot.writer} already published today — rotation slot already filled, skipping re-pitch.`);
      continue;
    }
    await processAssignment(slot.writer, { isWildcard: slot.isWildcard });
  }

  const reactive = await getReactiveAssignments();
  if (reactive.length) console.log(`Reactive assignments: ${reactive.length}`);
  for (const r of reactive) {
    if (await dailyLimitReached()) break;
    const published = await processAssignment(r.writer, { isWildcard: false, reactiveHint: r.description });
    if (published) await markReacted(r.transactionId);
  }
}

main()
  .then(() => logRun('assignment-desk', 'success'))
  .catch(async (err) => {
    console.error(err);
    await logRun('assignment-desk', 'failure', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
