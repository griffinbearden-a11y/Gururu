// Team display metadata (avatar images) for Vail's Trade Tools UI — kept
// separate from roster-context.ts's TeamContext, which feeds the grading
// engine and has no business carrying image URLs.
import { readJSON } from '../fsjson.ts';
import type { SleeperRoster, SleeperUser } from '../sleeper.ts';

export interface TeamMeta {
  rosterId: number;
  teamName: string;
  avatarUrl: string | null;
}

export async function buildTeamMeta(): Promise<Record<number, TeamMeta>> {
  const [rosters, users] = await Promise.all([
    readJSON<SleeperRoster[]>('data/cache/rosters.json', []),
    readJSON<SleeperUser[]>('data/cache/users.json', []),
  ]);
  const userByUserId = new Map(users.map((u) => [u.user_id, u]));

  const meta: Record<number, TeamMeta> = {};
  for (const r of rosters) {
    const user = userByUserId.get(r.owner_id);
    const teamName = user?.metadata?.team_name?.trim() || user?.display_name || `Roster ${r.roster_id}`;
    meta[r.roster_id] = {
      rosterId: r.roster_id,
      teamName,
      avatarUrl: user?.avatar ? `https://sleepercdn.com/avatars/thumbs/${user.avatar}` : null,
    };
  }
  return meta;
}
