// Thin wrapper around the Gemini API that tracks usage against the circuit
// breaker. Model: Gemini 2.5 Flash, which has a no-cost free tier (rate
// limited, not a spend-capped paid plan) — see
// https://ai.google.dev/gemini-api/docs/pricing for current limits.
import { GoogleGenAI } from '@google/genai';
import { readJSON, writeJSON } from './fsjson.ts';

export const MODEL = 'gemini-2.5-flash';

const SPEND_LOG_PATH = 'data/cache/api_spend.json';
// Free tier: $0/token, so this cap is a no-op unless you switch to a paid
// Gemini model — kept around so callers that check it don't need changes.
const WEEKLY_SPEND_CAP_USD = 5.0;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

// Free tier has no per-token cost, so this just tallies call counts for
// visibility in the health email — spend_usd stays 0.
async function recordSpend(calls = 1): Promise<void> {
  const log = await readJSON<SpendLog>(SPEND_LOG_PATH, { weeks: {} });
  const key = weekKey();
  const entry = log.weeks[key] ?? { spend_usd: 0, calls: 0 };
  entry.calls += calls;
  log.weeks[key] = entry;
  await writeJSON(SPEND_LOG_PATH, log);
}

export interface CallOptions {
  system: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  webSearch?: boolean;
}

// Maps Claude-style "effort" to Gemini's thinking token budget. 0 disables
// thinking entirely (fastest/cheapest); higher tiers get more budget.
const THINKING_BUDGET: Record<NonNullable<CallOptions['effort']>, number> = {
  low: 0,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 24576,
};

// A single user-turn call, no conversation state. Returns the concatenated
// text content. Throws on API errors — callers decide how to count that
// against the pitch-failure circuit breaker.
export async function callClaude(userMessage: string, opts: CallOptions): Promise<string> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: userMessage,
    config: {
      systemInstruction: opts.system,
      maxOutputTokens: opts.maxTokens,
      ...(opts.effort ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET[opts.effort] } } : {}),
      ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    },
  });

  await recordSpend();

  return response.text ?? '';
}

// Pitch/critic calls expect strict JSON back. Strips markdown code fences if
// the model wraps the JSON anyway, and throws on unparseable output so the
// caller can count it as a pitch-step failure.
export function parseJSON<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned) as T;
}
