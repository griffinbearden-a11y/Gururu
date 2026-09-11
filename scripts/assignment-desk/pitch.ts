// Step 1: Pitch. Cheap call — low effort, no web search. Five pitches back
// as JSON; the filter (code, not model) decides which survive.
import { callClaude, parseJSON } from '../lib/llm.ts';
import { readJSON } from '../lib/fsjson.ts';
import { getSeasonPhase } from '../lib/season.ts';
import { loadWriterPersona, buildContextBundle, type WriterId } from './context.ts';

export interface Pitch {
  headline: string;
  thesis: string;
  format: string;
  subject_teams: number[];
  why_now: string;
}

interface FormatDef {
  key: string;
  display_name: string;
  description: string;
  season_window: string;
  league_wide: boolean;
}

async function getLibraryFormats(): Promise<FormatDef[]> {
  const { formats } = await readJSON<{ formats: FormatDef[] }>('data/formats.json', { formats: [] });
  return formats;
}

const STALE_DAYS_THRESHOLD = 10;

// Left to itself, the pitch model gravitates to the same dramatic handful
// (trade reactions, rebuttals, hot takes) and lets whitelisted "service"
// formats (power rankings, matchup previews, playoff odds...) sit unused
// indefinitely even though they're in-window. Surfacing which formats are
// stale or never-published nudges coverage back toward the full beat.
async function getCoverageNote(formats: FormatDef[]): Promise<string> {
  const { entries } = await readJSON<{ entries: { format: string; date: string }[] }>('data/ledger.json', {
    entries: [],
  });
  const lastUsed = new Map<string, number>();
  for (const e of entries) {
    const t = new Date(e.date).getTime();
    if (!lastUsed.has(e.format) || t > lastUsed.get(e.format)!) lastUsed.set(e.format, t);
  }
  const now = Date.now();
  const lines = formats.map((f) => {
    const last = lastUsed.get(f.key);
    if (last === undefined) return `  ${f.key}: NEVER PUBLISHED`;
    const days = Math.floor((now - last) / 86_400_000);
    return days >= STALE_DAYS_THRESHOLD ? `  ${f.key}: stale, last used ${days}d ago` : null;
  });
  const flagged = lines.filter((l): l is string => l !== null);
  if (!flagged.length) return '';
  return `\n# Coverage gaps (formats from your whitelist that are overdue or untouched)\n${flagged.join('\n')}\nUnless something more newsworthy just happened, prefer covering one of these over repeating a format you've used recently.`;
}

export async function generatePitches(
  writerId: WriterId,
  opts: { wildcard: boolean; reactiveHint?: string }
): Promise<Pitch[]> {
  const persona = loadWriterPersona(writerId);
  const [contextBundle, allFormats, seasonPhase] = await Promise.all([
    buildContextBundle(writerId),
    getLibraryFormats(),
    getSeasonPhase(),
  ]);

  const whitelistFormats = allFormats.filter((f) => persona.formatWhitelist.includes(f.key));
  const inWindow = whitelistFormats.filter((f) => f.season_window === 'any' || f.season_window === seasonPhase);

  const formatMenu = inWindow
    .map((f) => `  ${f.key} — ${f.display_name} — ${f.description}${f.league_wide ? ' [league-wide, no subject_teams needed]' : ''}`)
    .join('\n');

  const coverageNote = opts.wildcard ? '' : await getCoverageNote(inWindow);

  const instructions = opts.reactiveHint
    ? `This is a REACTIVE assignment, off the transaction wire, outside your normal rotation: ${opts.reactiveHint}\nPitch 5 ideas that react to this specific transaction, using formats from your whitelist:\n${formatMenu}`
    : opts.wildcard
      ? `This is your WILDCARD slot. Pitch 5 ideas, and make at least the top one use a format that is NOT in your usual library — something genuinely new that fits your beat and voice. Give the new format a short snake_case key of its own.`
      : `Pitch 5 ideas using formats from your whitelist, currently in season (${seasonPhase}):\n${formatMenu}${coverageNote}`;

  const userMessage = `${contextBundle}

# Assignment
${instructions}

Return ONLY a JSON array of exactly 5 pitch objects, no markdown fences, no commentary. Each object:
{
  "headline": "string",
  "thesis": "one sentence, the actual claim you'd make",
  "format": "format key from your whitelist (snake_case)",
  "subject_teams": [roster_ids as integers, empty array if league-wide],
  "why_now": "one sentence on why this is timely"
}`;

  const raw = await callClaude(userMessage, {
    system: persona.systemPrompt,
    maxTokens: 4096,
    effort: 'low',
  });

  const pitches = parseJSON<Pitch[]>(raw);
  if (!Array.isArray(pitches) || pitches.length === 0) {
    throw new Error(`Pitch step returned no usable pitches for ${writerId}`);
  }
  return pitches;
}
