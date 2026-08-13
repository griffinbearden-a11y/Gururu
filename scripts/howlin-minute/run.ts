// The Howlin' Minute: a ~60-second audio rant from Wolf, generated on a
// fixed schedule (see .github/workflows/howlin-minute.yml) independent of
// his article rotation. Script text via Gemini, voice via ElevenLabs.
//
// Usage: tsx scripts/howlin-minute/run.ts
import { callClaude, parseJSON } from '../lib/llm.ts';
import { synthesizeSpeech } from '../lib/tts.ts';
import { loadWriterPersona, buildContextBundle, getTeamDirectory } from '../assignment-desk/context.ts';
import { critiqueDraft } from '../assignment-desk/critic.ts';
import type { Pitch } from '../assignment-desk/pitch.ts';
import type { Draft } from '../assignment-desk/draft.ts';
import { isPaused } from '../lib/circuit-breakers.ts';
import { weeklySpendCapExceeded } from '../lib/llm.ts';
import { readJSON, writeJSON } from '../lib/fsjson.ts';
import { logRun } from '../lib/run-log.ts';
import { sendNewPostEmail } from '../lib/mailchimp.ts';
import { SITE_URL } from '../lib/site.ts';

const MAX_REVISION_ATTEMPTS = 3;
const AUDIO_DIR = 'public/audio/howlin-minute';
const DATA_PATH = 'data/howlin_minute.json';
const HISTORY_LOOKBACK = 10; // how many past segments feed continuity + dedup context

export interface HowlinMinuteEntry {
  slug: string;
  date: string;
  title: string;
  script_text: string;
  audio_path: string;
  subject_teams: number[];
  come_up_player: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
}

async function hasPostedToday(): Promise<boolean> {
  const { entries } = await readJSON<{ entries: HowlinMinuteEntry[] }>(DATA_PATH, { entries: [] });
  const today = new Date().toISOString().slice(0, 10);
  return entries.some((e) => e.date.slice(0, 10) === today);
}

