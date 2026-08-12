// Web search via Tavily, used to ground the draft step in real NFL facts
// instead of Gemini's built-in Google Search grounding tool — that tool
// 429s immediately on the free tier (grounding appears to require a
// billing-enabled Gemini account), so this does the search ourselves and
// hands plain-text results to the model as context.
//
// Tavily's free tier requires no card and covers this workflow's volume
// comfortably. See https://tavily.com.
const TAVILY_URL = 'https://api.tavily.com/search';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

// Never throws — a search outage should degrade the draft (fewer grounded
// facts) rather than fail the whole assignment.
export async function searchWeb(query: string, maxResults = 5): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return '';

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
      }),
    });
    if (!res.ok) {
      console.error(`Tavily search failed: ${res.status} ${await res.text()}`);
      return '';
    }
    const data = (await res.json()) as { results?: TavilyResult[] };
    if (!data.results?.length) return '';
    return data.results.map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.content}`).join('\n\n');
  } catch (err) {
    console.error('Tavily search errored:', err);
    return '';
  }
}
