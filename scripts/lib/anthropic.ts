// Thin wrapper around the Anthropic SDK that tracks spend against the
// circuit breaker. Model: Claude Sonnet 5, per the build brief.
//
// Pricing is the standard post-intro rate ($3/$15 per MTok) rather than the
// $2/$10 introductory rate that runs through 2026-08-31 — safer to
// overestimate spend against the $5/week cap than underestimate it.
import Anthropic from '@anthropic-ai/sdk';
import { readJSON, writeJSON } from './fsjson.ts';

export const MODEL = 'claude-sonnet-5';

const PRICE_PER_MTOK = { input: 3.0, output: 15.0 };

const SPEND_LOG_PATH = 'data/cache/api_spend.json';
const WEEKLY_SPEND_CAP_USD = 5.0;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

interface SpendLog {
  weeks: Record<string, { spend_usd: number; calls: number }>;
}

function weekKey(date = new Date()): string {
  // ISO week-ish bucket: year + week number, good enough for a 7-day cap.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function getWeeklySpend(): Promise<number> {
  const log = await readJSON<SpendLog>(SPEND_LOG_PATH, { weeks: {} });
  return log.weeks[weekKey()]?.spend_usd ?? 0;
}

export async function weeklySpendCapExceeded(): Promise<boolean> {
  return (await getWeeklySpend()) >= WEEKLY_SPEND_CAP_USD;
}

async function recordSpend(inputTokens: number, outputTokens: number): Promise<void> {
  const cost = (inputTokens / 1_000_000) * PRICE_PER_MTOK.input + (outputTokens / 1_000_000) * PRICE_PER_MTOK.output;
  const log = await readJSON<SpendLog>(SPEND_LOG_PATH, { weeks: {} });
  const key = weekKey();
  const entry = log.weeks[key] ?? { spend_usd: 0, calls: 0 };
  entry.spend_usd += cost;
  entry.calls += 1;
  log.weeks[key] = entry;
  await writeJSON(SPEND_LOG_PATH, log);
}

export interface CallOptions {
  system: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  webSearch?: boolean;
}

// A single user-turn call, no conversation state. Returns the concatenated
// text content. Throws on API errors — callers decide how to count that
// against the pitch-failure circuit breaker.
export async function callClaude(userMessage: string, opts: CallOptions): Promise<string> {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens,
    system: opts.system,
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    ...(opts.webSearch ? { tools: [{ type: 'web_search_20260209', name: 'web_search' } as any] } : {}),
    messages: [{ role: 'user', content: userMessage }],
  });

  await recordSpend(response.usage.input_tokens, response.usage.output_tokens);

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n');
}

// Pitch/critic calls expect strict JSON back. Strips markdown code fences if
// the model wraps the JSON anyway, and throws on unparseable output so the
// caller can count it as a pitch-step failure.
export function parseJSON<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned) as T;
}
