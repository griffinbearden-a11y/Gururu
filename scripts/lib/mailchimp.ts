// Sends a one-off "new post" notification email via Mailchimp's REST API.
// Used instead of Mailchimp's RSS Campaign feature, which is no longer
// available in the current UI on a free plan (checked — gone from both the
// Campaigns creation screen and the Automations/Journey trigger picker).
//
// This fires directly from the publish path (assignment-desk/run.ts,
// howlin-minute/run.ts) exactly once per genuinely-new item, immediately —
// no polling delay, no separate dedup tracking needed, since it only runs
// at the moment something new is actually committed.
const FROM_NAME = 'The Daily Guru';
const REPLY_TO = 'griffinbearden@gmail.com';
// Not sensitive (it's already public in the site's embedded signup form
// action URL) — hardcoded here so this doesn't need its own GitHub secret.
const AUDIENCE_ID = 'a7fc6a6e4d';

function apiBase(apiKey: string): string {
  const dc = apiKey.split('-').pop();
  return `https://${dc}.api.mailchimp.com/3.0`;
}

function authHeader(apiKey: string): string {
  return 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64');
}

export interface NewPostEmail {
  subject: string;
  html: string;
}

// Never throws — a notification failure should never block or fail the
// actual publish it's announcing.
export async function sendNewPostEmail(opts: NewPostEmail): Promise<void> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) {
    console.log('MAILCHIMP_API_KEY not set — skipping notification email.');
    return;
  }

  const base = apiBase(apiKey);
  const headers = {
    Authorization: authHeader(apiKey),
    'Content-Type': 'application/json',
  };

  try {
    const createRes = await fetch(`${base}/campaigns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'regular',
        recipients: { list_id: AUDIENCE_ID },
        settings: {
          subject_line: opts.subject,
          title: opts.subject,
          from_name: FROM_NAME,
          reply_to: REPLY_TO,
        },
      }),
    });
    if (!createRes.ok) throw new Error(`create campaign failed: ${createRes.status} ${await createRes.text()}`);
    const campaign = (await createRes.json()) as { id: string };

    const contentRes = await fetch(`${base}/campaigns/${campaign.id}/content`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ html: opts.html }),
    });
    if (!contentRes.ok) throw new Error(`set content failed: ${contentRes.status} ${await contentRes.text()}`);

    const sendRes = await fetch(`${base}/campaigns/${campaign.id}/actions/send`, {
      method: 'POST',
      headers,
    });
    if (!sendRes.ok) throw new Error(`send failed: ${sendRes.status} ${await sendRes.text()}`);

    console.log(`Sent Mailchimp notification: ${opts.subject}`);
  } catch (err) {
    console.error('Mailchimp notification failed:', err);
  }
}
