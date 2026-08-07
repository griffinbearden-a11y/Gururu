// Step 2: Filter. Code, not model. Every rejection is logged to spiked.json
// with reason_stage "filter" so the public Spiked page can show it.
import { readJSON } from '../lib/fsjson.ts';
import { getFullLedger, loadWriterPersona, type LedgerEntry, type WriterId } from './context.ts';
import { getSeasonPhase } from '../lib/season.ts';
import type { Pitch } from './pitch.ts';

const TEAM_COOLDOWN_DAYS = 5;
const FORMAT_LOOKBACK_COUNT = 5;

interface FormatDef {
  key: string;
  season_window: string;
  league_wide: boolean;
}

export interface FilterRejection {
  reason_code: string;
  reason_detail: string;
}

export interface FilterResult {
  survivors: Pitch[];
  rejections: { pitch: Pitch; rejection: FilterRejection }[];
}

function daysAgo(dateIso: string, now: Date): number {
  return (now.getTime() - new Date(dateIso).getTime()) / 86_400_000;
}

// Cheap thesis-similarity check: normalized token overlap. Not semantic, but
// catches the common case of re-running the same claim with different words
// around it, without needing another model call.
function thesisOverlap(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  return overlap / Math.min(setA.size, setB.size);
}
const THESIS_DUP_THRESHOLD = 0.75;

export async function filterPitches(
  pitches: Pitch[],
  writerId: WriterId,
  opts: { isWildcardSlot: boolean; isReactive?: boolean; now?: Date }
): Promise<FilterResult> {
  const now = opts.now ?? new Date();
  const persona = loadWriterPersona(writerId);
  const fullLedger = await getFullLedger();
  const nonBackfillLedger = fullLedger.filter((e) => !(e as LedgerEntry & { is_backfill?: boolean }).is_backfill);
  const { formats } = await readJSON<{ formats: FormatDef[] }>('data/formats.json', { formats: [] });
  const formatByKey = new Map(formats.map((f) => [f.key, f]));
  const seasonPhase = await getSeasonPhase();

  const recentTeamSubjects = new Set<number>();
  for (const e of nonBackfillLedger) {
    if (daysAgo(e.date, now) <= TEAM_COOLDOWN_DAYS) {
      for (const t of e.subject_teams) recentTeamSubjects.add(t);
    }
  }

  const writerLastFormats = nonBackfillLedger
    .filter((e) => e.writer === writerId)
    .slice(-FORMAT_LOOKBACK_COUNT)
    .map((e) => e.format);

  const survivors: Pitch[] = [];
  const rejections: FilterResult['rejections'] = [];

  for (const pitch of pitches) {
    const formatDef = formatByKey.get(pitch.format);
    const isNewWildcardFormat = opts.isWildcardSlot && !formatDef;

    if (!isNewWildcardFormat && !persona.formatWhitelist.includes(pitch.format)) {
      rejections.push({ pitch, rejection: { reason_code: 'not_in_whitelist', reason_detail: `"${pitch.format}" is not in ${writerId}'s format whitelist.` } });
      continue;
    }

    if (formatDef && formatDef.season_window !== 'any' && formatDef.season_window !== seasonPhase) {
      rejections.push({
        pitch,
        rejection: { reason_code: 'season_window', reason_detail: `"${pitch.format}" runs in ${formatDef.season_window}, but it's currently ${seasonPhase}.` },
      });
      continue;
    }

    if (!opts.isWildcardSlot && !opts.isReactive && writerLastFormats.includes(pitch.format)) {
      rejections.push({
        pitch,
        rejection: { reason_code: 'format_reuse', reason_detail: `${writerId} already ran "${pitch.format}" within their last ${FORMAT_LOOKBACK_COUNT} articles.` },
      });
      continue;
    }

    const isLeagueWide = formatDef?.league_wide ?? pitch.subject_teams.length === 0;
    if (!isLeagueWide) {
      const collidingTeam = pitch.subject_teams.find((t) => recentTeamSubjects.has(t));
      if (collidingTeam !== undefined) {
        rejections.push({
          pitch,
          rejection: {
            reason_code: 'team_cooldown',
            reason_detail: `Roster ${collidingTeam} was a primary subject within the last ${TEAM_COOLDOWN_DAYS} days (league-wide, across all writers).`,
          },
        });
        continue;
      }
    }

    const dupEntry = fullLedger.slice(-20).find((e) => thesisOverlap(e.thesis, pitch.thesis) >= THESIS_DUP_THRESHOLD);
    if (dupEntry) {
      rejections.push({
        pitch,
        rejection: { reason_code: 'duplicate_thesis', reason_detail: `Substantially duplicates ${dupEntry.writer}'s "${dupEntry.thesis}" (${dupEntry.date.slice(0, 10)}).` },
      });
      continue;
    }

    survivors.push(pitch);
  }

  return { survivors, rejections };
}
