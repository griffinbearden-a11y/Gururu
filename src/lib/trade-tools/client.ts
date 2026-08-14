// Client-side logic for Vail's Trade Tools (Trade Analyzer + Trade Finder).
// Runs entirely in the browser against data baked into the page at build
// time — no network calls, no re-fetching values. Imports only from
// pure.ts (+ its own fs-free dependencies config.ts/types.ts), which is
// safe to bundle client-side.
//
// Analyzer UI: team columns of clickable player/pick cards (à la Sleeper's
// trade tool) with a running Trade Summary panel, instead of per-asset
// dropdowns. Player headshots and team avatars load straight from
// Sleeper's public CDN by ID — same convention every dynasty tool uses.
import {
  gradeTrade,
  consolidatedValue,
  fitMultiplier,
  type TeamContext,
  type TradeGradeResult,
} from '../../../scripts/lib/trade-value/pure.ts';
import {
  PACKAGE_LOOSE_PREMIUM,
  PACKAGE_TARGET_RANGE,
  FINDER_MY_FIT_FLOOR,
  FINDER_MY_FIT_RELAXED_FLOOR,
} from '../../../scripts/lib/trade-value/config.ts';
import type { Trade, TradeAsset } from '../../../scripts/lib/trade-value/types.ts';

export interface PoolAsset {
  assetId: string;
  assetType: 'player' | 'pick';
  ownerRosterId: number;
  label: string;
  position: string | null;
  nflTeam: string | null;
  age: number | null;
  category: 'pick' | 'young' | 'veteran';
  marketValue: number;
}

export interface TeamMeta {
  rosterId: number;
  teamName: string;
  avatarUrl: string | null;
}

export interface TradeToolsData {
  teams: Record<number, TeamContext>;
  teamMeta: Record<number, TeamMeta>;
  pool: PoolAsset[];
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Vail's Trade Tools: missing #${id}`);
  return el as T;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

function teamName(data: TradeToolsData, rosterId: number): string {
  return data.teamMeta[rosterId]?.teamName ?? data.teams[rosterId]?.teamName ?? `Roster ${rosterId}`;
}

// Sleeper hosts player headshots and team avatars on a predictable public
// CDN path — no key, no fetch needed, same URLs every Sleeper-based dynasty
// tool uses. Falls back to a plain initial/position badge on 404 (picks and
// some inactive players have no headshot).
function playerAvatarHtml(a: PoolAsset, sizeClass: string): string {
  if (a.assetType === 'pick') {
    return `<span class="${sizeClass} ${sizeClass}-pick">PICK</span>`;
  }
  const fallback = a.position ?? a.label.charAt(0);
  return `<span class="${sizeClass}-wrap">
    <img class="${sizeClass}" src="https://sleepercdn.com/content/nfl/players/${a.assetId}.jpg" alt="" loading="lazy"
      onerror="this.style.display='none'; this.nextElementSibling.style.removeProperty('display')" />
    <span class="${sizeClass} ${sizeClass}-fallback" style="display:none">${fallback}</span>
  </span>`;
}

function teamAvatarHtml(data: TradeToolsData, rosterId: number): string {
  const meta = data.teamMeta[rosterId];
  if (meta?.avatarUrl) {
    return `<img class="team-avatar" src="${meta.avatarUrl}" alt="" loading="lazy"
      onerror="this.style.display='none'; this.nextElementSibling.style.removeProperty('display')" />
      <span class="team-avatar team-avatar-fallback" style="display:none">${teamName(data, rosterId).charAt(0)}</span>`;
  }
  return `<span class="team-avatar team-avatar-fallback">${teamName(data, rosterId).charAt(0)}</span>`;
}

export function mount(data: TradeToolsData) {
  const poolById = new Map(data.pool.map((a) => [a.assetId, a]));
  const teamOptions = Object.values(data.teams).sort((a, b) => teamName(data, a.rosterId).localeCompare(teamName(data, b.rosterId)));

  mountAnalyzer(data, poolById, teamOptions);
  mountFinder(data, poolById, teamOptions);
  mountTabs();
}

function mountTabs() {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.trade-tab');
  const panels = document.querySelectorAll<HTMLElement>('.trade-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      panels.forEach((p) => p.toggleAttribute('hidden', p.dataset.panel !== tab.dataset.tab));
    });
  });
}

