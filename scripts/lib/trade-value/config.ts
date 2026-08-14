// League-specific constants for the dynasty trade tools (Trade Analyzer,
// Trade Finder, and the writer-facing grader). Kept in one file — not
// scattered as literals — so Part 5's league-bias learning has a single
// place to eventually override the first-guess numbers below.

export const LEAGUE = {
  TEAM_COUNT: 12,
  DIVISIONS: 2,
  ROSTER_SPOTS: 17,
  FLEX_SPOTS: 2,
  QB_SLOTS: 1,
  IS_DYNASTY: true,
  PPR: 1,
} as const;

// FantasyCalc query params — exact, matched to this league's settings.
// Do not change without changing the league itself.
export const FANTASYCALC_PARAMS = {
  isDynasty: true,
  numQbs: 1,
  numTeams: 12,
  ppr: 1,
} as const;

// FantasyCalc has no parameter for flex count and we start 2 flex spots (24
// flex-eligible starting spots leaguewide draining the waiver pool), so
// usable skill-position depth is worth more than the API says, and QBs are
// worth slightly less relative to everything else. First-guess numbers —
// Part 5 (league-bias learning) should replace these with values observed
// from our own accepted trades once there's a season of data.
export const FLEX_DEPTH_BOOST = 1.05;
export const FLEX_DEPTH_BOOST_MIN_RANK = 24; // outside a 12-team startup's first two rounds
export const QB_ADJUSTMENT = 0.95;

// Rookie-pick valuation (Part 2).
export const FUTURE_PICK_DECAY = 0.85; // per draft year beyond the next one
// Manual multiplier on 1st-round picks only, keyed by draft season (e.g.
// "2027"). Edit by hand once rookie class rankings firm up. Empty = neutral.
export const CLASS_STRENGTH_MULTIPLIER: Record<string, number> = {};
export const PICK_OWNERSHIP_YEARS_AHEAD = 3; // "next three seasons," per spec

// Market axis (Part 3, axis 1).
export const CONSOLIDATION_FACTOR = 0.87; // per extra asset received, 0-indexed exponent

// Grade curve, by market delta.
export const MARKET_GRADE_CURVE: { min: number; grade: string }[] = [
  { min: 0.15, grade: 'A' },
  { min: 0.06, grade: 'B' },
  { min: -0.05, grade: 'C' },
  { min: -0.15, grade: 'D' },
  { min: -Infinity, grade: 'F' },
];

// Fit axis (Part 3, axis 2).
export const YOUNG_PLAYER_MAX_AGE = 24;
export const CONTENDER_FIT = {
  PICK_MULTIPLIER: 0.85,
  VETERAN_MULTIPLIER: 1.15, // "win-now veteran" bump, age > YOUNG_PLAYER_MAX_AGE
};
export const REBUILDER_FIT = {
  PICK_MULTIPLIER: 1.15,
  YOUNG_MULTIPLIER: 1.10,
  VETERAN_MULTIPLIER: 0.80, // "aging veteran" discount, age > YOUNG_PLAYER_MAX_AGE
};

// Guardrails — non-negotiable per the brief.
export const FIT_MULTIPLIER_BOUNDS = { min: 0.80, max: 1.20 } as const;
export const FIT_MAX_GRADE_STEPS = 2; // fit may move a grade at most 2 letter steps from market
export const MARKET_FLOOR_DELTA = -0.20; // below this, final grade capped at C regardless of fit
export const MARKET_FLOOR_GRADE = 'C';

// Trade Finder (Part 4). PACKAGE_TARGET_RANGE is a fraction of the target's
// raw market value — NOT the premium-inflated value. The premium is used
// only to bias ranking toward the generous end of that range (packages
// closer to target × premium sort first), not to set the floor: anchoring
// the floor on the premium would force every accepted package to overpay
// by at least (premium - 1), making a neutral-or-better outcome for the
// user's own team structurally impossible.
export const PACKAGE_LOOSE_PREMIUM = 1.12; // realistic-overpay ranking anchor
export const PACKAGE_TARGET_RANGE = { min: 1.00, max: 1.30 } as const; // × target's raw market value
export const FINDER_MY_FIT_FLOOR = -0.05; // reject packages worse than this for the user's own team, fit-adjusted
export const FINDER_MY_FIT_RELAXED_FLOOR = -0.15; // fallback floor if nothing clears the strict one
