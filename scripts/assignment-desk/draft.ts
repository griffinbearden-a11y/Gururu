// Step 3: Draft. Full context, plus a Tavily web search for real NFL facts
// (Gemini's own search grounding 429s on the free tier, so we search
// ourselves and hand the model plain-text results instead).
import { callClaude, parseJSON } from '../lib/llm.ts';
import { searchWeb } from '../lib/search.ts';
import { loadWriterPersona, buildContextBundle, type WriterId } from './context.ts';
import type { Pitch } from './pitch.ts';

export interface DraftPrediction {
  claim: string;
  subject: string;
  resolution_date: string;
}

export interface Draft {
  title: string;
  body_markdown: string;
  subject_player_names: string[];
  predictions: DraftPrediction[];
}

// Formats whose entire premise is enumerating every team or every matchup.
// Left to a generic "write 500-900 words" instruction, the model reliably
// writes a themed narrative that name-checks three or four teams and calls
// it done — technically on-topic, but not the thing the format promises.
const FULL_COVERAGE_FORMATS: Record<string, string> = {
  power_rankings:
    'This is a REAL ranked list, not a themed narrative. Rank all 12 teams 1 through 12, in order. Every team gets its own numbered entry with 2-4 sentences of reasoning specific to that team\'s roster. Do not skip any team, do not merge teams together, do not spend most of the word count on your favorites and wave at the rest.',
  tiers:
    'Every one of the 12 teams must be placed into a named tier — do not omit any team. List out which teams belong to which tier explicitly.',
  rookie_draft_grades:
    'Grade every team that made a rookie-draft pick (see the draft results in context) — an explicit letter grade plus 2-4 sentences of reasoning per team, covering that team\'s actual picks. Do not cover only 3-4 headline teams and skip the rest; every team with a pick gets a grade.',
  matchup_preview:
    'Preview EVERY matchup on the schedule for the relevant week (see the Schedule section in context), not just one or two marquee games. A 12-team league has 6 matchups each week — all 6 must appear, each with its own preview, even if some get less space than others.',
  matchup_recap:
    'Recap EVERY matchup for the relevant week (see the Schedule section in context), not just the highlights. A 12-team league has 6 matchups — all 6 must be mentioned, even if some get less space than others.',
  all_play_record:
    'Show all 12 teams\' all-play records, not a subset — this format is worthless without the full list.',
  luck_index:
    'Rank or list all 12 teams on the luck index, not a subset.',
  playoff_odds:
    'Give every one of the 12 teams a playoff-odds figure or explicit tier — do not omit any team.',
  faab_audit:
    'Cover every team\'s FAAB spending, not just the most notable one or two.',
  activity_index:
    'Rank all 12 teams by activity/transaction volume, not a subset.',
  points_left_on_bench:
    'Show the bench-points figure for all 12 teams, not a subset.',
};

export async function writeDraft(
  writerId: WriterId,
  pitch: Pitch,
  revisionNotes?: string[],
  contextBundleOverride?: string
): Promise<Draft> {
  const persona = loadWriterPersona(writerId);
  const contextBundle = contextBundleOverride ?? (await buildContextBundle(writerId));

  const revisionBlock = revisionNotes?.length
    ? `\n\n# Revision required\nA prior draft of this piece was sent back by the editor with these notes. Address them directly:\n${revisionNotes.map((n) => `- ${n}`).join('\n')}`
    : '';

  const searchResults = await searchWeb(`${pitch.headline} ${pitch.thesis} NFL 2026 fantasy football`);
  const searchBlock = searchResults
    ? `\n\n# Web search results\n${searchResults}`
    : '\n\n# Web search results\n(No search results available this run — do not invent specific real-world NFL facts beyond what appears in the context above.)';

  const coverageRequirement = FULL_COVERAGE_FORMATS[pitch.format];
  const structureBlock = coverageRequirement
    ? `\n\n# Structural requirement for this format\n${coverageRequirement}`
    : '';
  const wordCount = coverageRequirement ? '900-1600' : '500-900';

  const userMessage = `${contextBundle}${searchBlock}${structureBlock}

# Your assignment
Write the article for this pitch. Use the web search results above for any real NFL player facts, depth chart notes, or recent performance you reference — every claim about a real NFL player must trace to provided context or a search result above, never invented.

When describing a trade, check the "X gets: ..." breakdown in the Recent Transactions section above carefully before writing who acquired whom — do not guess or reconstruct trade direction from memory of the players' names alone.

Headline: ${pitch.headline}
Thesis: ${pitch.thesis}
Format: ${pitch.format}
Subject teams (roster_ids): ${JSON.stringify(pitch.subject_teams)}
Why now: ${pitch.why_now}
${revisionBlock}

Write ${wordCount} words in your voice. Do not include frontmatter or a headline repeated as an H1 — just the body prose (markdown paragraphs, occasional blockquote or subheading if it fits your style). If a structural requirement is given above, satisfy it in full even if it means the piece reads more like a real list/ledger than a flowing narrative — voice and personality belong in the reasoning for each entry, not in place of covering every entry.

Return ONLY a JSON object, no markdown fences, no commentary:
{
  "title": "final headline, can refine from the pitch",
  "body_markdown": "the full article body in markdown",
  "subject_player_names": ["full names of any real NFL players discussed"],
  "predictions": [{"claim": "any forward-looking claim you made", "subject": "team or player name", "resolution_date": "YYYY-MM-DD, your best estimate of when this can be checked"}]
}
If you made no forward-looking claims, "predictions" should be an empty array.`;

  const raw = await callClaude(userMessage, {
    system: persona.systemPrompt,
    maxTokens: 8192,
    effort: 'high',
  });

  return parseJSON<Draft>(raw);
}
