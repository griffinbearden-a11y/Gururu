# The Daily Guru — Build Brief

Build an autonomous fantasy football media site for a 12-team dynasty league. Three AI
columnists write and publish articles on a schedule with zero human involvement after
setup.

Read this whole document before writing code. At the end there's a list of things to
ask me for — ask for all of them in one message, then start.

---

## 1. Hard constraints

- **Free hosting, forever.** No paid tiers, no trial credits.
- **Fully autonomous.** After setup I never touch it. No approval queues, no dashboards
  I have to check, no manual publishing.
- **Private.** `noindex` headers plus a single shared site password. Twelve people get
  in; search engines don't. The GitHub repo stays private.
- **Cheap to run.** Target under $60/season in API spend.

---

## 2. Stack

- **Static site generator:** Astro (or Next.js static export). Content as markdown
  files in the repo — git is the database. No hosted DB.
- **Job runner:** GitHub Actions, cron-scheduled. Generation jobs write markdown files,
  commit, and push. Push triggers a rebuild.
- **Hosting:** Cloudflare Pages, connected to the private repo.
- **Model:** Claude Sonnet via the Anthropic API, with the web search tool enabled on
  drafting calls.

**Actions budget math (do not exceed):** a private repo gets 2,000 Actions minutes per
month. Baseline poll every 90 minutes = ~480 runs/month. Add tightened 15-minute polls
on Sunday afternoons and Tuesday waiver mornings via additional cron entries in the same
workflow = ~600 runs/month total. Generation jobs add ~120 minutes. That lands around
35% of budget. Log estimated usage in the weekly health email.

---

## 3. Data source: Sleeper API

Read-only, no auth, no API key. Base URL `https://api.sleeper.app/v1/`. Stay well under
rate limits (target under 90 req/min).

Endpoints to use:

- `/league/{league_id}` — settings, scoring, roster positions, `previous_league_id`
- `/league/{league_id}/rosters` — player IDs per team, records, points for/against
- `/league/{league_id}/users` — display names, team names, avatars
- `/league/{league_id}/matchups/{week}` — scores; updates live during games
- `/league/{league_id}/transactions/{week}` — trades, waivers, FAAB, and
  commissioner-executed moves (check the `type` and `status` fields)
- `/league/{league_id}/traded_picks` — critical for dynasty
- `/league/{league_id}/drafts` and `/draft/{draft_id}/picks`
- `/league/{league_id}/winners_bracket` — playoff results
- `/players/nfl` — the player ID → name map. ~5MB. Cache to disk once daily. **Never**
  fetch this per-request.

**Important:** the API only sees leagues that exist on Sleeper. This league has one
prior season there. 2024 and 2023 data does not exist and must come from the lore file.

Also ingest **nflverse** public data (weekly player stats, snap counts, depth charts)
into the repo as CSV/JSON so writers have real NFL context without searching every time.
Refresh weekly.

---

## 4. Data model

Markdown files with YAML frontmatter, plus a few JSON indexes.

**`/content/articles/{date}-{slug}.md`**
```yaml
writer: wolf | vail | doyle
title: string
format: string          # must match a format library key
subject_teams: []       # roster_ids. PRIMARY subjects only.
subject_players: []
thesis: string          # one sentence, for the ledger
published: true
is_backfill: false
created_at: ISO8601
```

**`/data/ledger.json`** — one entry per published article: writer, date, format,
subject_teams, thesis. This is what the pitch filter reads and what writers get fed as
context.

**`/data/predictions.json`** — every forward-looking claim any writer makes, scored
after the fact: writer, article slug, claim, subject, resolution date, outcome. This
powers the Wolf Pick Tracker and every writer's public track record.

**`/data/commissioner_ledger.json`** — auto-populated from Sleeper transactions where
type indicates a commissioner action. Never written by a model.

**`/data/league_lore.md`** — hand-written by me, static, fed into every generation call.

---

## 5. The assignment desk

**Never let a writer go straight from "it's Tuesday" to a finished article.** Four
steps:

1. **Pitch.** Send the writer's persona file + current league state + lore + the last
   ~20 ledger entries. Ask for 5 pitches as JSON: `headline`, `thesis`, `format`,
   `subject_teams`, `why_now`. Cheap call.

2. **Filter (code, not model).** Reject any pitch where:
   - a primary subject team appeared as a primary subject in the last **5 days**
     (global across all writers)
   - the format ran for **this writer** in their last 5 articles
   - the format isn't in this writer's whitelist
   - the format's season window doesn't include today
   - the thesis substantially duplicates a ledger entry

   League-wide formats (power rankings, tiers, positional rankings) carry
   `subject_teams: []` and are exempt from the team cooldown. Trade grades flag both
   teams involved.

3. **Draft.** Send the surviving pitch back with full context and web search enabled.

4. **Critic.** A separate model call with a rubric returning
   `{verdict: publish|revise|kill, reasons: []}`. Two revision attempts, then fall back
   to a library format, then skip the slot. **A missed article is always better than a
   bad one.**

Log every killed pitch to `/data/spiked.json` and build a "Spiked" page showing rejected
ideas. That page will be popular.

---

## 6. The critic rubric

Check only these:

- Does every factual claim about real NFL players trace to provided context or a search
  result? If not → revise.
- Does the thesis duplicate anything in the last 20 ledger entries? → revise.
- Is any content about a real person **outside fantasy football** — appearance, job,
  family, relationships, money, or a sincere attack on their character? → **kill**.
- Are numbers sourced from provided league data rather than invented? → revise.

**The critic must NOT touch bias, tone, profanity, unfairness, or opinion.** Write this
into the rubric explicitly with examples. "Kyle's roster is a fucking dumpster fire and
he should be embarrassed" ships. Anything about Kyle as a human being does not. If the
critic starts sanding down voice, the site is dead within a month.

