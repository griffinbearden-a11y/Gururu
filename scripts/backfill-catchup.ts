// One-off catch-up run for the September 2026 coverage gap: the writers'
// context bundle never included the schedule or rookie draft results, so
// power rankings, draft grades, and matchup previews never got pitched even
// though they were whitelisted (see context.ts / pitch.ts fixes alongside
// this script). This generates the three pieces that should have already
// run, using the now-fixed context bundle. Not a backfill in the historical
// sense (backfill-wolf.ts) — these publish with today's real date, no
// is_backfill flag, same as a normal desk:run article.
//
// Usage: GEMINI_API_KEY=... TAVILY_API_KEY=... tsx scripts/backfill-catchup.ts
import { writeDraft } from './assignment-desk/draft.ts';
import { critiqueDraft } from './assignment-desk/critic.ts';
import { commitArticle } from './assignment-desk/commit.ts';
import type { Pitch } from './assignment-desk/pitch.ts';
import type { WriterId } from './assignment-desk/context.ts';
import { sendNewPostEmail } from './lib/mailchimp.ts';
import { SITE_URL } from './lib/site.ts';

const MAX_REVISIONS = 2;

const ASSIGNMENTS: { writer: WriterId; pitch: Pitch }[] = [
  {
    writer: 'wolf',
    pitch: {
      headline: "Wolf's Early Power Rankings",
      thesis:
        'The 2026 season is one week old and the league already has a clear top tier, a murky middle, and at least one team that overpaid for a headline in August.',
      format: 'power_rankings',
      subject_teams: [],
      why_now: 'No power rankings have run yet this season, and the rookie draft plus Week 1 give real signal to rank on.',
    },
  },
  {
    writer: 'doyle',
    pitch: {
      headline: "Grading the League's Rookie Draft",
      thesis:
        "Some teams drafted for need, some drafted for the name on the card, and it's already clear which rooms will regret which picks.",
      format: 'rookie_draft_grades',
      subject_teams: [],
      why_now: "The rookie draft is complete and has never been covered — this is the league's first look at the full picture.",
    },
  },
  {
    writer: 'doyle',
    pitch: {
      headline: 'The Wire: Week 1 Matchup Preview',
      thesis:
        "The league's first full week of real games is underway, and the schedule already has a few matchups that will define how seriously to take the early standings.",
      format: 'matchup_preview',
      subject_teams: [],
      why_now: 'Week 1 games are still being played and no matchup coverage has run this season.',
    },
  },
];

async function generateOne({ writer, pitch }: { writer: WriterId; pitch: Pitch }) {
  console.log(`Generating ${writer}/${pitch.format}: ${pitch.headline}`);

  let draft = await writeDraft(writer, pitch);
  let verdict = await critiqueDraft(writer, pitch, draft);
  let attempts = 1;
  while (verdict.verdict === 'revise' && attempts <= MAX_REVISIONS) {
    draft = await writeDraft(writer, pitch, verdict.reasons);
    verdict = await critiqueDraft(writer, pitch, draft);
    attempts++;
  }
  if (verdict.verdict !== 'publish') {
    console.error(`${writer}/${pitch.format} did not clear the critic (${verdict.verdict}): ${verdict.reasons.join(' ')}`);
    console.error('Skipping rather than publishing something that failed review.');
    return;
  }

  const result = await commitArticle(writer, pitch, draft);
  console.log(`Committed: ${result.slug}`);
  await sendNewPostEmail({
    subject: `New on The Daily Guru: ${draft.title}`,
    html: `<p>${pitch.thesis}</p><p><a href="${SITE_URL}/articles/${result.slug}/">Read it</a></p>`,
  });
}

async function main() {
  for (const assignment of ASSIGNMENTS) {
    await generateOne(assignment);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
