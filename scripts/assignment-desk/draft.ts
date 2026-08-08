// Step 3: Draft. Full context, web search enabled for real NFL facts.
import { callClaude, parseJSON } from '../lib/llm.ts';
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

  const userMessage = `${contextBundle}

# Your assignment
Write the article for this pitch. Use web search for any real NFL player facts, depth chart notes, or recent performance you reference — every claim about a real NFL player must trace to provided context or a search result, never invented.

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
    maxTokens: 4096,
    effort: 'high',
    webSearch: true,
  });

  return parseJSON<Draft>(raw);
}
