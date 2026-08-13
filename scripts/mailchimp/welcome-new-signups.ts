// Mailchimp's own "welcome new signups" automation requires a paid plan to
// activate at all (confirmed: even a 1-step journey is blocked on free).
// This does the same job ourselves: check who's subscribed, diff against
// who's already been welcomed, email anyone new via a throwaway segment.
//
// Only Mailchimp's own member id (an md5 hash of the lowercased email) gets
// persisted to data/cache/mailchimp_welcomed.json — not the raw address —
// so no subscriber email address ends up committed to git history.
//
// Usage: MAILCHIMP_API_KEY=... tsx scripts/mailchimp/welcome-new-signups.ts
import { listSubscribedMembers, sendToEmails } from '../lib/mailchimp.ts';
import { SITE_URL } from '../lib/site.ts';
import { readJSON, writeJSON } from '../lib/fsjson.ts';
import { logRun } from '../lib/run-log.ts';

const WELCOMED_PATH = 'data/cache/mailchimp_welcomed.json';

const WELCOME_HTML = `
  <p>Thanks for signing up.</p>
  <p>The Daily Guru covers our dynasty league — trades, standings, grudges, and
  whatever else Wolf, Vail, and Doyle decide is worth writing about. You'll get
  an email whenever a new article or a Howlin' Minute audio segment goes up.</p>
  <p><a href="${SITE_URL}/">Check out what's already up →</a></p>
`;

async function main() {
  const members = await listSubscribedMembers();
  if (members.length === 0) {
    console.log('No subscribed members found (or MAILCHIMP_API_KEY not set) — nothing to do.');
    return;
  }

  const { welcomed_ids } = await readJSON<{ welcomed_ids: string[] }>(WELCOMED_PATH, { welcomed_ids: [] });
  const welcomedSet = new Set(welcomed_ids);

  const newMembers = members.filter((m) => !welcomedSet.has(m.id));
  if (newMembers.length === 0) {
    console.log('No new subscribers since last check.');
    return;
  }

  console.log(`Welcoming ${newMembers.length} new subscriber(s).`);
  await sendToEmails(
    newMembers.map((m) => m.email_address),
    { subject: 'Welcome to The Daily Guru', html: WELCOME_HTML }
  );

  const updated = [...welcomed_ids, ...newMembers.map((m) => m.id)];
  await writeJSON(WELCOMED_PATH, { welcomed_ids: updated });
}

main()
  .then(() => logRun('mailchimp-welcome', 'success'))
  .catch(async (err) => {
    console.error(err);
    await logRun('mailchimp-welcome', 'failure', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