// Builds the continuity + equal-airtime + recurring-bit guidance block fed
// to every generation call. Recency/count tracking here is what makes
// "everyone gets equal airtime over time" and "don't repeat last week's
// Come-Up pick" actually enforceable instead of just a vibe in the prompt.
async function buildHowlinMinuteContext(): Promise<string> {
  const [{ entries: history }, teams] = await Promise.all([
    readJSON<{ entries: HowlinMinuteEntry[] }>(DATA_PATH, { entries: [] }),
    getTeamDirectory(),
  ]);

  const recent = [...history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const pastSegments = recent.slice(0, HISTORY_LOOKBACK).length
    ? recent
        .slice(0, HISTORY_LOOKBACK)
        .map((e) => `  [${e.date.slice(0, 10)}] "${e.title}" — ${e.script_text.slice(0, 140)}...`)
        .join('\n')
    : '  (none yet — this is the first segment)';

  const lastMentioned = new Map<number, string>();
  const mentionCount = new Map<number, number>();
  for (const e of recent) {
    for (const rid of e.subject_teams ?? []) {
      if (!lastMentioned.has(rid)) lastMentioned.set(rid, e.date);
      mentionCount.set(rid, (mentionCount.get(rid) ?? 0) + 1);
    }
  }
  const airtime = teams
    .map((t) => ({
      name: t.team_name,
      rosterId: t.roster_id,
      lastMentioned: lastMentioned.get(t.roster_id) ?? null,
      count: mentionCount.get(t.roster_id) ?? 0,
    }))
    .sort((a, b) => {
      if (!a.lastMentioned && !b.lastMentioned) return a.count - b.count;
      if (!a.lastMentioned) return -1;
      if (!b.lastMentioned) return 1;
      return new Date(a.lastMentioned).getTime() - new Date(b.lastMentioned).getTime();
    });
  const airtimeBlock = airtime
    .map((t) => `  ${t.rosterId}: ${t.name} — ${t.lastMentioned ? `last mentioned ${t.lastMentioned.slice(0, 10)}` : 'never mentioned'}, ${t.count}x total`)
    .join('\n');
  const underCovered = airtime.slice(0, 4).map((t) => t.name).join(', ');

  const recentComeUps = recent
    .slice(0, HISTORY_LOOKBACK)
    .map((e) => e.come_up_player)
    .filter(Boolean)
    .join(', ') || '(none yet)';

  return `# Past Howlin' Minute segments (for continuity — reference these when it fits, callbacks to your own prior rants are good)
${pastSegments}

# Team airtime tracker (every team needs to get covered over time, not every episode — but lean toward teams you haven't touched in a while when it fits naturally)
${airtimeBlock}
Most overdue for a mention: ${underCovered}

# Recent "Come-Up" picks — DO NOT repeat any of these players
${recentComeUps}`;
}

interface Script {
  title: string;
  thesis: string;
  script_text: string;
  subject_teams: number[];
  come_up_player: string;
}

async function writeScript(revisionNotes?: string[]): Promise<Script> {
  const persona = loadWriterPersona('wolf');
  const [contextBundle, howlinContext] = await Promise.all([buildContextBundle('wolf'), buildHowlinMinuteContext()]);

  const revisionBlock = revisionNotes?.length
    ? `\n\n# Revision required\nA prior draft was sent back with these notes. Address them directly:\n${revisionNotes.map((n) => `- ${n}`).join('\n')}`
    : '';

  const userMessage = `${contextBundle}

${howlinContext}

# Your assignment
This is "The Howlin' Minute" — a short spoken-word audio segment, roughly 60 seconds when read aloud (target 130-160 words). Rant about whatever's on your mind from the league right now: a trade, a team, your streak, your grudges — your call entirely, but use the continuity and airtime notes above: reference past segments where it's natural, and favor a team that's overdue for a mention if one fits the moment.

Do NOT make this segment's central thesis the same topic as one of your last 20 published articles above (same trade, same team storyline, same claim) — this includes your standing grudges and the streak, if you've already made a similar specific point about them recently in the ledger above. A brief callback line is fine and encouraged — "I already told you Tuesday..." — but the actual subject needs a specific claim you haven't already made in print. Your default fallback when nothing else is fresh: pick a team from the "most overdue for a mention" list above and say something new about THEM specifically — a roster you haven't weighed in on yet is always fresh territory, even if your general worldview (rosters vs. men, contempt for rebuilds, etc.) repeats.

Every episode ends with your recurring bit: a single "Come-Up" pick — one real NFL player you say is trending up, delivered as a flat, confident, completely absurd non-football reason (not scouting logic, not stats — a superstition, a vibe, a piece of nonsense you're dead serious about). Example energy: "Look out for David Montgomery, folks — he's been eating his cornbread." Pick a player who is not in the "do not repeat" list above, and who is realistically trending up or at least not injured/irrelevant right now. This bit is about the PLAYER, not about who owns him — do not claim any specific fantasy team's roster includes him, in this bit or anywhere else in the script, unless you've confirmed it against the league data above.

This is SPOKEN, not written. No markdown, no headers, no bullet points, no stage directions, no parenthetical asides. Just the words you'd actually say out loud, in your voice, ready to be read by a text-to-speech engine start to finish. The Come-Up bit should read as a natural button at the end of the rant, not a separate labeled section.

Every claim about a real NFL player or a real league trade (other than the joke reasoning in the Come-Up bit) must trace to the context above — do not invent facts, and double check trade direction (who actually got who) against the "X gets: ..." breakdown in Recent Transactions before you say it out loud.${revisionBlock}

Return ONLY a JSON object, no markdown fences, no commentary:
{
  "title": "a short title for this segment",
  "thesis": "one sentence summarizing what you're ranting about",
  "script_text": "the full spoken script, plain text, no formatting, ending with the Come-Up bit",
  "subject_teams": [roster_ids of any teams you actually talked about, empty array if none specific],
  "come_up_player": "full name of the real NFL player in your Come-Up bit"
}`;

  const raw = await callClaude(userMessage, {
    system: persona.systemPrompt,
    maxTokens: 8192,
    effort: 'high',
  });

  return parseJSON<Script>(raw);
}

// Structural checks the API critic pass doesn't cover: is the Come-Up player
// a real, resolvable player, and did the model actually avoid the do-not-
// repeat list. Cheap, no API call — catches these before burning a critic
// call on something regenerable in code.
async function validateStructure(script: Script): Promise<string[]> {
  const notes: string[] = [];
  const players = await readJSON<Record<string, { full_name: string }>>('data/cache/players.json', {});
  const nameLower = script.come_up_player?.trim().toLowerCase();
  const known = Object.values(players).some((p) => p.full_name?.toLowerCase() === nameLower);
  if (!nameLower) {
    notes.push('come_up_player is missing — every segment must end with a Come-Up pick.');
  } else if (!known) {
    notes.push(`"${script.come_up_player}" does not match any real player in the player database — use a real, currently-rostered-somewhere-in-the-NFL name.`);
  }

  const { entries: history } = await readJSON<{ entries: HowlinMinuteEntry[] }>(DATA_PATH, { entries: [] });
  const recentComeUps = new Set(
    [...history]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, HISTORY_LOOKBACK)
      .map((e) => e.come_up_player?.toLowerCase())
  );
  if (nameLower && recentComeUps.has(nameLower)) {
    notes.push(`"${script.come_up_player}" was already a Come-Up pick recently — choose someone new.`);
  }

  return notes;
}