// ---------------------------------------------------------------------------
// Trade Analyzer
// ---------------------------------------------------------------------------
function mountAnalyzer(data: TradeToolsData, poolById: Map<string, PoolAsset>, teamOptions: TeamContext[]) {
  const countSelect = byId<HTMLSelectElement>('analyzer-team-count');
  const teamSelectsWrap = byId<HTMLDivElement>('analyzer-team-selects');
  const rostersWrap = byId<HTMLDivElement>('analyzer-rosters');
  const summaryWrap = byId<HTMLDivElement>('analyzer-summary');
  const gradeWrap = byId<HTMLDivElement>('analyzer-grades');

  // routing: assetId -> current destination rosterId (defaults to owner = "keep")
  const routing = new Map<string, number>();

  function teamOptionsHtml(selected: number | null): string {
    return teamOptions
      .map((t) => `<option value="${t.rosterId}" ${t.rosterId === selected ? 'selected' : ''}>${teamName(data, t.rosterId)}</option>`)
      .join('');
  }

  function selectedTeamIds(): number[] {
    return Array.from(teamSelectsWrap.querySelectorAll<HTMLSelectElement>('select'))
      .map((s) => Number(s.value))
      .filter((v) => !Number.isNaN(v));
  }

  function renderTeamSelects() {
    const count = Number(countSelect.value);
    const existing = selectedTeamIds();
    let html = '';
    for (let i = 0; i < count; i++) {
      const preselected = existing[i] ?? teamOptions[i]?.rosterId ?? null;
      html += `<label class="team-slot">Team ${i + 1}<select data-slot="${i}">${teamOptionsHtml(preselected)}</select></label>`;
    }
    teamSelectsWrap.innerHTML = html;
    teamSelectsWrap.querySelectorAll('select').forEach((s) => s.addEventListener('change', onTeamsChanged));
    onTeamsChanged();
  }

  function onTeamsChanged() {
    const ids = selectedTeamIds();
    for (const asset of data.pool) {
      if (ids.includes(asset.ownerRosterId) && !routing.has(asset.assetId)) {
        routing.set(asset.assetId, asset.ownerRosterId);
      }
    }
    refreshAll(ids);
  }

  // Clicking a card cycles it through: kept -> sent to the next selected
  // team -> ... -> kept again. For a 2-team trade this is a plain toggle;
  // for 3 teams it steps through both possible recipients.
  function cycleDestination(asset: PoolAsset, ids: number[]) {
    const others = ids.filter((id) => id !== asset.ownerRosterId);
    const current = routing.get(asset.assetId) ?? asset.ownerRosterId;
    if (current === asset.ownerRosterId) {
      routing.set(asset.assetId, others[0]);
      return;
    }
    const idx = others.indexOf(current);
    if (idx === -1 || idx === others.length - 1) {
      routing.set(asset.assetId, asset.ownerRosterId);
    } else {
      routing.set(asset.assetId, others[idx + 1]);
    }
  }

  function assetCardHtml(a: PoolAsset, rosterId: number, ids: number[]): string {
    const dest = routing.get(a.assetId) ?? rosterId;
    const selected = dest !== rosterId;
    const meta = a.assetType === 'player' ? [a.position, a.nflTeam].filter(Boolean).join(' · ') : 'Draft pick';
    return `<button type="button" class="player-card ${selected ? 'selected' : ''}" data-asset-id="${a.assetId}">
      <span class="card-check" aria-hidden="true">${selected ? '&check;' : ''}</span>
      ${playerAvatarHtml(a, 'card-avatar')}
      <span class="card-name">${a.label}</span>
      <span class="card-meta">${meta}</span>
      <span class="card-value">${fmt(a.marketValue)}</span>
      ${selected ? `<span class="card-tag">to ${teamName(data, dest)}</span>` : ''}
    </button>`;
  }

  function renderRosters(ids: number[]) {
    if (ids.length < 2 || new Set(ids).size !== ids.length) {
      rostersWrap.innerHTML = '<p class="empty">Pick 2 or 3 different teams to build a trade.</p>';
      return;
    }
    rostersWrap.innerHTML = `<div class="team-columns">${ids
      .map((rosterId) => {
        const assets = data.pool.filter((a) => a.ownerRosterId === rosterId).sort((a, b) => b.marketValue - a.marketValue);
        const cards = assets.map((a) => assetCardHtml(a, rosterId, ids)).join('');
        return `<div class="team-column">
          <div class="team-column-header">
            ${teamAvatarHtml(data, rosterId)}
            <div><h3>${teamName(data, rosterId)}</h3><p class="contention-note">${contentionLabel(data.teams[rosterId].contentionScore)}</p></div>
          </div>
          <div class="card-list">${cards}</div>
        </div>`;
      })
      .join('')}</div>`;

    rostersWrap.querySelectorAll<HTMLButtonElement>('.player-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const asset = poolById.get(btn.dataset.assetId!);
        if (!asset) return;
        cycleDestination(asset, ids);
        refreshAll(ids);
      });
    });
  }

  function summaryRowHtml(a: PoolAsset, subtitle: string): string {
    return `<div class="summary-row">
      ${playerAvatarHtml(a, 'summary-avatar')}
      <span class="summary-row-info"><strong>${a.label}</strong><span class="summary-row-sub">${subtitle}</span></span>
      <button type="button" class="summary-remove" data-asset-id="${a.assetId}" aria-label="Remove ${a.label} from trade">&times;</button>
    </div>`;
  }

  function renderSummary(ids: number[]) {
    if (ids.length < 2 || new Set(ids).size !== ids.length) {
      summaryWrap.innerHTML = '';
      return;
    }
    summaryWrap.innerHTML = `<h2 class="summary-title">Trade Summary</h2>${ids
      .map((rosterId) => {
        const sends: { asset: PoolAsset; toId: number }[] = [];
        const receives: { asset: PoolAsset; fromId: number }[] = [];
        for (const [assetId, dest] of routing.entries()) {
          const asset = poolById.get(assetId);
          if (!asset || !ids.includes(asset.ownerRosterId) || dest === asset.ownerRosterId) continue;
          if (asset.ownerRosterId === rosterId) sends.push({ asset, toId: dest });
          if (dest === rosterId) receives.push({ asset, fromId: asset.ownerRosterId });
        }
        const receivesHtml = receives.length
          ? receives.map((r) => summaryRowHtml(r.asset, `From ${teamName(data, r.fromId)}`)).join('')
          : '<p class="summary-empty">Nothing yet</p>';
        const sendsHtml = sends.length
          ? sends.map((s) => summaryRowHtml(s.asset, `To ${teamName(data, s.toId)}`)).join('')
          : '<p class="summary-empty">Nothing yet</p>';
        return `<div class="summary-team">
          <div class="summary-team-header">${teamAvatarHtml(data, rosterId)}<h4>${teamName(data, rosterId)}</h4></div>
          <div class="summary-columns">
            <div><h5>Receives</h5>${receivesHtml}</div>
            <div><h5>Sends</h5>${sendsHtml}</div>
          </div>
        </div>`;
      })
      .join('')}`;

    summaryWrap.querySelectorAll<HTMLButtonElement>('.summary-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const asset = poolById.get(btn.dataset.assetId!);
        if (asset) routing.set(asset.assetId, asset.ownerRosterId);
        refreshAll(ids);
      });
    });
  }

  function contentionLabel(score: number): string {
    if (score > 0.3) return 'Reads as a clear contender';
    if (score > 0) return 'Leans contender';
    if (score > -0.3) return 'Leans rebuilder';
    return 'Reads as a clear rebuilder';
  }

  function recomputeGrades(ids: number[]) {
    if (ids.length < 2 || new Set(ids).size !== ids.length) {
      gradeWrap.innerHTML = '';
      return;
    }
    const assets: TradeAsset[] = [];
    for (const [assetId, toRosterId] of routing.entries()) {
      const asset = poolById.get(assetId);
      if (!asset || !ids.includes(asset.ownerRosterId)) continue;
      if (toRosterId === asset.ownerRosterId) continue;
      assets.push({ assetId, assetType: asset.assetType, fromRosterId: asset.ownerRosterId, toRosterId });
    }
    if (assets.length === 0) {
      gradeWrap.innerHTML = '<p class="empty">Click cards above to add them to the trade and see grades.</p>';
      return;
    }
    const trade: Trade = { assets };
    const result = gradeTrade(trade, (a) => resolveFromPool(poolById, a), data.teams);
    gradeWrap.innerHTML = renderGradeResult(result);
  }

  function refreshAll(ids: number[]) {
    renderRosters(ids);
    renderSummary(ids);
    recomputeGrades(ids);
  }

  countSelect.addEventListener('change', renderTeamSelects);
  renderTeamSelects();
}

