// Weekly health email (brief section 12). Sent every Sunday by cron. If this
// stops arriving, that itself is the signal something broke.
//
// Required env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, HEALTH_EMAIL_TO.
// Optional: HEALTH_EMAIL_FROM (defaults to SMTP_USER).
import nodemailer from 'nodemailer';
import { readJSON } from './lib/fsjson.ts';
import { getRunLog, type RunLogEntry } from './lib/run-log.ts';
import { getWeeklySpend } from './lib/anthropic.ts';
import { isPaused } from './lib/circuit-breakers.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface LedgerEntry {
  writer: string;
  date: string;
  format: string;
  thesis: string;
}
interface SpikedEntry {
  writer: string;
  headline: string;
  reason_stage: string;
  reason_detail: string;
  spiked_at: string;
}

function withinLast7Days(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() <= SEVEN_DAYS_MS;
}

async function buildReport(): Promise<{ subject: string; html: string; text: string } | never> {
  const [ledger, spiked, weeklySpend, runLog, breaker] = await Promise.all([
    readJSON<{ entries: LedgerEntry[] }>('data/ledger.json', { entries: [] }).then((d) => d.entries),
    readJSON<{ entries: SpikedEntry[] }>('data/spiked.json', { entries: [] }).then((d) => d.entries),
    getWeeklySpend(),
    getRunLog(),
    isPaused(),
  ]);

  const publishedThisWeek = ledger.filter((e) => withinLast7Days(e.date));
  const killedThisWeek = spiked.filter((e) => withinLast7Days(e.spiked_at));
  const recentRuns = runLog.filter((e) => withinLast7Days(e.at));
  const failures = recentRuns.filter((r) => r.status === 'failure');
  const lastSuccessfulPoll = [...runLog].reverse().find((r) => r.script === 'ingest-sleeper' && r.status === 'success');

  const byWriter = (entries: LedgerEntry[]) =>
    ['wolf', 'vail', 'doyle'].map((w) => `${w}: ${entries.filter((e) => e.writer === w).length}`).join(', ');

  const lines: string[] = [];
  lines.push(`THE DAILY GURU — Weekly Health Report`);
  lines.push(`${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`System status: ${breaker.paused ? `PAUSED — ${breaker.reason}` : 'running'}`);
  lines.push('');
  lines.push(`Articles published this week: ${publishedThisWeek.length} (${byWriter(publishedThisWeek)})`);
  for (const e of publishedThisWeek) lines.push(`  - [${e.writer}] ${e.format}: "${e.thesis}"`);
  lines.push('');
  lines.push(`Pitches killed this week: ${killedThisWeek.length}`);
  const filterKills = killedThisWeek.filter((e) => e.reason_stage === 'filter').length;
  const criticKills = killedThisWeek.filter((e) => e.reason_stage === 'critic').length;
  lines.push(`  filter-stage: ${filterKills}, critic-stage: ${criticKills}`);
  for (const e of killedThisWeek.slice(0, 15)) lines.push(`  - [${e.writer}/${e.reason_stage}] "${e.headline}" — ${e.reason_detail}`);
  lines.push('');
  lines.push(`API spend this week: $${weeklySpend.toFixed(2)} of $5.00 cap`);
  lines.push('');
  lines.push(`Last successful Sleeper poll: ${lastSuccessfulPoll?.at ?? 'never recorded'}`);
  lines.push('');
  lines.push(`Cron runs logged this week: ${recentRuns.length}, failures: ${failures.length}`);
  for (const f of failures) lines.push(`  - [${f.script}] ${f.at}: ${f.detail ?? '(no detail)'}`);
  lines.push('');
  lines.push(
    `Actions-minutes note: budget math in the build brief targets ~35% of the 2,000 free minutes/month on a private repo (baseline 90-minute polls, tightened to 15 minutes on Sunday afternoons and Tuesday waiver mornings, plus generation runs). ${recentRuns.length} scheduled runs were logged this week — check the repo's Actions tab for exact minutes if this trend looks off.`
  );

  const text = lines.join('\n');
  const html = `<pre style="font-family: monospace; white-space: pre-wrap;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  const subject = breaker.paused
    ? `[PAUSED] The Daily Guru — Weekly Health Report`
    : `The Daily Guru — Weekly Health Report (${publishedThisWeek.length} published, ${failures.length} failures)`;

  return { subject, html, text };
}

async function main() {
  const { subject, html, text } = await buildReport();

  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'HEALTH_EMAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log('SMTP not configured, printing report instead:\n');
    console.log(text);
    console.log(`\n(Set ${missing.join(', ')} to actually send this.)`);
    return;
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transport.sendMail({
    from: process.env.HEALTH_EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.HEALTH_EMAIL_TO,
    subject,
    text,
    html,
  });

  console.log(`Health email sent to ${process.env.HEALTH_EMAIL_TO}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
