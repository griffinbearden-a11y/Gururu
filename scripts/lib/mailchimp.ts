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
// actual publish it's announcing (sendCampaign itself throws so that
// sendToEmails, below, CAN propagate failures — this is the one caller
// that needs to swallow them).
export async function sendNewPostEmail(opts: NewPostEmail): Promise<void> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) {
    console.log('MAILCHIMP_API_KEY not set — skipping notification email.');
    return;
  }
  try {
    await sendCampaign(apiKey, {
      subject: opts.subject,
      html: opts.html,
      recipients: { list_id: AUDIENCE_ID },
    });
  } catch {
    // Already logged inside sendCampaign.
  }
}

export interface MailchimpMember {
  id: string; // Mailchimp's own hash of the lowercased email — safe to persist, not the raw address
  email_address: string;
}

// Fetches everyone currently subscribed. Used by the welcome-new-signups
// checker to diff against who's already been welcomed.
export async function listSubscribedMembers(): Promise<MailchimpMember[]> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) {
    console.log('MAILCHIMP_API_KEY not set — cannot list members.');
    return [];
  }
  const base = apiBase(apiKey);
  const res = await fetch(
    `${base}/lists/${AUDIENCE_ID}/members?status=subscribed&count=1000&fields=members.id,members.email_address`,
    { headers: { Authorization: authHeader(apiKey) } }
  );
  if (!res.ok) throw new Error(`list members failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { members: MailchimpMember[] };
  return data.members;
}

// Sends to a specific set of email addresses only, via a throwaway static
// segment (deleted after sending) — the free Campaign API can't target
// individual recipients directly, only a whole list or a segment.
export async function sendToEmails(emails: string[], opts: NewPostEmail): Promise<void> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey || emails.length === 0) return;

  const base = apiBase(apiKey);
  const headers = { Authorization: authHeader(apiKey), 'Content-Type': 'application/json' };

  const segmentRes = await fetch(`${base}/lists/${AUDIENCE_ID}/segments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `welcome-${Date.now()}`, static_segment: emails }),
  });
  if (!segmentRes.ok) throw new Error(`create segment failed: ${segmentRes.status} ${await segmentRes.text()}`);
  const segment = (await segmentRes.json()) as { id: number };

  try {
    await sendCampaign(apiKey, {
      subject: opts.subject,
      html: opts.html,
      recipients: { list_id: AUDIENCE_ID, segment_opts: { saved_segment_id: segment.id } },
    });
  } finally {
    // Best-effort cleanup — a failed delete shouldn't fail the whole run.
    await fetch(`${base}/lists/${AUDIENCE_ID}/segments/${segment.id}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader(apiKey) },
    }).catch(() => {});
  }
}

interface CampaignRecipients {
  list_id: string;
  segment_opts?: { saved_segment_id: number };
}

async function sendCampaign(apiKey: string, opts: { subject: string; html: string; recipients: CampaignRecipients }): Promise<void> {
  const base = apiBase(apiKey);
  const headers = { Authorization: authHeader(apiKey), 'Content-Type': 'application/json' };

  try {
    const createRes = await fetch(`${base}/campaigns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'regular',
        recipients: opts.recipients,
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

    console.log(`Sent Mailchimp campaign: ${opts.subject}`);
  } catch (err) {
    console.error('Mailchimp campaign failed:', err);
    throw err;
  }
}
