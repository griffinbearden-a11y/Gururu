// The Howlin' Minute: a ~60-second audio rant from Wolf, generated on a
// fixed schedule (see .github/workflows/howlin-minute.yml) independent of
// his article rotation. Script text via Gemini, voice via ElevenLabs.
//
// Usage: tsx scripts/howlin-minute/run.ts
import { callClaude, parseJSON } from '../lib/llm.ts';
import { synthesizeSpeech } from '../lib/tts.ts';
import { loadWriterPersona, buildContextBundle } from '../assignment-desk/context.ts';
import { critiqueDraft } from '../assignment-desk/critic.ts';
import type { Pitch } from '../assignment-desk/pitch.ts';
import type { Draft } from '../assignment-desk/draft.ts';
import { isPaused } from '../lib/circuit-breakers.ts';
import { weeklySpendCapExceeded } from '../lib/llm.ts';
import { readJSON, writeJSON } from '../lib/fsjson.ts';
import { logRun } from '../lib/run-log.ts';

const MAX_REVISION_ATTEMPTS = 2;
const AUDIO_DIR = 'public/audio/howlin-minute';
const DATA_PATH = 'data/howlin_minute.json';

export interface HowlinMinuteEntry {
  slug: string;
  date: string;
  title: string;
  script_text: string;
  audio_path: string; // public URL path, e.g. /audio/howlin-minute/2026-08-14-xyz.mp3
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

interface Script {
  title: string;
  thesis: string;
  script_text: string;
}

async function writeScript(revisionNotes?: string[]): Promise<Script> {
  const persona = loadWriterPersona('wolf');
  const contextBundle = await buildContextBundle('wolf');

  const revisionBlock = revisionNotes?.length
    ? `\n\n# Revision required\nA prior draft was sent back with these notes. Address them directly:\n${revisionNotes.map((n) => `- ${n}`).join('\n')}`
    : '';

  const userMessage = `${contextBundle}

# Your assignment
This is "The Howlin' Minute" — a short spoken-word audio segment, roughly 60 seconds when read aloud (target 130-160 words). Rant about whatever's on your mind from the league right now: a trade, a team, your streak, your grudges — your call entirely.

This is SPOKEN, not written. No markdown, no headers, no bullet points, no stage directions, no parenthetical asides. Just the words you'd actually say out loud, in your voice, ready to be read by a text-to-speech engine start to finish.

Every claim about a real NFL player or a real league trade must trace to the context above — do not invent facts, and double check trade direction (who actually got who) against the "X gets: ..." breakdown in Recent Transactions before you say it out loud.${revisionBlock}

Return ONLY a JSON object, no markdown fences, no commentary:
{
  "title": "a short title for this segment",
  "thesis": "one sentence summarizing what you're ranting about",
  "script_text": "the full spoken script, plain text, no formatting"
}`;

  const raw = await callClaude(userMessage, {
    system: persona.systemPrompt,
    maxTokens: 2048,
    effort: 'high',
  });

  return parseJSON<Script>(raw);
}

async function main() {
  const { paused, reason } = await isPaused();
  if (paused) {
    console.log(`System is paused: ${reason}. Skipping Howlin' Minute.`);
    return;
  }
  if (await weeklySpendCapExceeded()) {
    console.log('Weekly API spend cap reached — skipping.');
    return;
  }
  if (await hasPostedToday()) {
    console.log("Already posted a Howlin' Minute today — skipping.");
    return;
  }

  let script = await writeScript();

  const asPitch = (s: Script): Pitch => ({
    headline: s.title,
    thesis: s.thesis,
    format: 'howlin_minute',
    subject_teams: [],
    why_now: "Recurring Howlin' Minute segment",
  });
  const asDraft = (s: Script): Draft => ({
    title: s.title,
    body_markdown: s.script_text,
    subject_player_names: [],
    predictions: [],
  });

  let verdict = await critiqueDraft('wolf', asPitch(script), asDraft(script));
  let attempts = 1;
  while (verdict.verdict === 'revise' && attempts <= MAX_REVISION_ATTEMPTS) {
    script = await writeScript(verdict.reasons);
    verdict = await critiqueDraft('wolf', asPitch(script), asDraft(script));
    attempts++;
  }

  if (verdict.verdict !== 'publish') {
    console.log(`Howlin' Minute killed or unresolved after revisions (${verdict.verdict}): ${verdict.reasons.join(' ')}`);
    return;
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
  });
  await writeJSON(DATA_PATH, data);

  console.log(`Published Howlin' Minute: ${slug}`);
}

main()
  .then(() => logRun('howlin-minute', 'success'))
  .catch(async (err) => {
    console.error(err);
    await logRun('howlin-minute', 'failure', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