function resolveFromPool(poolById: Map<string, PoolAsset>, asset: TradeAsset) {
  const p = poolById.get(asset.assetId);
  return { label: p?.label ?? asset.assetId, marketValue: p?.marketValue ?? 0, category: p?.category ?? ('veteran' as const) };
}

function renderGradeResult(result: TradeGradeResult): string {
  const rows = result.teams
    .map(
      (t) => `<div class="team-grade">
        <h4>${t.teamName}</h4>
        <p class="grade-line">Market ${t.market.grade} &middot; Fit ${t.fit.grade} &rarr; <strong>${t.finalGrade}</strong></p>
        <p class="grade-detail">Market: sends ${fmt(t.market.sentValue)}, receives ${fmt(t.market.receivedValue)} (${fmtPct(t.market.delta)})</p>
        <p class="grade-detail">Fit: sends ${fmt(t.fit.sentValue)}, receives ${fmt(t.fit.receivedValue)} (${fmtPct(t.fit.delta)})</p>
      </div>`
    )
    .join('');
  return `<div class="grade-verdict"><span class="red-tag" style="background:var(--vail-blue)"><span>${result.verdict}</span></span>
    <p>${result.explanation}</p></div>
    <div class="team-grades">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Trade Finder
// ---------------------------------------------------------------------------
function mountFinder(data: TradeToolsData, poolById: Map<string, PoolAsset>, teamOptions: TeamContext[]) {
  const myTeamSelect = byId<HTMLSelectElement>('finder-my-team');
  const theirTeamSelect = byId<HTMLSelectElement>('finder-their-team');
  const targetSelect = byId<HTMLSelectElement>('finder-target');
  const untouchablesWrap = byId<HTMLDivElement>('finder-untouchables');
  const findBtn = byId<HTMLButtonElement>('finder-find-btn');
  const resultsWrap = byId<HTMLDivElement>('finder-results');

  const untouchables = new Set<string>();

  function optionsHtml(exclude: number | null): string {
    return teamOptions
      .filter((t) => t.rosterId !== exclude)
      .map((t) => `<option value="${t.rosterId}">${teamName(data, t.rosterId)}</option>`)
      .join('');
  }

  function renderTeamSelects() {
    myTeamSelect.innerHTML = optionsHtml(null);
    theirTeamSelect.innerHTML = optionsHtml(Number(myTeamSelect.value));
    renderTargetOptions();
    renderUntouchables();
  }

  function renderTargetOptions() {
    const theirId = Number(theirTeamSelect.value);
    const players = data.pool.filter((a) => a.ownerRosterId === theirId && a.assetType === 'player');
    targetSelect.innerHTML = players
      .sort((a, b) => b.marketValue - a.marketValue)
      .map((a) => `<option value="${a.assetId}">${a.label} (${fmt(a.marketValue)})</option>`)
      .join('');
  }

  function renderUntouchables() {
    const myId = Number(myTeamSelect.value);
    untouchables.clear();
    const players = data.pool.filter((a) => a.ownerRosterId === myId && a.assetType === 'player').sort((a, b) => b.marketValue - a.marketValue);
    untouchablesWrap.innerHTML = players
      .map(
        (a) => `<button type="button" class="player-card player-card-compact" data-asset-id="${a.assetId}">
          ${playerAvatarHtml(a, 'card-avatar')}
          <span class="card-name">${a.label}</span>
          <span class="card-meta">${[a.position, a.nflTeam].filter(Boolean).join(' · ')}</span>
        </button>`
      )
      .join('');
    untouchablesWrap.querySelectorAll<HTMLButtonElement>('.player-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.assetId!;
        if (untouchables.has(id)) untouchables.delete(id);
        else untouchables.add(id);
        btn.classList.toggle('selected', untouchables.has(id));
      });
    });
  }

  myTeamSelect.addEventListener('change', () => {
    theirTeamSelect.innerHTML = optionsHtml(Number(myTeamSelect.value));
    renderTargetOptions();
    renderUntouchables();
  });
  theirTeamSelect.addEventListener('change', renderTargetOptions);

  findBtn.addEventListener('click', () => {
    resultsWrap.innerHTML = findPackages();
  });

  renderTeamSelects();

  function findPackages(): string {
    const myId = Number(myTeamSelect.value);
    const theirId = Number(theirTeamSelect.value);
    const targetId = targetSelect.value;
    const targetLookup = poolById.get(targetId);
    if (!targetLookup) return '<p class="empty">Pick a target player.</p>';
    const target: PoolAsset = targetLookup;

    const myAssets = data.pool.filter((a) => a.ownerRosterId === myId && !untouchables.has(a.assetId));
    const myPlayerCount = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<string, number>;
    for (const a of myAssets) {
      if (a.assetType === 'player' && a.position && a.position in myPlayerCount) myPlayerCount[a.position]++;
    }

    const targetValue = target.marketValue;
    // The premium only biases which end of the range we lean toward when
    // ranking — it must NOT set the floor. Anchoring the floor on a
    // premium-inflated value would force every candidate to overpay by at
    // least (premium - 1) in raw market terms, making a neutral-or-better
    // outcome for the user's own team structurally impossible no matter
    // how favorable the fit adjustment is.
    const anchor = targetValue * PACKAGE_LOOSE_PREMIUM;
    const min = targetValue * PACKAGE_TARGET_RANGE.min;
    const max = targetValue * PACKAGE_TARGET_RANGE.max;

    const theirTeam = data.teams[theirId];
    const myTeam = data.teams[myId];

    type Candidate = { assets: PoolAsset[]; packageValue: number; myFitDelta: number };
    const candidates: Candidate[] = [];

    function tryCombo(combo: PoolAsset[]) {
      const packageValue = consolidatedValue(combo.map((a) => a.marketValue));
      if (packageValue < min || packageValue > max) return;
      if (!keepsLineupLegal(myPlayerCount, combo)) return;

      const myFitSent = consolidatedValue(combo.map((a) => a.marketValue * fitMultiplier(a.category, myTeam.contentionScore)));
      const myFitReceived = targetValue * fitMultiplier(target.category, myTeam.contentionScore);
      const myFitDelta = myFitSent > 0 ? (myFitReceived - myFitSent) / myFitSent : 0;

      candidates.push({ assets: combo, packageValue, myFitDelta });
    }

    for (let i = 0; i < myAssets.length; i++) {
      tryCombo([myAssets[i]]);
      for (let j = i + 1; j < myAssets.length; j++) {
        tryCombo([myAssets[i], myAssets[j]]);
        for (let k = j + 1; k < myAssets.length; k++) {
          tryCombo([myAssets[i], myAssets[j], myAssets[k]]);
        }
      }
    }

    if (candidates.length === 0) {
      return '<p class="empty">No 1-3 asset package from this roster lands in range. Try freeing up an untouchable.</p>';
    }

    let pool = candidates.filter((c) => c.myFitDelta >= FINDER_MY_FIT_FLOOR);
    let note = '';
    if (pool.length === 0) {
      pool = candidates.filter((c) => c.myFitDelta >= FINDER_MY_FIT_RELAXED_FLOOR);
      note =
        'Nothing in range grades clearly neutral-or-better for your team once fit is factored in — these come closest, but lean unfavorable.';
    }
    if (pool.length === 0) {
      pool = candidates.slice().sort((a, b) => b.myFitDelta - a.myFitDelta).slice(0, 5);
      note = "No in-range package looks good for your team, fit-adjusted — these are simply the least bad of what's available.";
    }

    const scored = pool.map((c) => ({
      ...c,
      fitScore: c.assets.reduce((sum, a) => sum + fitMultiplier(a.category, theirTeam.contentionScore), 0) / c.assets.length,
      distance: Math.abs(c.packageValue - anchor),
    }));
    scored.sort(
      (a, b) => b.myFitDelta - a.myFitDelta || a.assets.length - b.assets.length || a.distance - b.distance || b.fitScore - a.fitScore
    );

    const top5 = scored.slice(0, 5);
    const noteHtml = note ? `<p class="finder-note">${note}</p>` : '';
    return (
      noteHtml +
      top5
        .map((c, i) => {
          const trade: Trade = {
            assets: [
              ...c.assets.map((a) => ({ assetId: a.assetId, assetType: a.assetType, fromRosterId: myId, toRosterId: theirId })),
              { assetId: target.assetId, assetType: target.assetType, fromRosterId: theirId, toRosterId: myId },
            ],
          };
          const result = gradeTrade(trade, (a) => resolveFromPool(poolById, a), data.teams);
          return `<div class="finder-result">
            <h4>#${i + 1}: ${c.assets.map((a) => a.label).join(' + ')}</h4>
            ${renderFinderResult(result, myId, c.packageValue, targetValue, target.label)}
          </div>`;
        })
        .join('')
    );
  }
}

function renderFinderResult(
  result: TradeGradeResult,
  myRosterId: number,
  packageValue: number,
  targetValue: number,
  targetLabel: string
): string {
  const mine = result.teams.find((t) => t.rosterId === myRosterId)!;
  const theirs = result.teams.find((t) => t.rosterId !== myRosterId)!;
  const overMarket = targetValue > 0 ? (packageValue - targetValue) / targetValue : 0;
  const costNote =
    overMarket > 0.02
      ? `${fmtPct(overMarket)} over ${targetLabel}'s market value — typical for prying loose a player who isn't being shopped.`
      : `right around ${targetLabel}'s market value.`;

  return `
    <div class="finder-headline">
      <span class="fit-badge ${gradeClass(mine.fit.grade)}">${mine.fit.grade}</span>
      <span class="fit-badge-label">Fit for your team</span>
    </div>
    <p class="grade-detail">Package value ${fmt(packageValue)} for ${targetLabel} (${fmt(targetValue)}) — ${costNote}</p>
    <div class="finder-sides">
      <div><strong>Your side:</strong> Market ${mine.market.grade} &middot; Fit ${mine.fit.grade} (${fmtPct(mine.fit.delta)})</div>
      <div><strong>Their side:</strong> Market ${theirs.market.grade} &middot; Fit ${theirs.fit.grade} (${fmtPct(theirs.fit.delta)})</div>
    </div>`;
}

function gradeClass(grade: string): string {
  const base = grade[0];
  if (base === 'A' || base === 'B') return 'grade-good';
  if (base === 'C') return 'grade-mid';
  return 'grade-bad';
}

function keepsLineupLegal(myPlayerCount: Record<string, number>, combo: PoolAsset[]): boolean {
  const remaining = { ...myPlayerCount };
  for (const a of combo) {
    if (a.assetType === 'player' && a.position && a.position in remaining) remaining[a.position]--;
  }
  if (remaining.QB < 1) return false;
  if (remaining.RB < 2) return false;
  if (remaining.WR < 2) return false;
  if (remaining.TE < 1) return false;
  if (remaining.RB + remaining.WR + remaining.TE < 7) return false; // 2 RB + 2 WR + 1 TE + 2 FLEX
  return true;
}
