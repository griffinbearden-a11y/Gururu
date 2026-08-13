# The Daily Guru

An autonomous fantasy football media site for a 12-team dynasty league. Three AI
columnists (Wolf, Vail, Doyle) pitch, draft, and publish articles on a schedule
with no human in the loop after setup. Full spec in
[`writers/CLAUDE_CODE_BRIEF.md`](writers/CLAUDE_CODE_BRIEF.md).

Stack: Astro (static) on Cloudflare Pages, content as markdown in git ("git is
the database"), GitHub Actions cron for ingestion/generation, Claude Sonnet 5
for writing.

## Repo layout

```
content/articles/    Published articles (markdown + frontmatter) — git is the DB
data/                 JSON indexes: ledger, predictions, formats, writer state,
                       commissioner ledger, spiked pitches, league lore
data/cache/            Sleeper API cache, rebuilt on every ingest run
data/nflverse/          Weekly player stats / snap counts / depth charts
writers/                Persona files (system prompts) + this project's brief
scripts/                 Ingestion + the assignment-desk pipeline
scripts/assignment-desk/  pitch -> filter -> draft -> critic -> commit
scripts/howlin-minute/    Wolf's twice-weekly audio segment (script + TTS)
public/audio/             Committed Howlin' Minute mp3s
src/                     The Astro site
.github/workflows/       Cron jobs
```

## One-time setup

1. **Install dependencies**: `npm install`
2. **GitHub repo secrets** (Settings -> Secrets and variables -> Actions):
   - `SLEEPER_LEAGUE_ID` — the current season's league ID
   - `GEMINI_API_KEY` — for the assignment desk (free-tier Gemini API key from
     [aistudio.google.com](https://aistudio.google.com/apikey))
   - `TAVILY_API_KEY` — web search for the draft step's real-NFL-facts
     grounding (free tier, no card required, from
     [tavily.com](https://tavily.com)). Gemini's own search grounding tool
     requires a billing-enabled account even on free-tier models, so this
     project does the search itself and hands Gemini plain-text results
     instead.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — any SMTP provider
     (Gmail with an app password works and is free) for the weekly health email
   - `HEALTH_EMAIL_TO` — where the health report goes
   - `ELEVENLABS_API_KEY` — voice for the Howlin' Minute audio segment
     (free tier, no card required, from [elevenlabs.io](https://elevenlabs.io)).
     Optional `ELEVENLABS_VOICE_ID` overrides the default voice — see
     `scripts/lib/tts.ts`.
   - `MAILCHIMP_API_KEY` — sends the "new post" notification email to
     subscribers (Account -> Extras -> API keys in Mailchimp, free tier).
     The audience ID is hardcoded in `scripts/lib/mailchimp.ts` since it
     isn't sensitive (it's already public in the site's signup form). The
     site's own signup popup (`src/components/SignupPopup.astro`) posts
     directly to Mailchimp's hosted subscribe endpoint — no backend on this
     site ever sees a subscriber's email.
3. **Fill in [`data/league_lore.md`](data/league_lore.md)** — Sleeper only has
   one prior season on record for this league; 2023/2024 history and anything
   else Sleeper can't see comes from this file. It's a template right now.
4. **Cloudflare Pages**: connect this repo, framework preset "Astro", build
   command `npm run build`, output directory `dist`. Every push to the
   default branch triggers a rebuild.
5. **Run the Wolf back-issues** once lore is filled in and the API key is set:
   `npm run backfill:wolf` (generates the 2023/2024/2025 preseason columns,
   flagged `is_backfill: true`).

## Local development

```bash
npm run dev              # Astro dev server
npm run build             # production build to dist/
npm run ingest:sleeper    # pull league/roster/transaction data
npm run ingest:nflverse   # pull weekly stats/snaps/depth charts
npm run desk:run          # run one pass of the assignment desk
npm run health:email       # prints the report if SMTP env vars aren't set
```

Set `SLEEPER_LEAGUE_ID` and `GEMINI_API_KEY` in your shell env for the
ingestion/desk commands to work locally.

**Astro content-cache gotcha**: if you edit or delete files under
`content/articles/` directly (not through the pipeline) and a rebuild still
shows stale results, clear `node_modules/.astro` — Astro's content layer
caches there, separately from the project-root `.astro/` folder.

## How publishing works

`.github/workflows/poll.yml` runs on a cron (90-minute baseline, tightened to
15 minutes on Sunday afternoons and Tuesday waiver mornings — see brief
section 2 for the budget math). Each run: ingests fresh Sleeper data, then
runs the assignment desk, which fills today's rotation slot for whichever
writer is scheduled (`scripts/assignment-desk/rotation.ts`) and reacts to any
new trades it hasn't covered yet. A rotation slot only fires once per day —
repeated polls the same day are cheap no-ops once a writer has already
published.

Circuit breakers (`scripts/lib/circuit-breakers.ts`): max 2 articles/day, max
$5 API spend/week, one reaction per transaction ever, and the whole system
pauses after 3 consecutive pitch-step failures or a malformed Sleeper
response — check `data/cache/circuit_breaker_state.json` if publishing stops.

`.github/workflows/howlin-minute.yml` runs separately, Monday and Thursday
regardless of Wolf's article rotation: a ~60-second spoken-word script
(Gemini, same critic pass as articles) turned into audio (ElevenLabs) and
committed to `public/audio/howlin-minute/`, indexed in
`data/howlin_minute.json`, served at `/howlin-minute/`. Shares the same
`isPaused()`/weekly-spend circuit breakers as the article pipeline.

Both pipelines share a concurrency group (`poll-and-generate`) with
`nflverse-weekly.yml` so their commits/pushes to `main` can't race each
other — see `scripts/lib/mailchimp.ts` below for why the push step also
retries with `git pull --rebase`.

**Email notifications**: `scripts/lib/mailchimp.ts` sends a one-off email
via Mailchimp's API the moment an article or Howlin' Minute segment
actually publishes — not Mailchimp's RSS Campaign feature, which is no
longer available in the current UI on a free plan. `src/pages/rss.xml.ts`
still exists as a combined feed (articles + clips) for any feed reader
that wants it, it just isn't what triggers the emails.

## Known follow-ups

- **Admin route to flip `published`**: every article has the field; the
  password-protected route to flip it (brief section 12) isn't built yet —
  it needs a small Cloudflare Pages Function with GitHub API write access,
  which is a meaningfully different piece of infrastructure from the rest of
  this static site. Flag if you want it built.
- **Prediction resolution**: `data/predictions.json` entries start `pending`
  and need a scorer to mark them `hit`/`miss` once their `resolution_date`
  passes (checked against final standings / matchup results). Not yet built.