---

## 7. Schedule

Preseason: 1 article per writer per week. In-season: 3 per writer per week, on
alternating days — a static rotation table (Wolf Mon/Wed/Fri, Vail Tue/Thu/Sat, Doyle
Sun/Tue/Thu, adjust as needed so no two writers publish the same slot).

Reactive articles fire off the transaction poller and sit **outside** the rotation, but
count against the daily circuit breaker.

---

## 8. Format library

Store as `/data/formats.json` — key, display name, description, season window
(`preseason` | `in_season` | `playoffs` | `offseason` | `any`), and whether it's
league-wide.

Seed it with the formats listed in each writer's whitelist (see the three persona
files). Add dynasty-specific ones: `rookie_pick_market`, `rebuild_tracker`,
`contention_window`, `age_curve_audit`, `purgatory_piece`, `future_pick_debt`,
`taxi_squad_report`, `startup_revisited`, `rookie_draft_grades`.

**Wildcard slot:** one of each writer's three weekly articles must use a format NOT in
the library. It publishes automatically. Append successful wildcards to `formats.json`
so the library grows on its own. This is what keeps the site from going stale in
November.

---

## 9. The writers

Three persona files go in `/writers/` — `wolf.md`, `vail.md`, `doyle.md`. I'm supplying
them. Load the matching file as the system prompt. The frontmatter carries byline, beat,
and accent color.

The `formats` list in each file is a **whitelist** — validate pitches against it. Wolf
cannot pitch a rebuild tracker. That's what keeps the beats from collapsing into each
other.

Each writer also carries mutable state in `/data/writer_state.json`: grudges (with the
incident that started them), positions they've committed to, and their scored track
record. Update after each article. Feed back in on the next.

---

## 10. Signature features

**Wolf Pick Tracker** — persistent header module. His three anointed teams for the
season, combined record, and his career streak split into two columns: **Verified** and
**Claimed**. Computed from `predictions.json`, never asserted.

**The Commissioner Ledger** — auto-populated page logging every commissioner-executed
transaction from Sleeper: date, action, teams affected, whether it was a normal
transaction or a manual override. Zero model involvement. It just sits in the nav
accumulating rows.

**Corrections** — a real page. Writers can file corrections. Track who files them.

**Track records** — every writer's prediction hit rate, public, on their author page.

**Archive** — Wolf's three back-issues (2023, 2024, 2025) flagged `is_backfill: true`.
Exclude them from cooldown and recency checks; **include** them in the ledger writers
read.

---

## 11. Site design

Pin the subject before designing: this is a private sports desk for a twelve-man dynasty
league in Macon, Georgia, whose loudest columnist is named after a blues musician. The
audience is twelve friends who will read it on their phones. The page's job is to make
them feel like their league has a press corps.

**Do a design pass before writing CSS.** Produce a compact token system — 4-6 named hex
values, a display face and a body face chosen deliberately (not the ones you'd reach for
on any project), a layout concept, and one signature element the site is remembered by.
Review that plan and revise anything that reads like a default you'd produce for any
sports site.

Specifically avoid: the broadsheet-with-hairline-rules look, cream background with a
terracotta accent, and near-black with one acid accent. Those are AI-design defaults,
not choices. There's a real vernacular available in the subject — Southern handbills,
juke joint posters, small-market sports pages — use it or find something better, but
choose.

**Structural requirements regardless of aesthetic direction:**

- **Density.** A lead story with a large image, two or three secondaries beside it, then
  a river of headlines. Not a single column of blog posts.
- **Rail modules:** standings (both divisions), Wolf Pick Tracker, The Wire (last five
  transactions), Commissioner Ledger link, current power rankings.
- **Nav:** Home / The Wire / Rankings / Ledger / Archive / About
- **Bylines and relative timestamps on everything.** "3 hours ago" is what makes an
  auto-publishing site feel alive.
- **Writer avatars:** flat monograms in each writer's accent color. No photorealistic
  portraits.
- Responsive to mobile, visible keyboard focus, reduced motion respected.

**About page:** each writer's bio written in his own voice — Wolf bragging and listing
enemies, Vail dry and faintly contemptuous of the exercise, Doyle earnest and slightly
too long. Include a masthead note disclosing that the columnists are AI working off live
Sleeper data. Link the corrections policy.

---

## 12. Circuit breakers

- Max 2 articles published per day
- Max $5 API spend per week — track it, halt on breach
- One reaction per transaction ID, ever
- Three consecutive pitch-step failures, or malformed Sleeper data → pause the system
  rather than publish garbage
- A `published` boolean on every article plus a password-protected admin route to flip
  it. I will probably never use this. Build it anyway.
- **Weekly health email:** articles published, articles killed and why, API spend, last
  successful poll, cron failures. If it stops arriving, that tells me something broke.

---

## 13. Build order

1. Sleeper ingestion + nflverse ingestion + the data model. Verify against the real
   league before anything else.
2. Static site rendering hand-written test articles. Get the design right with fake
   content.
3. The assignment desk: pitch → filter → draft → critic → commit.
4. Scheduling, circuit breakers, health email.
5. Signature features: tracker, ledger, corrections, archive.
6. Wolf's three back-issues, generated last, off real 2025 standings.

Do not start at step 3. If you build generation before the data model is verified,
you'll debug prompts against bad data.

---

## 14. Ask me for these before you start

- `SLEEPER_LEAGUE_ID` for the current season
- `ANTHROPIC_API_KEY`
- The Cloudflare and GitHub accounts to use
- The site password
- An email address for the weekly health report
- `league_lore.md` — I'll write it; give me a template with the sections you need
