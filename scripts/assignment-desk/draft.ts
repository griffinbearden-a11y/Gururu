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

  const userMessage = `${contextBundle}${searchBlock}

# Your assignment
Write the article for this pitch. Use the web search results above for any real NFL player facts, depth chart notes, or recent performance you reference — every claim about a real NFL player must trace to provided context or a search result above, never invented.

When describing a trade, check the "X gets: ..." breakdown in the Recent Transactions section above carefully before writing who acquired whom — do not guess or reconstruct trade direction from memory of the players' names alone.

Headline: ${pitch.headline}
Thesis: ${pitch.thesis}
Format: ${pitch.format}
Subject teams (roster_ids): ${JSON.stringify(pitch.subject_teams)}
Why now: ${pitch.why_now}
${revisionBlock}

Write 500-900 words in your voice. Do not include frontmatter or a headline repeated as an H1 — just the body prose (markdown paragraphs, occasional blockquote or subheading if it fits your style).

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