type RunResult = { status: 'published' | 'skipped' } | { status: 'failed'; detail: string };

async function main(): Promise<RunResult> {
  const { paused, reason } = await isPaused();
  if (paused) {
    console.log(`System is paused: ${reason}. Skipping Howlin' Minute.`);
    return { status: 'skipped' };
  }
  if (await weeklySpendCapExceeded()) {
    console.log('Weekly API spend cap reached — skipping.');
    return { status: 'skipped' };
  }
  if (await hasPostedToday()) {
    console.log("Already posted a Howlin' Minute today — skipping.");
    return { status: 'skipped' };
  }

  const asPitch = (s: Script): Pitch => ({
    headline: s.title,
    thesis: s.thesis,
    format: 'howlin_minute',
    subject_teams: s.subject_teams ?? [],
    why_now: "Recurring Howlin' Minute segment",
  });
  const asDraft = (s: Script): Draft => ({
    title: s.title,
    body_markdown: s.script_text,
    subject_player_names: s.come_up_player ? [s.come_up_player] : [],
    predictions: [],
  });

  let script: Script;
  let verdict: { verdict: 'publish' | 'revise' | 'kill'; reasons: string[] };
  try {
    script = await writeScript();
    let attempts = 1;
    let structuralNotes = await validateStructure(script);
    verdict = structuralNotes.length
      ? { verdict: 'revise' as const, reasons: structuralNotes }
      : await critiqueDraft('wolf', asPitch(script), asDraft(script));

    while (verdict.verdict === 'revise' && attempts <= MAX_REVISION_ATTEMPTS) {
      script = await writeScript(verdict.reasons);
      structuralNotes = await validateStructure(script);
      verdict = structuralNotes.length
        ? { verdict: 'revise' as const, reasons: structuralNotes }
        : await critiqueDraft('wolf', asPitch(script), asDraft(script));
      attempts++;
    }
  } catch (err) {
    // A transient API failure (rate limit, truncation, etc.) should skip
    // today's segment, not crash the whole GitHub Actions job — but it
    // must still be logged as a failure, not silently reported as success.
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Howlin' Minute generation failed:", err);
    return { status: 'failed', detail };
  }

  if (verdict.verdict !== 'publish') {
    console.log(`Howlin' Minute killed or unresolved after revisions (${verdict.verdict}): ${verdict.reasons.join(' ')}`);
    return { status: 'skipped' };
  }

  const audio = await synthesizeSpeech(script.script_text);

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug = `${dateStr}-${slugify(script.title)}`;
  const audioPublicPath = `/audio/howlin-minute/${slug}.mp3`;

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(AUDIO_DIR, { recursive: true });
  await writeFile(`${AUDIO_DIR}/${slug}.mp3`, audio);

  const data = await readJSON<{ entries: HowlinMinuteEntry[] }>(DATA_PATH, { entries: [] });
  data.entries.push({
    slug,
    date: now.toISOString(),
    title: script.title,
    script_text: script.script_text,
    audio_path: audioPublicPath,
    subject_teams: script.subject_teams ?? [],
    come_up_player: script.come_up_player,
  });
  await writeJSON(DATA_PATH, data);

  console.log(`Published Howlin' Minute: ${slug}`);
  await sendNewPostEmail({
    subject: `New Howlin' Minute: ${script.title}`,
    html: `<p>${script.script_text.slice(0, 200)}...</p><p><a href="${SITE_URL}/howlin-minute/${slug}/">Listen</a></p>`,
  });
  return { status: 'published' };
}

main()
  .then((result) =>
    result.status === 'failed'
      ? logRun('howlin-minute', 'failure', result.detail)
      : logRun('howlin-minute', 'success')
  )
  .catch(async (err) => {
    console.error(err);
    await logRun('howlin-minute', 'failure', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
