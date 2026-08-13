// One-off script: sends a welcome email to everyone currently on the list.
// Mailchimp's own "Signs up for Email" automation only fires for NEW
// subscribers going forward — it doesn't run retroactively — so this covers
// whoever joined before that automation existed. Run once, not on a cron.
//
// Usage: MAILCHIMP_API_KEY=... tsx scripts/mailchimp/send-welcome-backlog.ts
import { sendNewPostEmail } from '../lib/mailchimp.ts';
import { SITE_URL } from '../lib/site.ts';

await sendNewPostEmail({
  subject: "Welcome to The Daily Guru",
  html: `
    <p>Thanks for signing up.</p>
    <p>The Daily Guru covers our dynasty league — trades, standings, grudges, and
    whatever else Wolf, Vail, and Doyle decide is worth writing about. You'll get
    an email whenever a new article or a Howlin' Minute audio segment goes up.</p>
    <p><a href="${SITE_URL}/">Check out what's already up →</a></p>
  `,
});
