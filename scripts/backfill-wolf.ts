// Generates Wolf's three back-issue preseason columns (2023, 2024, 2025),
// flagged is_backfill: true. Run this LAST, after league_lore.md has real
// 2023/2024 history in it — those two seasons don't exist on Sleeper at all,
// so without lore this script has nothing to work with but the persona
// file's own canon (the three anointed teams and the outcome), which is
// enough for a thin column but not a good one.
//
// 2025 is grounded in real Sleeper data (this league's one prior season on
// record). 2023/2024 are grounded entirely in league_lore.md.
//
// Usage: GEMINI_API_KEY=... tsx scripts/backfill-wolf.ts
import { readFileSync, existsSync } from 'node:fs';
import { loadWriterPersona, loadLore } from './assignment-desk/context.ts';
import { writeDraft } from './assignment-desk/draft.ts';
import { critiqueDraft } from './assignment-desk/critic.ts';
import { commitArticle } from './assignment-desk/commit.ts';
import type { Pitch } from './assignment-desk/pitch.ts';
import { readJSON } from './lib/fsjson.ts';

const MAX_REVISIONS = 2;

interface Season2025Data {
  teams: { roster_id: number; team_name: string; owner: string; wins: number; losses: number; ties: number; points_for: number }[];
  championRosterId: number | null;
}

async function load2025Data(): Promise<Season2025Data> {
  const rostersPath = 'data/cache/previous_seasons/2025/rosters.json';
  const usersPath = 'data/cache/previous_seasons/2025/users.json';
  const bracketPath = 'data/cache/previous_seasons/2025/winners_bracket.json';
  if (!existsSync(rostersPath) || !existsSync(usersPath)) {
    throw new Error('2025 season cache missing — run `npm run ingest:sleeper` first.');
  }
  const rosters = JSON.parse(readFileSync(rostersPath, 'utf-8'));
  const users = JSON.parse(readFileSync(usersPath, 'utf-8'));
  const userById = new Map(users.map((u: any) => [u.user_id, u]));
  const teams = rosters.map((r: any) => {
    const user: any = userById.get(r.owner_id);
    return {
      roster_id: r.roster_id,
      team_name: user?.metadata?.team_name?.trim() || user?.display_name || `Roster ${r.roster_id}`,
      owner: user?.display_name ?? 'unknown',
      wins: r.settings.wins,
      losses: r.settings.losses,
      ties: r.settings.ties,
      points_for: r.settings.fpts + (r.settings.fpts_decimal ?? 0) / 100,
    };
  });

  let championRosterId: number | null = null;
  if (existsSync(bracketPath)) {
    const bracket = JSON.parse(readFileSync(bracketPath, 'utf-8'));
    const finalMatch = bracket.find((m: any) => m.p === 1);
    championRosterId = finalMatch?.w ?? null;
  }
  return { teams, championRosterId };
}

interface BackfillSeason {
  year: number;
  slugTitle: string;
  isBackfill: boolean;
  buildContext: () => Promise<string>;
}

async function buildContext2025(): Promise<string> {
  const data = await load2025Data();
  const champion = data.teams.find((t) => t.roster_id === data.championRosterId);
  const standings = data.teams
    .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for)
    .map((t) => `  ${t.team_name} (${t.owner}): ${t.wins}-${t.losses}-${t.ties}, ${t.points_for.toFixed(1)} PF`)
    .join('\n');
  return [
    '# Real 2025 season final standings (from Sleeper, ground every number in this)',
    standings,
    '',
    `# 2025 champion (confirmed via Sleeper winners bracket)`,
    champion ? `${champion.team_name} (${champion.owner})` : '(unknown — do not assert a champion if this is empty)',
    '',
    '# League lore',
    loadLore() || '(none provided)',
  ].join('\n');
}

async function buildContextLoreOnly(year: number): Promise<string> {
  return [
    `# ${year} season`,
    `This season does not exist on Sleeper. The ONLY source for it is the league lore below. If the lore doesn't cover ${year} in enough detail to write a real column, say less rather than invent specifics — do not fabricate standings, records, or outcomes not present in the lore.`,
    '',
    '# League lore',
    loadLore() || '(none provided — this backfill piece will be thin until league_lore.md is filled in)',
  ].join('\n');
}

const SEASONS: BackfillSeason[] = [
  { year: 2023, slugTitle: 'I Told You In August (2023)', isBackfill: true, buildContext: () => buildContextLoreOnly(2023) },
  { year: 2024, slugTitle: 'I Told You In August (2024)', isBackfill: true, buildContext: () => buildContextLoreOnly(2024) },
  { year: 2025, slugTitle: 'I Told You In August (2025)', isBackfill: true, buildContext: () => buildContext2025() },
];

async function generateOne(season: BackfillSeason) {
  const persona = loadWriterPersona('wolf');
  const contextBundle = await season.buildContext();

  const pitch: Pitch = {
    headline: season.slugTitle,
    thesis: `Wolf's ${season.year} preseason column, naming his contenders for that season.`,
    format: 'howlin_preseason_pick',
    subject_teams: [],
    why_now: `Archive back-issue for ${season.year}.`,
  };

  let draft = await writeDraft('wolf', pitch, undefined, contextBundle);
  let verdict = await critiqueDraft('wolf', pitch, draft, contextBundle);
  let attempts = 1;
  while (verdict.verdict === 'revise' && attempts <= MAX_REVISIONS) {
    draft = await writeDraft('wolf', pitch, verdict.reasons, contextBundle);
    verdict = await critiqueDraft('wolf', pitch, draft, contextBundle);
    attempts++;
  }
  if (verdict.verdict !== 'publish') {
    console.error(`${season.year} backfill piece did not clear the critic (${verdict.verdict}): ${verdict.reasons.join(' ')}`);
    console.error('Skipping this season rather than publishing something ungrounded.');
    return;
  }

  const backfillDate = new Date(Date.UTC(season.year, 7, 1)); // Aug 1, that year
  const result = await commitArticle('wolf', pitch, draft, { isBackfill: true, backfillDate });
  console.log(`Committed ${season.year} back-issue: ${result.slug}`);
}

async function main() {
  const lore = loadLore();
  if (!lore || lore.includes('<!--')) {
    console.warn(
      'WARNING: data/league_lore.md still looks like the unfilled template. 2023/2024 columns will be thin or the critic may kill them outright. Fill in the lore file for real back-issues.'
    );
  }
  for (const season of SEASONS) {
    console.log(`Generating ${season.year} back-issue...`);
    await generateOne(season);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
