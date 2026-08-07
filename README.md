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
src/                     The Astro site
.github/workflows/       Cron jobs
```

## One-time setup

1. **Install dependencies**: `npm install`
2. **GitHub repo secrets** (Settings -> Secrets and variables -> Actions):
   - `SLEEPER_LEAGUE_ID` — the current season's league ID
   - `ANTHROPIC_API_KEY` — for the assignment desk
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — any SMTP provider
     (Gmail with an app password works and is free) for the weekly health email
   - `HEALTH_EMAIL_TO` — where the health report goes
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

Set `SLEEPER_LEAGUE_ID` and `ANTHROPIC_API_KEY` in your shell env for the
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

## Known follow-ups

- **Admin route to flip `published`**: every article has the field; the
  password-protected route to flip it (brief section 12) isn't built yet —
  it needs a small Cloudflare Pages Function with GitHub API write access,
  which is a meaningfully different piece of infrastructure from the rest of
  this static site. Flag if you want it built.
- **Prediction resolution**: `data/predictions.json` entries start `pending`
  and need a scorer to mark them `hit`/`miss` once their `resolution_date`
  passes (checked against final standings / matchup results). Not yet built.
