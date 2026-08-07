// Writes the outcome of one assignment-desk run to disk: the article
// markdown file, and updates to ledger/predictions/writer_state/spiked/
// formats. Nothing here touches git — the workflow commits and pushes.
import { readJSON, writeJSON } from '../lib/fsjson.ts';
import { getSeasonPhase } from '../lib/season.ts';
import type { WriterId } from './context.ts';
import type { Pitch } from './pitch.ts';
import type { Draft } from './draft.ts';
import type { FilterRejection } from './filter.ts';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
}

async function resolvePlayerIds(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const players = await readJSON<Record<string, { full_name: string }>>('data/cache/players.json', {});
  const byName = new Map(Object.entries(players).map(([id, p]) => [p.full_name?.toLowerCase(), id]));
  const ids: string[] = [];
  for (const name of names) {
    const id = byName.get(name.toLowerCase());
    if (id) ids.push(id);
  }
  return ids;
}

export interface CommitResult {
  slug: string;
  path: string;
}

export async function commitArticle(
  writerId: WriterId,
  pitch: Pitch,
  draft: Draft,
  opts: { isBackfill?: boolean; backfillDate?: Date } = {}
): Promise<CommitResult> {
  const now = opts.backfillDate ?? new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug = `${dateStr}-${slugify(draft.title)}`;
  const path = `content/articles/${slug}.md`;

  const subjectPlayerIds = await resolvePlayerIds(draft.subject_player_names);

  const frontmatter = [
    '---',
    `writer: ${writerId}`,
    `title: "${draft.title.replace(/"/g, '\\"')}"`,
    `format: ${pitch.format}`,
    `subject_teams: [${pitch.subject_teams.join(', ')}]`,
    `subject_players: [${subjectPlayerIds.map((id) => `"${id}"`).join(', ')}]`,
    `thesis: "${pitch.thesis.replace(/"/g, '\\"')}"`,
    'published: true',
    `is_backfill: ${opts.isBackfill ?? false}`,
    `created_at: ${now.toISOString()}`,
    '---',
    '',
    draft.body_markdown.trim(),
    '',
  ].join('\n');

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('content/articles', { recursive: true });
  await writeFile(path, frontmatter, 'utf-8');

  await appendLedgerEntry(writerId, slug, pitch, now, opts.isBackfill ?? false);
  await appendPredictions(writerId, slug, draft.predictions, !opts.isBackfill);
  if (!opts.isBackfill) await maybeGrowFormatLibrary(pitch);

  return { slug, path };
}

async function appendLedgerEntry(writerId: WriterId, slug: string, pitch: Pitch, now: Date, isBackfill: boolean) {
  const data = await readJSON<{ _comment: string; entries: any[] }>('data/ledger.json', { _comment: '', entries: [] });
  data.entries.push({
    writer: writerId,
    date: now.toISOString(),
    slug,
    format: pitch.format,
    subject_teams: pitch.subject_teams,
    thesis: pitch.thesis,
    is_backfill: isBackfill,
  });
  await writeJSON('data/ledger.json', data);
}

async function appendPredictions(
  writerId: WriterId,
  slug: string,
  predictions: Draft['predictions'],
  verified: boolean
) {
  if (!predictions?.length) return;
  const data = await readJSON<{ _comment: string; entries: any[] }>('data/predictions.json', { _comment: '', entries: [] });
  for (const p of predictions) {
    data.entries.push({
      writer: writerId,
      article_slug: slug,
      claim: p.claim,
      subject: p.subject,
      resolution_date: p.resolution_date,
      outcome: 'pending',
      verified,
    });
  }
  await writeJSON('data/predictions.json', data);
}

async function maybeGrowFormatLibrary(pitch: Pitch) {
  const data = await readJSON<{ _comment: string; formats: any[] }>('data/formats.json', { _comment: '', formats: [] });
  if (data.formats.some((f) => f.key === pitch.format)) return;
  const seasonPhase = await getSeasonPhase();
  data.formats.push({
    key: pitch.format,
    display_name: pitch.format.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: pitch.thesis,
    season_window: seasonPhase,
    league_wide: pitch.subject_teams.length === 0,
  });
  await writeJSON('data/formats.json', data);
}

export async function logSpiked(
  writerId: WriterId,
  pitch: Pitch,
  reasonStage: 'filter' | 'critic',
  reason: FilterRejection | { reason_code: string; reason_detail: string }
) {
  const data = await readJSON<{ _comment: string; entries: any[] }>('data/spiked.json', { _comment: '', entries: [] });
  data.entries.push({
    writer: writerId,
    headline: pitch.headline,
    thesis: pitch.thesis,
    format: pitch.format,
    reason_stage: reasonStage,
    reason_code: reason.reason_code,
    reason_detail: reason.reason_detail,
    spiked_at: new Date().toISOString(),
  });
  await writeJSON('data/spiked.json', data);
}
