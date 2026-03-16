import { switchMode } from './mode';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { setOrientation, setBoardFen, setViewOnly } from './board';
import { pushKeyLayer, popKeyLayer } from './keyboard';
import {
  getPersonalConfig, getPersonalGames, queryPersonalExplorer, hasPersonalData,
  getPersonalStats, getPersonalFilters, setPersonalFilters, queryPersonalMoveGameIndices, refreshChesscomStats,
  importFromLichess, importFromChesscom,
  type GameMeta, type PersonalConfig, type PersonalFilters,
} from './personal-explorer';
import {
  generateReport,
  buildTimeControlStats,
  buildRatingTrends,
  type OpeningFamily,
  type OpeningLine,
  type ReportData,
  type MonthlyRating,
  type SideFamilyReport,
  type WDL,
} from './report';
import { findOpeningByFen } from './opening-index';
import { loadConfig } from './config';
import { isMoveLocked, getLockedMoves } from './repertoire';
import type { MoveHistoryEntry } from './types';

type ReportNavigateCallback = (
  moves: MoveHistoryEntry[],
  fen: string,
  orientation: 'white' | 'black',
  filters: PersonalFilters,
) => void;

let reportNavigateCallback: ReportNavigateCallback | null = null;

export function setReportNavigateCallback(cb: ReportNavigateCallback): void {
  reportNavigateCallback = cb;
}

let reportOpen = false;
let reportContentBuilt = false;
let lastBuildGameCount = -1;
let savedFilters: PersonalFilters = {};
let reportFilters: ReportFilters = {};
let reportCurrentRating: number | null = null;
let reportCurrentRatingInfo: { timeClass: string; current: number; best: number | null } | null = null;
let lastReportData: ReportData | null = null;
let ratingTrendsByTC: Map<string, MonthlyRating[]> = new Map();
const CURRENT_RATING_WINDOW = 100;
const CURRENT_RATING_RANGE = CURRENT_RATING_WINDOW * 2;
const BAR_PCT_LABEL_ATTR = 'data-pct-label';
const MIDDLE_TRUNCATE_ATTR = 'data-middle-truncate';

let reportPctLabelFitRaf: number | null = null;
let reportPctLabelResizeBound = false;
let filtersExpanded = false;

const TC_ORDER = ['bullet', 'blitz', 'rapid', 'classical'] as const;

function currentRatingBounds(rating: number): { min: number; max: number } {
  const stats = getPersonalStats();
  const floor = stats?.minRating ?? 0;
  const ceil = stats?.maxRating ?? 3000;
  let min = rating - CURRENT_RATING_WINDOW;
  let max = rating + CURRENT_RATING_WINDOW;
  if (max > ceil) { max = ceil; min = ceil - CURRENT_RATING_RANGE; }
  if (min < floor) { min = floor; max = floor + CURRENT_RATING_RANGE; }
  return { min, max };
}

function setBarPctLabel(segment: HTMLElement, pct: number): void {
  const label = `${Math.round(pct)}%`;
  segment.setAttribute(BAR_PCT_LABEL_ATTR, label);
  segment.textContent = label;
}

function fitBarPctLabels(root: ParentNode): void {
  const segments = root.querySelectorAll<HTMLElement>(`[${BAR_PCT_LABEL_ATTR}]`);
  for (const segment of segments) {
    const label = segment.getAttribute(BAR_PCT_LABEL_ATTR) ?? '';
    if (!label) {
      segment.textContent = '';
      continue;
    }
    segment.textContent = label;
    if (segment.scrollWidth > segment.clientWidth) {
      segment.textContent = '';
    }
  }
}

function setMiddleTruncateText(el: HTMLElement, text: string): void {
  el.setAttribute(MIDDLE_TRUNCATE_ATTR, text);
  el.textContent = text;
}

function clearMiddleTruncateText(el: HTMLElement, text: string): void {
  el.removeAttribute(MIDDLE_TRUNCATE_ATTR);
  el.textContent = text;
}

function fitMiddleTruncateLabels(root: ParentNode): void {
  const labels = root.querySelectorAll<HTMLElement>(`[${MIDDLE_TRUNCATE_ATTR}]`);
  for (const label of labels) {
    const full = label.getAttribute(MIDDLE_TRUNCATE_ATTR) ?? '';
    if (!full) {
      label.textContent = '';
      continue;
    }
    label.textContent = full;
    const available = label.clientWidth;
    if (available <= 0 || label.scrollWidth <= available) continue;
    if (full.length <= 1) {
      label.textContent = '…';
      continue;
    }

    const ellipsis = '…';
    let low = 1;
    let high = full.length - 1;
    let best = ellipsis;

    while (low <= high) {
      const keep = Math.floor((low + high) / 2);
      const leftCount = Math.ceil(keep / 2);
      const rightCount = Math.floor(keep / 2);
      const left = full.slice(0, leftCount);
      const right = rightCount > 0 ? full.slice(full.length - rightCount) : '';
      const candidate = `${left}${ellipsis}${right}`;
      label.textContent = candidate;
      if (label.scrollWidth <= available) {
        best = candidate;
        low = keep + 1;
      } else {
        high = keep - 1;
      }
    }

    label.textContent = best;
  }
}

function scheduleReportPctLabelFit(): void {
  if (reportPctLabelFitRaf != null) cancelAnimationFrame(reportPctLabelFitRaf);
  reportPctLabelFitRaf = requestAnimationFrame(() => {
    reportPctLabelFitRaf = null;
    const page = document.getElementById('report-page');
    if (!page || !reportOpen) return;
    fitBarPctLabels(page);
    fitMiddleTruncateLabels(page);
  });
}

function ensureReportPctLabelResizeBinding(): void {
  if (reportPctLabelResizeBound) return;
  reportPctLabelResizeBound = true;
  window.addEventListener('resize', () => {
    if (!reportOpen) return;
    scheduleReportPctLabelFit();
  });
}

// Line navigation state
let selectedLine: OpeningLine | null = null;
let lineViewIndex = 0;           // 0 = starting pos, moves.length = end pos
let lineFens: string[] = [];     // FEN at each ply (index 0 = starting, length = moves.length + 1)
let lineLastMoves: (Key[] | undefined)[] = []; // lastMove highlight per ply
let theoryOverlayEl: HTMLElement | null = null;
let lineGameResultFilter: 'all' | 'win' | 'draw' | 'loss' = 'all';
const MAX_PRIORITY_FAMILY_CARDS = 4;

interface ReportFilters {
  timeClasses?: string[];
  minRating?: number;
  maxRating?: number;
  sinceDate?: string;
  untilDate?: string;
  color?: 'white' | 'black';
}

export function isReportPageOpen(): boolean {
  return reportOpen;
}


export function closeReportPage(): void {
  if (!reportOpen) return;
  reportOpen = false;
  popKeyLayer('report');
  // Restore explorer filters
  setPersonalFilters(savedFilters);
  // Restore board interactivity
  setViewOnly(false);
  // Hide topbar stats button in trainer mode
  document.querySelector('.nav-stats-btn')?.classList.add('hidden');
  // Don't destroy content — just mark as closed.
  // The CSS mode classes handle visibility via .trainer-only / .report-only crossfade.
}

function handleReportKeydown(e: KeyboardEvent): boolean {
  if (!reportOpen) return false;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;

  if (e.key === 'Escape' || e.key === '1') {
    if (e.key === 'Escape' && closeStatsModalIfOpen()) return true;
    if (e.key === 'Escape' && closeTheoryModalIfOpen()) return true;
    switchMode('trainer');
    return true;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateLine(-1);
    return true;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigateLine(1);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (selectedLine) { lineViewIndex = 0; updateBoardForLine(); }
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (selectedLine) { lineViewIndex = lineFens.length - 1; updateBoardForLine(); }
    return true;
  }
  return false;
}

export async function openReportPage(): Promise<void> {
  if (reportOpen) return;
  reportOpen = true;
  pushKeyLayer('report', handleReportKeydown);
  savedFilters = getPersonalFilters();
  setViewOnly(true);

  // If content is already built and game count hasn't changed, just restore state
  const currentGameCount = getPersonalGames()?.length ?? 0;
  if (reportContentBuilt && currentGameCount === lastBuildGameCount) {
    syncExplorerFilters(reportFilters);
    wireNavStatsButton();
    if (selectedLine) {
      setOrientation(selectedLine.color);
      updateBoardForLine();
    }
    return;
  }

  // Full build: compute filters and render from scratch
  const appConfig = loadConfig();
  let explorerConfig = getPersonalConfig();
  if (explorerConfig?.platform === 'chesscom') {
    try {
      await refreshChesscomStats();
      explorerConfig = getPersonalConfig();
    } catch {
      // Best effort only; continue with cached stats.
    }
  }
  reportCurrentRatingInfo = inferCurrentRatingInfo(explorerConfig, appConfig.speeds);
  reportCurrentRating = reportCurrentRatingInfo?.current
    ?? inferCurrentRating(getPersonalGames() ?? [], appConfig.speeds, explorerConfig);
  reportFilters = {
    timeClasses: [...appConfig.speeds],
    minRating: reportCurrentRating != null ? currentRatingBounds(reportCurrentRating).min : undefined,
    maxRating: reportCurrentRating != null ? currentRatingBounds(reportCurrentRating).max : undefined,
  };

  const page = document.getElementById('report-page')!;
  const detail = document.getElementById('report-detail')!;
  const boardControls = document.getElementById('report-board-controls')!;
  page.innerHTML = '';
  detail.innerHTML = '';
  boardControls.innerHTML = '';
  ensureReportPctLabelResizeBinding();

  const config = explorerConfig;
  const games = getPersonalGames();

  if (!hasPersonalData() || !games || !config) {
    renderEmptyState(page, detail);
    reportContentBuilt = true;
    lastBuildGameCount = 0;
    return;
  }

  renderPage(page, games, config.username);
  reportContentBuilt = true;
  lastBuildGameCount = games.length;
}

function renderEmptyState(page: HTMLElement, detail: HTMLElement): void {
  detail.innerHTML = '';
  document.getElementById('report-board-controls')!.innerHTML = '';
  page.innerHTML = `
    <div class="report-content">
      <div class="report-empty">
        <p>No games imported yet.</p>
        <p>Import your games to generate a report of your openings.</p>
        <div class="report-import-form">
          <div class="report-import-platform">
            <button class="segment-btn selected" data-platform="lichess">Lichess</button>
            <button class="segment-btn" data-platform="chesscom">Chess.com</button>
          </div>
          <div class="report-import-row">
            <input id="report-import-username" type="text" placeholder="Chess username" autocomplete="off" data-1p-ignore class="report-import-input" />
            <button id="report-import-btn" class="btn btn-primary">Import</button>
          </div>
          <div id="report-import-months" class="report-import-months hidden">
            <span class="personal-range-text">Last</span>
            <input id="report-months-input" type="number" min="1" max="999" placeholder="All" class="personal-months-input" />
            <span class="personal-range-text">months</span>
          </div>
          <div id="report-import-progress" class="report-import-progress hidden">
            <div class="personal-progress-bar"><div class="personal-progress-fill indeterminate"></div></div>
            <div class="report-import-progress-text"></div>
          </div>
          <div id="report-import-result" class="report-import-result"></div>
        </div>
      </div>
    </div>
  `;
  let platform: 'lichess' | 'chesscom' = 'lichess';
  const monthsRow = page.querySelector('#report-import-months')!;

  page.querySelectorAll('.report-import-platform .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      platform = (btn as HTMLElement).dataset.platform as 'lichess' | 'chesscom';
      page.querySelectorAll('.report-import-platform .segment-btn').forEach(b =>
        b.classList.toggle('selected', b === btn)
      );
      monthsRow.classList.toggle('hidden', platform !== 'chesscom');
    });
  });

  const importBtn = page.querySelector('#report-import-btn') as HTMLButtonElement;
  const usernameInput = page.querySelector('#report-import-username') as HTMLInputElement;
  const progressEl = page.querySelector('#report-import-progress')!;
  const progressText = page.querySelector('.report-import-progress-text')!;
  const resultEl = page.querySelector('#report-import-result')!;

  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
  importBtn.addEventListener('click', doImport);

  let abortController: AbortController | null = null;

  async function doImport(): Promise<void> {
    const username = usernameInput.value.trim();
    if (!username) {
      resultEl.textContent = 'Please enter a username.';
      resultEl.className = 'report-import-result error';
      return;
    }

    importBtn.disabled = true;
    resultEl.textContent = '';
    resultEl.className = 'report-import-result';
    progressEl.classList.remove('hidden');
    abortController = new AbortController();

    const onProgress = (msg: string, count: number) => {
      progressText.textContent = `${msg} (${formatNum(count)} games)`;
    };

    try {
      let total: number;
      if (platform === 'lichess') {
        total = await importFromLichess(username, onProgress, abortController.signal);
      } else {
        const monthsVal = (page.querySelector('#report-months-input') as HTMLInputElement).value.trim();
        const maxMonths = monthsVal ? parseInt(monthsVal, 10) : undefined;
        total = await importFromChesscom(username, onProgress, abortController.signal, maxMonths && maxMonths > 0 ? maxMonths : undefined);
      }
      progressEl.classList.add('hidden');
      importBtn.disabled = false;
      resultEl.textContent = `Imported ${formatNum(total)} games.`;
      resultEl.className = 'report-import-result success';
      // Re-render the report page with data
      reportOpen = false;  // Allow openReportPage to re-enter
      reportContentBuilt = false;  // Force full rebuild with new data
      setTimeout(() => openReportPage(), 500);
    } catch (e) {
      progressEl.classList.add('hidden');
      importBtn.disabled = false;
      const msg = e instanceof Error ? e.message : 'Import failed';
      resultEl.textContent = msg;
      resultEl.className = 'report-import-result error';
    }
  }
}

// ── Filter Logic ──

function filterGames(games: readonly GameMeta[], filters: ReportFilters): GameMeta[] {
  if (!hasActiveFilters(filters)) return [...games];
  return games.filter(g => gameMatchesReportFilters(g, filters));
}

function filterGameIndices(games: readonly GameMeta[], filters: ReportFilters): number[] {
  if (!hasActiveFilters(filters)) return games.map((_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < games.length; i++) {
    if (gameMatchesReportFilters(games[i], filters)) out.push(i);
  }
  return out;
}

function gameMatchesReportFilters(g: GameMeta, filters: ReportFilters): boolean {
  if (filters.timeClasses && filters.timeClasses.length > 0) {
    if (!filters.timeClasses.includes(g.tc)) return false;
  }
  if (filters.minRating != null && g.ur < filters.minRating) return false;
  if (filters.maxRating != null && g.ur > filters.maxRating) return false;
  const dateKey = gameDateSortKey(g);
  if (filters.sinceDate && (!dateKey || dateKey < filters.sinceDate)) return false;
  if (filters.untilDate && (!dateKey || dateKey > filters.untilDate)) return false;
  if (filters.color === 'white' && !g.uw) return false;
  if (filters.color === 'black' && g.uw) return false;
  return true;
}

function hasActiveFilters(f: ReportFilters): boolean {
  return !!(
    (f.timeClasses && f.timeClasses.length > 0) ||
    f.minRating != null ||
    f.maxRating != null ||
    f.sinceDate ||
    f.untilDate ||
    f.color
  );
}

function gameDateSortKey(game: GameMeta): string | null {
  if (game.da && game.da !== 'unknown') return game.da;
  if (game.mo && game.mo !== 'unknown') return `${game.mo}-01`;
  return null;
}

function inferCurrentRating(
  games: readonly GameMeta[],
  preferredTimeClasses: string[],
  personalConfig: PersonalConfig | null,
): number | null {
  const snapshotInfo = inferCurrentRatingInfo(personalConfig, preferredTimeClasses);
  if (snapshotInfo) {
    return snapshotInfo.current;
  }

  const validAll = games.filter(g => g.ur > 0);
  if (validAll.length === 0) return null;

  // Use the latest imported user rating. Prefer configured time classes if available.
  if (preferredTimeClasses.length > 0) {
    for (let i = validAll.length - 1; i >= 0; i--) {
      if (preferredTimeClasses.includes(validAll[i].tc)) {
        return Math.round(validAll[i].ur);
      }
    }
  }

  return Math.round(validAll[validAll.length - 1].ur);
}

function inferCurrentRatingInfo(
  personalConfig: PersonalConfig | null,
  preferredTimeClasses: string[],
): { timeClass: string; current: number; best: number | null } | null {
  const statsSnapshot = personalConfig?.platform === 'chesscom'
    ? personalConfig.chesscomStats
    : undefined;
  if (!statsSnapshot) return null;

  const ratings = statsSnapshot.timeClassRatings;

  // Pick the preferred TC with the highest current rating
  let best: { timeClass: string; current: number; best: number | null } | null = null;
  const candidates = preferredTimeClasses.length > 0
    ? preferredTimeClasses
    : ['rapid', 'blitz', 'bullet', 'classical', 'daily'];
  for (const tc of candidates) {
    const mode = ratings[tc as keyof typeof ratings];
    if (mode?.currentRating != null && mode.currentRating > 0) {
      const cur = Math.round(mode.currentRating);
      if (!best || cur > best.current) {
        best = {
          timeClass: tc,
          current: cur,
          best: mode.bestRating != null ? Math.round(mode.bestRating) : null,
        };
      }
    }
  }
  if (best) return best;
  return null;
}

function isUsingCurrentRatingWindow(filters: ReportFilters): boolean {
  if (reportCurrentRating == null) return false;
  const b = currentRatingBounds(reportCurrentRating);
  return filters.minRating === b.min && filters.maxRating === b.max;
}

function syncExplorerFilters(filters: ReportFilters): void {
  // Set global personal explorer filters to match report filters
  // so queryPersonalExplorer returns matching data for the opening walk
  setPersonalFilters({
    timeClasses: filters.timeClasses,
    minRating: filters.minRating,
    maxRating: filters.maxRating,
    sinceDate: filters.sinceDate,
    untilDate: filters.untilDate,
    color: filters.color,
  });
}

// ── Page Rendering ──

function renderPage(page: HTMLElement, allGames: readonly GameMeta[], username: string): void {
  page.innerHTML = '';
  const detail = document.getElementById('report-detail')!;
  detail.innerHTML = '';

  // Filter bar
  renderFilterBar(page, allGames, username);

  // Report content
  const filtered = filterGames(allGames, reportFilters);
  syncExplorerFilters(reportFilters);

  const content = el('div', 'report-content');
  content.id = 'report-content';
  page.append(content);

  if (filtered.length === 0) {
    const empty = el('div', 'report-empty');
    empty.innerHTML = '<p>No games match the current filters.</p>';
    content.append(empty);
    return;
  }

  if (filtered.length < 10) {
    const note = el('div', 'report-note');
    note.textContent = 'Limited data — adjust filters or import more games for detailed analysis.';
    content.append(note);
  }

  const report = generateReport(filtered, queryPersonalExplorer, (color) => {
    setPersonalFilters({
      timeClasses: reportFilters.timeClasses,
      minRating: reportFilters.minRating,
      maxRating: reportFilters.maxRating,
      sinceDate: reportFilters.sinceDate,
      untilDate: reportFilters.untilDate,
      color: color ?? undefined,
    });
  }, queryPersonalMoveGameIndices, (idx) => allGames[idx], reportFilters.color, 'position');
  // Use unfiltered games for time control breakdown and rating trends
  report.byTimeControl = buildTimeControlStats(allGames);
  ratingTrendsByTC = buildRatingTrends(allGames);
  // Restore filters without color constraint after report generation
  syncExplorerFilters(reportFilters);
  renderReportContent(content, detail, report);

  // Keyboard is handled by the central dispatcher in main.ts
  scheduleReportPctLabelFit();
}

function rerender(): void {
  const page = document.getElementById('report-page');
  const config = getPersonalConfig();
  const games = getPersonalGames();
  if (!page || !config || !games) return;
  renderPage(page, games, config.username);
}

async function refreshImportedGames(
  onProgress: (msg: string, count: number) => void,
): Promise<number> {
  const cfg = getPersonalConfig();
  if (!cfg) throw new Error('No import configuration found.');

  if (cfg.platform === 'lichess') {
    return importFromLichess(cfg.username, onProgress);
  }

  return importFromChesscom(cfg.username, onProgress);
}

// ── Filter Bar ──

/** Compact time-control label: range notation if contiguous, comma-separated otherwise.
 *  Always shows when there's an explicit selection — these are the most important filter. */
function compactTimeLabel(selected: string[] | undefined, visible: string[]): string | null {
  const active = selected && selected.length > 0 ? selected : visible;
  if (active.length === 0) return null;
  if (active.length === 1) return capitalize(active[0]);

  // Map to ordered indices
  const indices = active
    .map(tc => TC_ORDER.indexOf(tc as typeof TC_ORDER[number]))
    .filter(i => i >= 0)
    .sort((a, b) => a - b);

  if (indices.length < 2) return active.map(capitalize).join(', ');

  // Check if contiguous
  const isContiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
  if (isContiguous) {
    return `${capitalize(TC_ORDER[indices[0]])} – ${capitalize(TC_ORDER[indices[indices.length - 1]])}`;
  }
  return active.map(capitalize).join(', ');
}

function compactDateLabel(filters: ReportFilters): string | null {
  if (!filters.sinceDate && !filters.untilDate) return null; // "All time" — don't show

  const stats = getPersonalStats();
  if (!stats?.maxDate) return null;

  // Replicate the same preset computation used in the filter bar
  const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayYmd = toYmd(new Date());
  const rangeEndYmd = stats.maxDate < todayYmd ? stats.maxDate : todayYmd;
  const [ry, rm, rd] = rangeEndYmd.split('-').map(Number);
  const rangeEndDate = new Date(ry, rm - 1, rd);
  const monthsAgo = (n: number) => {
    const d = new Date(rangeEndDate);
    d.setMonth(rangeEndDate.getMonth() - n);
    return toYmd(d);
  };

  const presets: [string, number][] = [['12m', 12], ['3m', 3], ['1m', 1]];
  for (const [label, months] of presets) {
    if (filters.sinceDate === monthsAgo(months) && filters.untilDate === rangeEndYmd) {
      return `Last ${label}`;
    }
  }

  // Custom range
  const since = filters.sinceDate ?? '…';
  const until = filters.untilDate ?? '…';
  return `${since} – ${until}`;
}

function compactRatingLabel(filters: ReportFilters): string | null {
  if (filters.minRating == null && filters.maxRating == null) return null;
  const min = filters.minRating ?? '…';
  const max = filters.maxRating ?? '…';
  return `${min}–${max}`;
}

function renderFilterSummary(
  container: HTMLElement,
  allGames: readonly GameMeta[],
): void {
  const stats = getPersonalStats();
  const summary = el('div', 'report-filter-summary');

  const title = el('span', 'report-filter-title');
  title.textContent = 'Filters';
  summary.append(title);

  const pills: string[] = [];
  const visibleTC = stats ? stats.timeClasses.filter(tc => tc !== 'unknown') : [];
  const tcLabel = compactTimeLabel(reportFilters.timeClasses, visibleTC);
  if (tcLabel) pills.push(tcLabel);

  const ratingLabel = compactRatingLabel(reportFilters);
  if (ratingLabel) pills.push(ratingLabel);

  const dateLabel = compactDateLabel(reportFilters);
  if (dateLabel) pills.push(dateLabel);

  const sideLabel = reportFilters.color ? capitalize(reportFilters.color) : null;
  if (sideLabel) pills.push(sideLabel);

  const pillsWrap = el('div', 'report-filter-pills');
  if (pills.length === 0) {
    const allLabel = el('span', 'report-filter-pill muted');
    allLabel.textContent = 'All games';
    pillsWrap.append(allLabel);
  } else {
    for (const p of pills) {
      const pill = el('span', 'report-filter-pill');
      pill.textContent = p;
      pillsWrap.append(pill);
    }
  }
  summary.append(pillsWrap);

  const toggle = el('button', 'btn icon');
  toggle.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>`;
  toggle.title = 'Edit filters';
  toggle.addEventListener('click', () => {
    filtersExpanded = true;
    rerender();
  });
  summary.append(toggle);

  container.append(summary);
}

function renderFilterBar(page: HTMLElement, allGames: readonly GameMeta[], _username: string): void {
  const stats = getPersonalStats();
  if (!stats) return;

  const wrapper = el('div', 'report-filter-wrapper');
  renderFilterSummary(wrapper, allGames);

  if (filtersExpanded) {
    // Backdrop to close on outside click
    const backdrop = el('div', 'report-filter-backdrop');
    backdrop.addEventListener('click', () => {
      filtersExpanded = false;
      rerender();
    });
    wrapper.append(backdrop);

    const popover = el('div', 'report-filter-popover');
    const bar = el('div', 'report-filter-bar');
    popover.append(bar);
    wrapper.append(popover);
  }

  page.append(wrapper);
  if (!filtersExpanded) return;

  // bar is inside popover — grab it back for building
  const bar = wrapper.querySelector('.report-filter-bar') as HTMLElement;

  // Time control chips
  const visibleTimeClasses = stats.timeClasses.filter(tc => tc !== 'unknown');
  if (visibleTimeClasses.length > 1) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Time';
    group.append(label);

    const activeTC = reportFilters.timeClasses ?? [];
    for (const tc of visibleTimeClasses) {
      const chip = el('button', 'chip chip-sm');
      if (activeTC.length === 0 || activeTC.includes(tc)) chip.classList.add('selected');
      chip.dataset.tc = tc;
      chip.textContent = capitalize(tc);
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        applyFiltersFromBar(bar);
      });
      group.append(chip);
    }
    bar.append(group);
  }

  // Date range + presets
  if (stats.minDate && stats.maxDate) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Date';
    group.append(label);

    const today = new Date();
    const parseYmd = (ymd: string): Date => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayYmd = toYmd(today);
    const rangeEndYmd = stats.maxDate < todayYmd ? stats.maxDate : todayYmd;
    const rangeEnd = parseYmd(rangeEndYmd);
    const monthsAgo = (n: number) => {
      const d = new Date(rangeEnd);
      d.setMonth(rangeEnd.getMonth() - n);
      return toYmd(d);
    };

    const presets = [
      { label: 'All time', since: '', until: '' },
      { label: '12m', since: monthsAgo(12), until: rangeEndYmd },
      { label: '3m', since: monthsAgo(3), until: rangeEndYmd },
      { label: '1m', since: monthsAgo(1), until: rangeEndYmd },
    ];

    const currentSince = reportFilters.sinceDate ?? '';
    const currentUntil = reportFilters.untilDate ?? '';
    const matchesPreset = presets.some(p => p.since === currentSince && p.until === currentUntil);
    const isCustom = !matchesPreset && (currentSince !== '' || currentUntil !== '');

    const segment = el('div', 'segment-picker segment-sm') as HTMLDivElement;
    segment.setAttribute('role', 'radiogroup');
    segment.setAttribute('aria-label', 'Date range period');

    for (const preset of presets) {
      const segmentBtn = el('button', 'segment-btn') as HTMLButtonElement;
      segmentBtn.type = 'button';
      segmentBtn.dataset.since = preset.since;
      segmentBtn.dataset.until = preset.until;
      const isActive = !isCustom && currentSince === preset.since && currentUntil === preset.until;
      if (isActive) segmentBtn.classList.add('selected');
      segmentBtn.textContent = preset.label;
      segmentBtn.setAttribute('role', 'radio');
      segmentBtn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      segmentBtn.tabIndex = isActive ? 0 : -1;
      segmentBtn.addEventListener('click', () => {
        if (!isCustom && currentSince === preset.since && currentUntil === preset.until) return;
        reportFilters.sinceDate = preset.since || undefined;
        reportFilters.untilDate = preset.until || undefined;
        rerender();
      });
      segment.append(segmentBtn);
    }

    // Custom button
    const customBtn = el('button', 'segment-btn') as HTMLButtonElement;
    customBtn.type = 'button';
    customBtn.textContent = 'Custom';
    if (isCustom) customBtn.classList.add('selected');
    customBtn.setAttribute('role', 'radio');
    customBtn.setAttribute('aria-checked', isCustom ? 'true' : 'false');
    customBtn.tabIndex = isCustom ? 0 : -1;
    customBtn.dataset.custom = 'true';
    customBtn.addEventListener('click', () => {
      if (isCustom) return;
      // Switch to custom mode — keep current dates but mark as custom
      reportFilters.sinceDate = reportFilters.sinceDate ?? monthsAgo(3);
      reportFilters.untilDate = reportFilters.untilDate ?? rangeEndYmd;
      // Nudge a day so it won't match any preset
      const since = parseYmd(reportFilters.sinceDate);
      since.setDate(since.getDate() + 1);
      reportFilters.sinceDate = toYmd(since);
      rerender();
    });
    segment.append(customBtn);
    group.append(segment);

    const dateInputsWrapper = el('div', 'report-filter-date-inputs');
    if (!isCustom) dateInputsWrapper.classList.add('hidden');

    const fromInput = document.createElement('input');
    fromInput.type = 'date';
    fromInput.className = 'report-filter-input report-filter-date';
    fromInput.min = stats.minDate;
    fromInput.max = stats.maxDate;
    fromInput.value = reportFilters.sinceDate ?? '';
    fromInput.title = 'From date';

    const sep = el('span', 'report-filter-sep');
    sep.textContent = '–';

    const toInput = document.createElement('input');
    toInput.type = 'date';
    toInput.className = 'report-filter-input report-filter-date';
    toInput.min = stats.minDate;
    toInput.max = stats.maxDate;
    toInput.value = reportFilters.untilDate ?? '';
    toInput.title = 'To date';

    const applyDateInputs = () => {
      reportFilters.sinceDate = fromInput.value || undefined;
      reportFilters.untilDate = toInput.value || undefined;
      rerender();
    };
    fromInput.addEventListener('change', applyDateInputs);
    toInput.addEventListener('change', applyDateInputs);

    dateInputsWrapper.append(fromInput, sep, toInput);
    group.append(dateInputsWrapper);
    bar.append(group);
  }

  // Side filter (white/black/both)
  const hasWhiteGames = allGames.some(g => g.uw);
  const hasBlackGames = allGames.some(g => !g.uw);
  if (hasWhiteGames && hasBlackGames) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Side';
    group.append(label);

    const sideSegment = el('div', 'segment-picker segment-sm') as HTMLDivElement;
    sideSegment.setAttribute('role', 'radiogroup');
    sideSegment.setAttribute('aria-label', 'Side filter');

    const sideOptions: { label: string; value: string | undefined }[] = [
      { label: 'Both', value: undefined },
      { label: 'White', value: 'white' },
      { label: 'Black', value: 'black' },
    ];

    for (const opt of sideOptions) {
      const btn = el('button', 'segment-btn') as HTMLButtonElement;
      btn.type = 'button';
      btn.textContent = opt.label;
      const isActive = reportFilters.color === opt.value;
      if (isActive) btn.classList.add('selected');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      btn.tabIndex = isActive ? 0 : -1;
      btn.addEventListener('click', () => {
        if (reportFilters.color === opt.value) return;
        reportFilters.color = opt.value as 'white' | 'black' | undefined;
        rerender();
      });
      sideSegment.append(btn);
    }

    group.append(sideSegment);
    bar.append(group);
  }

  // Rating range
  if (stats.minRating < stats.maxRating) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Rating';
    group.append(label);

    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.className = 'report-filter-input';
    minInput.placeholder = String(stats.minRating);
    if (reportFilters.minRating != null) minInput.value = String(reportFilters.minRating);

    const sep = el('span', 'report-filter-sep');
    sep.textContent = '–';

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.className = 'report-filter-input';
    maxInput.placeholder = String(stats.maxRating);
    if (reportFilters.maxRating != null) maxInput.value = String(reportFilters.maxRating);

    const applyRating = () => {
      reportFilters.minRating = minInput.value ? parseInt(minInput.value) : undefined;
      reportFilters.maxRating = maxInput.value ? parseInt(maxInput.value) : undefined;
      rerender();
    };
    minInput.addEventListener('change', applyRating);
    maxInput.addEventListener('change', applyRating);

    const currentRating = reportCurrentRating;
    if (currentRating != null) {
      const relevantChip = el('button', 'chip chip-sm') as HTMLButtonElement;
      relevantChip.textContent = 'Relevant';
      relevantChip.setAttribute(
        'data-tooltip',
        `Relevant: filter rating range to your current rating ±${CURRENT_RATING_WINDOW}.`,
      );
      relevantChip.classList.add('tooltip-wide');
      if (isUsingCurrentRatingWindow(reportFilters)) relevantChip.classList.add('selected');

      relevantChip.addEventListener('click', () => {
        if (isUsingCurrentRatingWindow(reportFilters)) {
          reportFilters.minRating = undefined;
          reportFilters.maxRating = undefined;
        } else {
          const b = currentRatingBounds(currentRating);
          reportFilters.minRating = b.min;
          reportFilters.maxRating = b.max;
        }
        rerender();
      });
      group.append(minInput, sep, maxInput, relevantChip);
    } else {
      group.append(minInput, sep, maxInput);
    }

    bar.append(group);
  }

  // Action buttons (right-aligned)
  const actions = el('div', 'report-filter-actions');

  if (hasActiveFilters(reportFilters)) {
    const resetBtn = el('button', 'btn sm ghost');
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      reportFilters = {
        timeClasses: undefined,
        minRating: reportCurrentRating != null ? currentRatingBounds(reportCurrentRating).min : undefined,
        maxRating: reportCurrentRating != null ? currentRatingBounds(reportCurrentRating).max : undefined,
        color: undefined,
      };
      rerender();
    });
    actions.append(resetBtn);
  }

  const doneBtn = el('button', 'btn sm') as HTMLButtonElement;
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => {
    filtersExpanded = false;
    rerender();
  });
  actions.append(doneBtn);

  bar.append(actions);
}

function applyFiltersFromBar(bar: HTMLElement): void {
  // Collect time class chips
  const allChips = bar.querySelectorAll('.chip[data-tc]');
  const selectedChips = bar.querySelectorAll('.chip[data-tc].selected');
  if (selectedChips.length > 0 && selectedChips.length < allChips.length) {
    reportFilters.timeClasses = Array.from(selectedChips).map(c => (c as HTMLElement).dataset.tc!);
  } else {
    reportFilters.timeClasses = undefined;
  }

  rerender();
}

// ── Report Content (below filters) ──

function renderReportContent(content: HTMLElement, detail: HTMLElement, report: ReportData): void {
  lastReportData = report;
  wireNavStatsButton();
  theoryOverlayEl = null;
  renderTheoryModal(content);

  // Summary line
  renderSummaryLine(content, report);

  // Main body: opening families list (left sidebar only)
  const body = el('div', 'report-body');
  content.append(body);

  const mainCol = el('div', 'report-main-col');
  body.append(mainCol);

  renderCombinedPriorityFamilies(mainCol, report);
  if (report.whiteFamilyReport) {
    renderSideFamilySections(mainCol, report.whiteFamilyReport, 'White');
  }
  if (report.blackFamilyReport) {
    renderSideFamilySections(mainCol, report.blackFamilyReport, 'Black');
  }
  if (!report.whiteFamilyReport && !report.blackFamilyReport) {
    const empty = el('div', 'report-empty');
    empty.textContent = 'No openings available for this filter set.';
    mainCol.append(empty);
  }

  // ── Board column controls (below the board) ──
  const boardControls = document.getElementById('report-board-controls')!;
  boardControls.innerHTML = '';

  // Nav controls
  const nav = el('div', 'report-board-nav');

  const startBtn = el('button', 'btn icon');
  startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.41 16.59L13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z"/></svg>';
  startBtn.addEventListener('click', () => { if (selectedLine) { lineViewIndex = 0; updateBoardForLine(); } });

  const prevBtn = el('button', 'btn icon report-nav-prev') as HTMLButtonElement;
  prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
  prevBtn.addEventListener('click', () => navigateLine(-1));

  const counter = el('span', 'report-nav-counter');
  counter.textContent = '';

  const nextBtn = el('button', 'btn icon report-nav-next') as HTMLButtonElement;
  nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
  nextBtn.addEventListener('click', () => navigateLine(1));

  const endBtn = el('button', 'btn icon');
  endBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z"/></svg>';
  endBtn.addEventListener('click', () => { if (selectedLine) { lineViewIndex = lineFens.length - 1; updateBoardForLine(); } });

  nav.append(startBtn, prevBtn, counter, nextBtn, endBtn);
  boardControls.append(nav);

  // Open in trainer button
  const trainerBtn = el('button', 'btn btn-primary report-trainer-btn hidden') as HTMLButtonElement;
  trainerBtn.textContent = 'Open in trainer';
  trainerBtn.addEventListener('click', () => {
    if (!selectedLine || lineViewIndex <= 0 || !reportNavigateCallback) return;
    const moves: MoveHistoryEntry[] = selectedLine.moves.slice(0, lineViewIndex).map((san, i) => ({
      san,
      uci: selectedLine!.ucis[i],
      fen: lineFens[i + 1],
    }));
    const fen = lineFens[lineViewIndex];
    const filters: PersonalFilters = {
      timeClasses: reportFilters.timeClasses,
      minRating: reportFilters.minRating,
      maxRating: reportFilters.maxRating,
      sinceDate: reportFilters.sinceDate,
      untilDate: reportFilters.untilDate,
      color: reportFilters.color,
    };
    reportNavigateCallback(moves, fen, selectedLine.color, filters);
  });
  boardControls.append(trainerBtn);

  // ── Right sidebar detail panel ──
  const detailStatus = el('div', 'report-detail-status');
  detailStatus.innerHTML =
    `<div class="opening-name report-detail-opening"></div>` +
    `<div class="status-row">` +
      `<span class="turn-indicator report-detail-turn"></span>` +
      `<span class="move-counter report-detail-move"></span>` +
    `</div>` +
    `<div class="rep-depth" data-tooltip="Moves in this line that match your repertoire">` +
      `<span class="rep-depth-bar report-detail-rep-bar" style="width:0%"></span>` +
      `<span class="rep-depth-label report-detail-rep-label">No moves yet</span>` +
    `</div>`;
  detail.append(detailStatus);
  const continuations = el('div', 'report-continuations');
  detail.append(continuations);

  // Line games (in right sidebar)
  const lineGames = el('div', 'report-line-games');
  detail.append(lineGames);

  // Reset line state
  selectedLine = null;
  lineViewIndex = 0;
  lineFens = [];
  lineLastMoves = [];
  lineGameResultFilter = 'all';
  updateReportBoardEcoLabel(null);

  renderSelectedLineGames();
}

function renderSummaryLine(parent: HTMLElement, report: ReportData): void {
  const line = el('div', 'report-summary-line');
  const parts: string[] = [
    `${formatNum(report.totalGames)} games`,
    `${report.overallWinRate}% win`,
  ];
  if (reportCurrentRatingInfo) {
    parts.push(`${reportCurrentRatingInfo.current} ${capitalize(reportCurrentRatingInfo.timeClass)}`);
  }
  line.textContent = parts.join('  ·  ');


  parent.append(line);
}

function buildCompactOverview(report: ReportData): HTMLElement {
  const wrap = el('section', 'report-overview');

  const stats: { label: string; value: string }[] = [
    { label: 'Games', value: formatNum(report.totalGames) },
  ];
  if (reportCurrentRatingInfo) {
    stats.push({
      label: `Current ${capitalize(reportCurrentRatingInfo.timeClass)}`,
      value: `${reportCurrentRatingInfo.current}`,
    });
    if (reportCurrentRatingInfo.best != null && reportCurrentRatingInfo.best > 0) {
      stats.push({
        label: `Best ${capitalize(reportCurrentRatingInfo.timeClass)}`,
        value: `${reportCurrentRatingInfo.best}`,
      });
    }
  }
  stats.push(
    { label: 'Win Rate', value: `${report.overallWinRate}%` },
    { label: 'As White', value: `${winRatePct(report.asWhite)}%` },
    { label: 'As Black', value: `${winRatePct(report.asBlack)}%` },
  );

  const statGrid = el('div', 'report-overview-stats');
  if (stats.length === 5) statGrid.classList.add('stats-5');
  else if (stats.length >= 6) statGrid.classList.add('stats-6');
  for (const s of stats) {
    const item = el('div', 'report-overview-stat');
    const k = el('div', 'report-overview-key');
    k.textContent = s.label;
    const v = el('div', 'report-overview-value');
    v.textContent = s.value;
    item.append(k, v);
    statGrid.append(item);
  }
  wrap.append(statGrid);

  const wdl = report.overall;
  if (wdl.total > 0) {
    const bar = el('div', 'report-overview-wdl');
    const wPct = (wdl.wins / wdl.total) * 100;
    const dPct = (wdl.draws / wdl.total) * 100;
    const bPct = (wdl.losses / wdl.total) * 100;

    if (wPct > 0) {
      const wEl = el('div', 'bar-piece-white');
      wEl.style.width = `${wPct}%`;
      setBarPctLabel(wEl, wPct);
      wEl.setAttribute('data-tooltip', `Win: ${wdl.wins} games (${Math.round(wPct)}%)`);
      bar.append(wEl);
    }
    if (dPct > 0) {
      const dEl = el('div', 'bar-draw-neutral');
      dEl.style.width = `${dPct}%`;
      setBarPctLabel(dEl, dPct);
      dEl.setAttribute('data-tooltip', `Draw: ${wdl.draws} games (${Math.round(dPct)}%)`);
      bar.append(dEl);
    }
    if (bPct > 0) {
      const bEl = el('div', 'bar-piece-black');
      bEl.style.width = `${bPct}%`;
      setBarPctLabel(bEl, bPct);
      bEl.setAttribute('data-tooltip', `Loss: ${wdl.losses} games (${Math.round(bPct)}%)`);
      bar.append(bEl);
    }
    wrap.append(bar);
  }

  const hasTrend = ratingTrendsByTC.size > 0;
  const hasTimeControl = report.byTimeControl.length > 0;
  if (hasTrend || hasTimeControl) {
    const chartsRow = el('div', 'report-charts-row');
    if (hasTrend) renderSparkline(chartsRow, ratingTrendsByTC);
    if (hasTimeControl) renderTimeControlTable(chartsRow, report.byTimeControl);
    wrap.append(chartsRow);
  }

  return wrap;
}

function wireNavStatsButton(): void {
  const btn = document.querySelector<HTMLButtonElement>('.nav-stats-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !reportOpen || !lastReportData);
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    if (lastReportData) openStatsModal(lastReportData);
  });
}

let statsOverlayEl: HTMLElement | null = null;

function openStatsModal(report: ReportData): void {
  if (statsOverlayEl) { closeStatsModal(); return; }

  const overlay = el('div', 'report-stats-overlay');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeStatsModal(); });

  const modal = el('div', 'report-stats-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const header = el('div', 'report-stats-modal-header');
  const title = el('div', 'report-stats-modal-title');
  title.textContent = 'Game Statistics';
  const closeBtn = el('button', 'btn icon ghost') as HTMLButtonElement;
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closeStatsModal);
  header.append(title, closeBtn);

  const body = el('div', 'report-stats-modal-body');
  body.append(buildCompactOverview(report));

  modal.append(header, body);
  overlay.append(modal);
  document.body.append(overlay);
  statsOverlayEl = overlay;
  scheduleReportPctLabelFit();
}

function closeStatsModal(): void {
  if (!statsOverlayEl) return;
  statsOverlayEl.remove();
  statsOverlayEl = null;
}

function closeStatsModalIfOpen(): boolean {
  if (!statsOverlayEl) return false;
  closeStatsModal();
  return true;
}

function renderTheoryModal(parent: HTMLElement): void {
  const overlay = el('div', 'report-theory-overlay hidden');
  overlay.id = 'report-theory-overlay';

  const modal = el('div', 'report-theory-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Theory and methodology');

  const header = el('div', 'report-theory-header');
  const title = el('div', 'report-theory-title');
  title.textContent = 'Theory & Methodology';
  const closeBtn = el('button', 'btn icon ghost') as HTMLButtonElement;
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closeTheoryModal);
  header.append(title, closeBtn);

  const body = el('div', 'report-theory-body');
  body.innerHTML = `
    <h3>Why this exists</h3>
    <p>
      The report is designed to answer one practical question: <b>what should you train next</b>.
      Raw win rates can be misleading, so these metrics try to combine results, reliability, opponent strength, and frequency.
    </p>

    <h3>Metrics you see</h3>
    <p>
      <b>Win%</b>: simple wins / games.
    </p>
    <p>
      <b>~Elo Δ</b>: simple estimate based on decisive games only:
      <b>(wins − losses) × 8</b>. Draws count as 0.
    </p>

    <h3>Priority</h3>
    <p>
      Priority is a training-priority metric, not a win-rate metric.
      It combines how weak a line is and how often it appears.
      Current implementation is:
      <b>priority = max(0, overallScore − adjustedLineScore) × games</b>.
    </p>
    <p>
      Meaning:
      a line that is slightly weak but very frequent can be higher priority than a very weak line you almost never reach.
    </p>
    <p>
      In practice: <b>sort by Priority first</b> when deciding what to train.
    </p>
    <p>
      Quick read:
      <b>0</b> = not a training priority,
      <b>3+</b> = worth training,
      <b>7+</b> = high priority,
      <b>10+</b> = severe leak.
      So yes, <b>10</b> is generally very high.
    </p>

    <h3>Hidden metrics used for Priority</h3>
    <p>
      Behind the scenes, Priority also relies on non-displayed fields:
      raw score, adjusted score, confidence interval (±), rating-adjusted gap (Vs Elo), and line frequency.
      That is why a line with 31% win rate can still land around Priority 7: draws count as half points,
      the line is compared to your overall baseline, and values are stability-adjusted.
    </p>

    <h3>Core score percentages</h3>
    <p>
      A line score is based on chess points, not just wins:
      <b>Win = 1</b>, <b>Draw = 0.5</b>, <b>Loss = 0</b>.
      Score percentage is:
      <b>(wins + 0.5 × draws) / games</b>.
    </p>
    <p>
      This is why a line with many draws can still have a decent score even if the raw win rate is modest.
    </p>

    <h3>Stable score (Score%)</h3>
    <p>
      <b>Score%</b> is your line score after a small stability adjustment.
      Small samples are noisy, so we blend line score with your overall filtered score using a prior weight.
      This prevents a 3/3 line from outranking a stable 40-game line too aggressively.
    </p>
    <p>
      In practice: treat Score% as your best estimate of true line strength right now.
    </p>

    <h3>Elo expected score and Vs Elo</h3>
    <p>
      Elo gives an expected score against each opponent based on rating difference:
      <b>E = 1 / (1 + 10^((opp - user)/400))</b>.
      We average that expectation across games in the line.
    </p>
    <p>
      <b>Vs Elo</b> is:
      <b>actual line score − expected line score</b>.
    </p>
    <ul>
      <li><b>Positive Vs Elo</b>: you outperform what ratings predict.</li>
      <li><b>Negative Vs Elo</b>: you underperform expectation in that line.</li>
    </ul>
    <p>
      This is important because 50% score can be either good or bad depending on opponent strength.
    </p>

    <h3>Confidence and uncertainty</h3>
    <p>
      Reliability is about <b>uncertainty</b>, not how good the line is.
      Smaller samples and wider confidence intervals mean noisier estimates.
      Use the tooltip basis values (games and CI ±) when judging how much to trust a score.
    </p>
    <p>
      A weak line with low sample support is a hypothesis.
      A weak line with stronger sample support is usually a real problem.
    </p>

    <h3>How to use this in training</h3>
    <ol>
      <li>Pick top weak openings by Priority, then target their weakest continuation lines.</li>
      <li>Use Preview to inspect the branch and opponent continuations.</li>
      <li>Check Line diagnostics for <b>Critical move drops</b> — where your move choice underperforms alternatives.
        Continuation rows are color-coded when it's the opponent's turn: red = hurts you, green = you exploit.
      </li>
      <li>Use Open in trainer from board preview to train from that line.</li>
      <li>After new games, re-check if Priority drops and Win% improves.</li>
    </ol>

    <h3>Limits</h3>
    <p>
      These metrics are outcome-based and can still hide tactical/positional reasons.
      Use them to prioritize review, then validate with board analysis and concrete game examples.
    </p>
  `;

  modal.append(header, body);
  overlay.append(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTheoryModal();
  });

  theoryOverlayEl = overlay;
  parent.append(overlay);
}

function openTheoryModal(): void {
  if (!theoryOverlayEl) return;
  theoryOverlayEl.classList.remove('hidden');
}

function closeTheoryModal(): void {
  if (!theoryOverlayEl) return;
  theoryOverlayEl.classList.add('hidden');
}

function closeTheoryModalIfOpen(): boolean {
  if (!theoryOverlayEl || theoryOverlayEl.classList.contains('hidden')) return false;
  closeTheoryModal();
  return true;
}

// ── Stats Row ──

function renderStatsRow(parent: HTMLElement, report: ReportData): void {
  const row = el('div', 'report-stats-row');

  const stats = [
    { label: 'Games', value: formatNum(report.totalGames) },
    { label: 'Win Rate', value: `${report.overallWinRate}%` },
    { label: 'As White', value: `${winRatePct(report.asWhite)}%` },
    { label: 'As Black', value: `${winRatePct(report.asBlack)}%` },
  ];

  for (const s of stats) {
    const card = el('div', 'report-stat');
    const val = el('div', 'report-stat-value');
    val.textContent = s.value;
    const label = el('div', 'report-stat-label');
    label.textContent = s.label;
    card.append(val, label);
    row.append(card);
  }

  parent.append(row);
}

// ── WDL Bar ──

function renderWDLBar(parent: HTMLElement, wdl: WDL): void {
  if (wdl.total === 0) return;
  const wrap = el('div', 'report-wdl-wrap');

  const bar = el('div', 'report-wdl-bar');
  const wPct = (wdl.wins / wdl.total) * 100;
  const dPct = (wdl.draws / wdl.total) * 100;
  const bPct = (wdl.losses / wdl.total) * 100;

  if (wPct > 0) {
    const wEl = el('div', 'bar-piece-white');
    wEl.style.width = `${wPct}%`;
    setBarPctLabel(wEl, wPct);
    bar.append(wEl);
  }
  if (dPct > 0) {
    const dEl = el('div', 'bar-draw-neutral');
    dEl.style.width = `${dPct}%`;
    setBarPctLabel(dEl, dPct);
    bar.append(dEl);
  }
  if (bPct > 0) {
    const bEl = el('div', 'bar-piece-black');
    bEl.style.width = `${bPct}%`;
    setBarPctLabel(bEl, bPct);
    bar.append(bEl);
  }

  const legend = el('div', 'report-wdl-legend');
  legend.innerHTML = `<span>${wdl.wins}W</span> <span>${wdl.draws}D</span> <span>${wdl.losses}L</span>`;

  wrap.append(bar, legend);
  parent.append(wrap);
}

// ── Sparkline ──

const TC_COLORS: Record<string, string> = {
  bullet: '#e5a858',
  blitz: '#e8c44a',
  rapid: '#56b4e9',
  classical: '#8dd3c7',
  daily: '#bc80bd',
};

function renderSparkline(parent: HTMLElement, trendsByTC: Map<string, MonthlyRating[]>): void {
  const section = el('div', 'report-chart-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Rating Trend';
  section.append(heading);

  if (trendsByTC.size === 0) {
    section.append(textEl('div', 'report-chart-empty', 'Not enough data'));
    parent.append(section);
    return;
  }

  const width = 320;
  const height = 96;
  const padX = 36;
  const padY = 16;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  // Collect all months for shared x-axis
  const allMonths = new Set<string>();
  for (const trend of trendsByTC.values()) {
    for (const t of trend) allMonths.add(t.month);
  }
  const months = [...allMonths].sort();
  const monthIdx = new Map(months.map((m, i) => [m, i]));

  // Global min/max across all TCs
  let globalMin = Infinity, globalMax = -Infinity;
  for (const trend of trendsByTC.values()) {
    for (const t of trend) {
      if (t.avgRating < globalMin) globalMin = t.avgRating;
      if (t.avgRating > globalMax) globalMax = t.avgRating;
    }
  }
  const minR = globalMin - 20;
  const maxR = globalMax + 20;
  const range = maxR - minR || 1;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'report-sparkline');

  const xScale = months.length > 1 ? (i: number) => padX + (i / (months.length - 1)) * plotW : () => padX + plotW / 2;
  const yScale = (rating: number) => padY + plotH - ((rating - minR) / range) * plotH;

  // Draw each TC line
  for (const [tc, trend] of trendsByTC) {
    const color = TC_COLORS[tc] ?? '#999';
    const points = trend.map(t => ({
      x: xScale(monthIdx.get(t.month)!),
      y: yScale(t.avgRating),
      rating: t.avgRating,
    }));

    // Extend flat line to graph edges if data doesn't cover full range
    const first = points[0];
    const last = points[points.length - 1];
    const xStart = xScale(0);
    const xEnd = xScale(months.length - 1);
    if (first.x > xStart) points.unshift({ x: xStart, y: first.y, rating: first.rating });
    if (last.x < xEnd) points.push({ x: xEnd, y: last.y, rating: last.rating });

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // Area (only for single TC)
    if (trendsByTC.size === 1) {
      const areaD = pathD + ` L${points[points.length - 1].x.toFixed(1)},${(padY + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(padY + plotH).toFixed(1)} Z`;
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      area.setAttribute('d', areaD);
      area.setAttribute('class', 'sparkline-area');
      area.setAttribute('fill', color);
      area.setAttribute('opacity', '0.15');
      svg.append(area);
    }

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', pathD);
    line.setAttribute('class', 'sparkline-line');
    line.setAttribute('stroke', color);
    svg.append(line);

    // End dot + current rating label (on last real data point, not extension)
    const realLast = trend[trend.length - 1];
    const lastPt = { x: xScale(monthIdx.get(realLast.month)!), y: yScale(realLast.avgRating) };
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', lastPt.x.toFixed(1));
    dot.setAttribute('cy', lastPt.y.toFixed(1));
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'sparkline-dot');
    dot.setAttribute('fill', color);
    svg.append(dot);

    const curLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    curLabel.setAttribute('x', (lastPt.x + 6).toString());
    curLabel.setAttribute('y', (lastPt.y + 4).toString());
    curLabel.setAttribute('class', 'sparkline-current');
    curLabel.setAttribute('fill', color);
    curLabel.textContent = realLast.avgRating.toString();
    svg.append(curLabel);
  }

  // Axis labels
  const topLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  topLabel.setAttribute('x', (padX - 4).toString());
  topLabel.setAttribute('y', (padY + 4).toString());
  topLabel.setAttribute('class', 'sparkline-label');
  topLabel.textContent = Math.round(maxR).toString();
  svg.append(topLabel);

  const botLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  botLabel.setAttribute('x', (padX - 4).toString());
  botLabel.setAttribute('y', (padY + plotH).toString());
  botLabel.setAttribute('class', 'sparkline-label');
  botLabel.textContent = Math.round(minR).toString();
  svg.append(botLabel);

  // Hover interaction — vertical line + tooltip
  const hoverLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  hoverLine.setAttribute('y1', padY.toString());
  hoverLine.setAttribute('y2', (padY + plotH).toString());
  hoverLine.setAttribute('class', 'sparkline-hover-line');
  hoverLine.style.display = 'none';
  svg.append(hoverLine);

  const hoverGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  hoverGroup.style.display = 'none';
  svg.append(hoverGroup);

  // Build lookup: for each TC, map month index → rating (including extensions)
  const tcByMonth = new Map<string, Map<number, number>>();
  for (const [tc, trend] of trendsByTC) {
    const lookup = new Map<number, number>();
    for (const t of trend) lookup.set(monthIdx.get(t.month)!, t.avgRating);
    // Fill extended regions
    const firstIdx = monthIdx.get(trend[0].month)!;
    const lastIdx = monthIdx.get(trend[trend.length - 1].month)!;
    for (let i = 0; i < firstIdx; i++) lookup.set(i, trend[0].avgRating);
    for (let i = lastIdx + 1; i < months.length; i++) lookup.set(i, trend[trend.length - 1].avgRating);
    tcByMonth.set(tc, lookup);
  }

  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  overlay.setAttribute('x', padX.toString());
  overlay.setAttribute('y', '0');
  overlay.setAttribute('width', plotW.toString());
  overlay.setAttribute('height', height.toString());
  overlay.setAttribute('fill', 'transparent');
  overlay.style.cursor = 'crosshair';
  svg.append(overlay);

  overlay.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * width;
    // Snap to nearest month
    const monthFloat = months.length > 1 ? (svgX - padX) / plotW * (months.length - 1) : 0;
    const mi = Math.max(0, Math.min(months.length - 1, Math.round(monthFloat)));
    const x = xScale(mi);

    hoverLine.setAttribute('x1', x.toFixed(1));
    hoverLine.setAttribute('x2', x.toFixed(1));
    hoverLine.style.display = '';

    hoverGroup.innerHTML = '';
    hoverGroup.style.display = '';

    // Dots on lines
    for (const [tc, lookup] of tcByMonth) {
      const rating = lookup.get(mi);
      if (rating == null) continue;
      const color = TC_COLORS[tc] ?? '#999';
      const py = yScale(rating);
      const hDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      hDot.setAttribute('cx', x.toFixed(1));
      hDot.setAttribute('cy', py.toFixed(1));
      hDot.setAttribute('r', '3.5');
      hDot.setAttribute('fill', color);
      hDot.setAttribute('stroke', 'var(--bg-base)');
      hDot.setAttribute('stroke-width', '1.5');
      hoverGroup.append(hDot);
    }

    // Tooltip card
    const lines: string[] = [];
    for (const [tc, lookup] of tcByMonth) {
      const rating = lookup.get(mi);
      if (rating == null) continue;
      const color = TC_COLORS[tc] ?? '#999';
      const label = trendsByTC.size > 1 ? `<span style="color:${color}">${capitalize(tc)}</span> ${rating}` : `${rating}`;
      lines.push(label);
    }
    const onRight = x < width / 2;
    const tooltipW = 120;
    const tx = onRight ? x + 10 : x - tooltipW - 10;
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', tx.toFixed(1));
    fo.setAttribute('y', '0');
    fo.setAttribute('width', tooltipW.toString());
    fo.setAttribute('height', height.toString());
    fo.setAttribute('style', 'overflow: visible');
    const tip = document.createElement('div');
    tip.className = 'sparkline-tooltip';
    tip.innerHTML = `<div class="sparkline-tooltip-month">${months[mi]}</div>${lines.join('<br>')}`;
    fo.append(tip);
    hoverGroup.append(fo);
  });

  overlay.addEventListener('mouseleave', () => {
    hoverLine.style.display = 'none';
    hoverGroup.style.display = 'none';
  });

  section.append(svg);

  // Legend (when multiple TCs)
  if (trendsByTC.size > 1) {
    const legend = el('div', 'sparkline-legend');
    for (const tc of trendsByTC.keys()) {
      const item = el('span', 'sparkline-legend-item');
      const swatch = el('span', 'sparkline-legend-swatch');
      swatch.style.background = TC_COLORS[tc] ?? '#999';
      item.append(swatch, document.createTextNode(capitalize(tc)));
      legend.append(item);
    }
    section.append(legend);
  }

  parent.append(section);
}

// ── Time Control Table ──

function renderTimeControlTable(parent: HTMLElement, stats: { timeClass: string; wdl: WDL; winRate: number }[]): void {
  const section = el('div', 'report-chart-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'By Time Control';
  section.append(heading);

  const table = el('div', 'report-tc-table');

  for (const tc of stats) {
    const row = el('div', 'report-tc-row');

    const name = el('span', 'report-tc-name');
    name.textContent = capitalize(tc.timeClass);

    const games = el('span', 'report-tc-games');
    games.textContent = `${formatNum(tc.wdl.total)}g`;

    const rate = el('span', 'report-tc-rate');
    rate.textContent = `${tc.winRate}%`;

    const bar = el('div', 'report-tc-bar');
    const wPct = tc.wdl.total > 0 ? (tc.wdl.wins / tc.wdl.total) * 100 : 0;
    const dPct = tc.wdl.total > 0 ? (tc.wdl.draws / tc.wdl.total) * 100 : 0;
    const bPct = tc.wdl.total > 0 ? (tc.wdl.losses / tc.wdl.total) * 100 : 0;

    if (wPct > 0) { const wEl = el('div', 'bar-win'); wEl.style.width = `${wPct}%`; bar.append(wEl); }
    if (dPct > 0) { const dEl = el('div', 'bar-draw'); dEl.style.width = `${dPct}%`; bar.append(dEl); }
    if (bPct > 0) { const bEl = el('div', 'bar-loss'); bEl.style.width = `${bPct}%`; bar.append(bEl); }

    row.append(name, games, rate, bar);
    table.append(row);
  }

  section.append(table);
  parent.append(section);
}

// ── Family Sections ──

function renderSideFamilySections(
  parent: HTMLElement,
  sideReport: SideFamilyReport,
  sideLabel: 'White' | 'Black',
): void {
  const section = el('section', 'report-side-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = `${sideLabel} openings`;
  section.append(heading);

  renderFamilyTable(section, sideReport.families);
  parent.append(section);
}

function renderCombinedPriorityFamilies(parent: HTMLElement, report: ReportData): void {
  const families = [
    ...(report.whiteFamilyReport?.weakFamilies ?? []),
    ...(report.blackFamilyReport?.weakFamilies ?? []),
  ];
  if (families.length === 0) return;

  const dedup = new Map<string, OpeningFamily>();
  for (const family of families) {
    dedup.set(family.key, family);
  }

  const ranked = [...dedup.values()].sort((a, b) =>
    b.impact - a.impact
      || a.adjustedScorePct - b.adjustedScorePct
      || b.wdl.total - a.wdl.total
      || a.displayLabel.localeCompare(b.displayLabel),
  );

  renderFamilyCardSlot(
    parent,
    'Priority weaknesses',
    ranked.slice(0, MAX_PRIORITY_FAMILY_CARDS),
    'weak',
  );
}

function renderFamilyCardSlot(
  parent: HTMLElement,
  title: string,
  families: OpeningFamily[],
  variant: 'weak' | 'best',
): void {
  const slot = el('div', 'report-family-slot');
  const slotTitle = el('div', 'report-family-slot-title');
  slotTitle.textContent = title;
  slot.append(slotTitle);

  const list = el('div', 'report-family-card-list');
  for (const family of families) {
    list.append(buildFamilyCard(family, variant));
  }
  slot.append(list);
  parent.append(slot);
}

function buildFamilyCard(family: OpeningFamily, variant: 'weak' | 'best'): HTMLElement {
  const card = el('div', 'report-family-card');
  card.classList.add(`variant-${variant}`);
  card.classList.add(family.color === 'white' ? 'side-white' : 'side-black');
  if (variant === 'weak') {
    if (family.impact >= 3) card.classList.add('severity-high');
    else if (family.impact >= 1.5) card.classList.add('severity-mid');
    else card.classList.add('severity-low');
  }

  card.addEventListener('click', () => selectLine(family.baseLine));

  const titleRow = el('div', 'report-line-title-row');
  const labelWrap = el('div', 'report-family-title-wrap');
  const label = el('div', 'report-family-label');
  setMiddleTruncateText(label, family.displayLabel);
  label.title = family.displayLabel;
  labelWrap.append(label);

  const moveRow = el('div', 'report-family-move-row');
  const moveLine = el('div', 'report-family-move-line');
  moveLine.textContent = family.baseLine.label || family.baseLine.displayLabel;
  moveRow.append(moveLine);
  labelWrap.append(moveRow);

  const transposedLines = family.baseLine.transpositionLabels;
  if (transposedLines.length > 0) {
    const allTranspositionLines = [family.baseLine.label || family.baseLine.displayLabel, ...transposedLines];
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'report-family-transpose-toggle';
    toggleBtn.textContent = `${transposedLines.length} transposition${transposedLines.length === 1 ? '' : 's'}`;
    toggleBtn.classList.add('tooltip-wide');
    toggleBtn.classList.add('tooltip-html');
    toggleBtn.setAttribute(
      'data-tooltip',
      ['Transpositions', ...allTranspositionLines]
        .map(escapeHtml)
        .join('<br>'),
    );
    moveRow.append(toggleBtn);
  }

  const gamesBadge = el('span', 'report-line-games-badge');
  gamesBadge.textContent = `${formatNum(family.wdl.total)} games`;
  gamesBadge.setAttribute('data-tooltip', 'Games in this final position (pooled across transpositions).');
  const badges = el('div', 'report-family-badges');
  badges.append(gamesBadge);
  titleRow.append(labelWrap, badges);
  card.append(titleRow);

  const statsRow = el('div', 'report-family-stats');
  statsRow.append(buildInlineWdlBar(family.wdl));

  const familyElo = eloSwingForWdl(family.wdl);
  const deltaChip = document.createElement('span');
  deltaChip.className = 'report-family-elo-badge';
  deltaChip.textContent = `${formatSignedNum(familyElo)} elo`;
  if (familyElo > 0) deltaChip.classList.add('good');
  else if (familyElo < 0) deltaChip.classList.add('bad');
  deltaChip.setAttribute(
    'data-tooltip',
    `Elo Δ: (${family.wdl.wins}W - ${family.wdl.losses}L) × 8 = ${formatSignedNum(familyElo)}`,
  );
  statsRow.append(deltaChip);
  card.append(statsRow);

  return card;
}

function buildInlineWdlBar(wdl: WDL): HTMLElement {
  const bar = el('div', 'report-wdl-bar-inline');
  if (wdl.total === 0) return bar;

  const wPct = (wdl.wins / wdl.total) * 100;
  const dPct = (wdl.draws / wdl.total) * 100;
  const bPct = (wdl.losses / wdl.total) * 100;

  if (wPct > 0) {
    const wEl = el('div', 'bar-win');
    wEl.style.width = `${wPct}%`;
    setBarPctLabel(wEl, wPct);
    bar.append(wEl);
  }
  if (dPct > 0) {
    const dEl = el('div', 'bar-draw');
    dEl.style.width = `${dPct}%`;
    setBarPctLabel(dEl, dPct);
    bar.append(dEl);
  }
  if (bPct > 0) {
    const bEl = el('div', 'bar-loss');
    bEl.style.width = `${bPct}%`;
    setBarPctLabel(bEl, bPct);
    bar.append(bEl);
  }
  bar.setAttribute('data-tooltip', `${wdl.wins}W ${wdl.draws}D ${wdl.losses}L`);
  return bar;
}

function renderFamilyTable(parent: HTMLElement, families: OpeningFamily[]): void {
  const section = el('div', 'report-family-table-section');
  const table = el('div', 'report-family-table');
  const header = el('div', 'report-family-table-header');
  type FamilySortKey = 'opening' | 'games' | 'score' | 'eloDelta';
  type FamilySortDir = 'asc' | 'desc';
  let sortKey: FamilySortKey = 'eloDelta';
  let sortDir: FamilySortDir = 'asc';

  const hOpening = document.createElement('span');
  hOpening.className = 'sortable';
  hOpening.addEventListener('click', () => handleSort('opening'));
  const hGames = document.createElement('span');
  hGames.className = 'sortable';
  hGames.addEventListener('click', () => handleSort('games'));
  const hWdl = document.createElement('span');
  hWdl.className = 'sortable';
  hWdl.addEventListener('click', () => handleSort('score'));
  const hElo = document.createElement('span');
  hElo.className = 'sortable';
  hElo.addEventListener('click', () => handleSort('eloDelta'));
  header.append(hOpening, hGames, hWdl, hElo);
  table.append(header);

  function sortValue(family: OpeningFamily, key: FamilySortKey): number | string {
    if (key === 'opening') return family.displayLabel;
    if (key === 'games') return family.wdl.total;
    if (key === 'score') return family.adjustedScorePct;
    return eloSwingForWdl(family.wdl);
  }

  function sortFamilies(rows: OpeningFamily[]): OpeningFamily[] {
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let primary = 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        primary = sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      } else {
        const an = Number(av);
        const bn = Number(bv);
        primary = sortDir === 'asc' ? an - bn : bn - an;
      }
      if (primary !== 0) return primary;
      return eloSwingForWdl(a.wdl) - eloSwingForWdl(b.wdl)
        || b.wdl.total - a.wdl.total
        || a.displayLabel.localeCompare(b.displayLabel);
    });
  }

  function renderRows(): void {
    table.querySelectorAll('.report-family-row').forEach(r => r.remove());

    for (const family of sortFamilies(families)) {
      const row = el('div', 'report-family-row');
      row.addEventListener('click', () => {
        table.querySelectorAll('.report-family-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        selectLine(family.baseLine);
      });

      const nameCell = el('div', 'report-family-name-cell');
      const nameText = el('div', 'report-family-name-text');
      setMiddleTruncateText(nameText, family.displayLabel);
      nameText.title = family.displayLabel;
      const moveLine = el('div', 'report-family-move-line');
      moveLine.textContent = family.baseLine.label || family.baseLine.displayLabel;
      moveLine.title = family.baseLine.label || family.baseLine.displayLabel;
      nameCell.append(nameText, moveLine);

      const gamesCell = document.createElement('span');
      gamesCell.className = 'report-family-games';
      gamesCell.textContent = formatNum(family.wdl.total);

      const wdlCell = buildInlineWdlBar(family.wdl);

      const familyElo = eloSwingForWdl(family.wdl);
      const eloCell = document.createElement('span');
      eloCell.className = 'report-family-elo';
      eloCell.textContent = `${formatSignedNum(familyElo)} elo`;
      if (familyElo > 0) eloCell.classList.add('good');
      else if (familyElo < 0) eloCell.classList.add('bad');

      row.append(nameCell, gamesCell, wdlCell, eloCell);
      table.append(row);
    }
    scheduleReportPctLabelFit();
  }

  function handleSort(nextKey: FamilySortKey): void {
    if (sortKey === nextKey) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = nextKey;
      sortDir = nextKey === 'opening' ? 'asc' : 'asc';
    }
    updateHeaderIndicators();
    renderRows();
  }

  function indicatorLabel(label: string, key: FamilySortKey): string {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'desc' ? '▼' : '▲'}`;
  }

  function updateHeaderIndicators(): void {
    hOpening.textContent = indicatorLabel('Opening', 'opening');
    hGames.textContent = indicatorLabel('Games', 'games');
    hWdl.textContent = indicatorLabel('Score', 'score');
    hElo.textContent = indicatorLabel('Elo Δ', 'eloDelta');
    hOpening.classList.toggle('sort-active', sortKey === 'opening');
    hGames.classList.toggle('sort-active', sortKey === 'games');
    hWdl.classList.toggle('sort-active', sortKey === 'score');
    hElo.classList.toggle('sort-active', sortKey === 'eloDelta');
  }

  updateHeaderIndicators();
  renderRows();

  section.append(table);
  parent.append(section);
}

// ── Opening Table ──

type SortKey = 'games' | 'winRate' | 'delta' | 'impact';
type SortDir = 'asc' | 'desc';

function renderOpeningTable(parent: HTMLElement, title: string, lines: OpeningLine[]): void {
  const section = el('div', 'report-opening-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = title;
  section.append(heading);

  const table = el('div', 'report-opening-table');
  let sortKey: SortKey = 'impact';
  let sortDir: SortDir = 'desc';

  function sortValue(line: OpeningLine, key: SortKey): number {
    if (key === 'games') return line.wdl.total;
    if (key === 'winRate') return line.winRate;
    if (key === 'impact') return line.impact;
    return eloSwingForLine(line);
  }

  function renderRows(): void {
    // Remove existing rows (keep header)
    table.querySelectorAll('.report-opening-row:not(.report-opening-header)').forEach(r => r.remove());

    const sorted = [...lines].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return sortDir === 'desc' ? bv - av : av - bv;
    });

    for (const line of sorted.slice(0, 10)) {
      const row = el('div', 'report-opening-row');
      row.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
      row.addEventListener('click', () => {
        table.querySelectorAll('.report-opening-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        selectLine(line);
      });

      const labelCell = el('div', 'report-opening-label-cell');
      const labelText = el('div', 'report-opening-label-text');
      const label = el('span', 'report-opening-label');
      label.textContent = line.displayLabel;
      label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
      labelText.append(label);
      if (line.openingName && line.label) {
        const sub = el('span', 'report-opening-subline');
        sub.textContent = line.label;
        sub.title = line.label;
        labelText.append(sub);
      }
      labelCell.append(labelText);

      const games = el('span', 'report-opening-games');
      games.textContent = formatNum(line.wdl.total);
      games.setAttribute('data-tooltip', gamesTooltip(line));

      const win = el('span', 'report-opening-rate');
      win.textContent = `${line.winRate}%`;
      if (line.winRate >= 55) win.classList.add('good');
      else if (line.winRate <= 45) win.classList.add('bad');
      win.setAttribute('data-tooltip', winRateTooltip(line));
      win.classList.add('tooltip-wide');

      const delta = el('span', 'report-opening-delta');
      const eloSwing = eloSwingForLine(line);
      delta.textContent = formatSignedNum(eloSwing);
      if (eloSwing > 0) delta.classList.add('good');
      if (eloSwing < 0) delta.classList.add('bad');
      delta.setAttribute('data-tooltip', eloSwingTooltip(line));
      delta.classList.add('tooltip-wide');

      const impact = el('span', 'report-opening-impact');
      impact.textContent = formatImpact(line.impact);
      if (line.impact >= 2) impact.classList.add('bad');
      impact.setAttribute('data-tooltip', impactTooltip(line));
      impact.classList.add('tooltip-wide');
      impact.classList.add('tooltip-preline');

      row.append(labelCell, impact, win, delta, games);
      table.append(row);
    }
  }

  function handleSort(key: SortKey): void {
    if (sortKey === key) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = key;
      sortDir = 'desc';
    }
    updateHeaderIndicators();
    renderRows();
  }

  const headerRow = el('div', 'report-opening-row report-opening-header');
  const hLabel = el('span', 'report-opening-label');
  hLabel.textContent = 'Opening';
  const hGames = el('span', 'report-opening-games sortable');
  hGames.textContent = 'Games';
  hGames.setAttribute('data-tooltip', 'How often this line appears in your filtered games.');
  hGames.addEventListener('click', () => handleSort('games'));
  const hRate = el('span', 'report-opening-rate sortable');
  hRate.textContent = 'Win%';
  hRate.setAttribute('data-tooltip', 'Raw win percentage: wins / total games in this line.');
  hRate.addEventListener('click', () => handleSort('winRate'));
  const hDelta = el('span', 'report-opening-delta sortable');
  hDelta.textContent = '~EloΔ';
  hDelta.setAttribute('data-tooltip', 'Simple estimate: (wins - losses) * 8. Draws count as 0.');
  hDelta.addEventListener('click', () => handleSort('delta'));
  const hImpact = el('span', 'report-opening-impact sortable');
  hImpact.textContent = 'Priority';
  hImpact.setAttribute('data-tooltip', priorityScaleTooltip());
  hImpact.classList.add('tooltip-wide');
  hImpact.classList.add('tooltip-preline');
  hImpact.addEventListener('click', () => handleSort('impact'));
  headerRow.append(hLabel, hImpact, hRate, hDelta, hGames);

  function updateHeaderIndicators(): void {
    hGames.classList.toggle('sort-active', sortKey === 'games');
    hRate.classList.toggle('sort-active', sortKey === 'winRate');
    hDelta.classList.toggle('sort-active', sortKey === 'delta');
    hImpact.classList.toggle('sort-active', sortKey === 'impact');
  }

  table.append(headerRow);
  updateHeaderIndicators();
  renderRows();

  section.append(table);
  parent.append(section);
}

// ── Weakness Queue ──

function renderWeaknessQueue(parent: HTMLElement, lines: OpeningLine[]): void {
  const section = el('div', 'report-findings-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Priority Weaknesses';
  section.append(heading);

  const list = el('div', 'report-weakness-list');

  for (const line of lines) {
    const card = el('div', 'report-weakness-card');
    card.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
    card.addEventListener('click', () => selectLine(line));
    if (line.impact >= 3) card.classList.add('severity-high');
    else if (line.impact >= 1.5) card.classList.add('severity-mid');
    else card.classList.add('severity-low');

    const top = el('div', 'report-weakness-top');
    const titleRow = el('div', 'report-line-title-row');
    const label = el('div', 'report-weakness-label');
    label.textContent = line.displayLabel;
    label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
    const gamesBadge = el('span', 'report-line-games-badge');
    gamesBadge.textContent = `${formatNum(line.wdl.total)} games`;
    gamesBadge.setAttribute('data-tooltip', 'Number of games in this line after filters.');
    titleRow.append(label, gamesBadge);
    if (line.openingName && line.label) {
      const sub = el('div', 'report-weakness-subline');
      sub.textContent = line.label;
      sub.title = line.label;
      top.append(titleRow, sub);
    } else {
      top.append(titleRow);
    }

    const stats = el('div', 'report-weakness-stats');
    const adjChip = document.createElement('span');
    adjChip.className = 'stat';
    adjChip.textContent = `Win ${line.winRate}%`;
    if (line.winRate >= 55) adjChip.classList.add('good');
    else if (line.winRate <= 45) adjChip.classList.add('bad');
    adjChip.setAttribute('data-tooltip', winRateTooltip(line));
    adjChip.classList.add('tooltip-wide');

    const expChip = document.createElement('span');
    expChip.className = 'stat';
    const elo = eloSwingForLine(line);
    expChip.textContent = `~Elo Δ${formatSignedNum(elo)}`;
    if (elo > 0) expChip.classList.add('good');
    else if (elo < 0) expChip.classList.add('bad');
    expChip.setAttribute('data-tooltip', eloSwingTooltip(line));
    expChip.classList.add('tooltip-wide');

    const impactChip = document.createElement('span');
    impactChip.className = 'stat';
    impactChip.textContent = `Priority ${formatImpact(line.impact)}`;
    if (line.impact >= 3) impactChip.classList.add('bad');
    else if (line.impact >= 1.5) impactChip.classList.add('warn');
    impactChip.setAttribute('data-tooltip', impactTooltip(line));
    impactChip.classList.add('tooltip-wide');
    impactChip.classList.add('tooltip-preline');

    stats.append(impactChip, adjChip, expChip);
    top.append(stats);

    card.append(top);
    list.append(card);
  }

  section.append(list);
  parent.append(section);
}

// ── Highlights ──

function renderHighlights(
  parent: HTMLElement,
  scoreLines: OpeningLine[],
  weightedLines: OpeningLine[],
): void {
  const section = el('div', 'report-findings-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Best Performers';
  section.append(heading);

  appendHighlightSlot(section, 'Top Score%', scoreLines);
  appendHighlightSlot(section, 'Proven Winners (Score x Games)', weightedLines);

  parent.append(section);
}

function appendHighlightSlot(section: HTMLElement, title: string, lines: OpeningLine[]): void {
  if (lines.length === 0) return;

  const slot = el('div', 'report-highlights-slot');
  const slotTitle = el('div', 'report-highlights-slot-title');
  slotTitle.textContent = title;
  slot.append(slotTitle);

  const list = el('div', 'report-highlights-list');
  for (const line of lines) {
    list.append(buildHighlightCard(line));
  }
  slot.append(list);
  section.append(slot);
}

function buildHighlightCard(line: OpeningLine): HTMLElement {
  const card = el('div', 'report-highlight-card');
  card.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
  card.addEventListener('click', () => selectLine(line));
  const titleRow = el('div', 'report-line-title-row');
  const label = el('div', 'report-highlight-label');
  label.textContent = line.displayLabel;
  label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
  const gamesBadge = el('span', 'report-line-games-badge');
  gamesBadge.textContent = `${formatNum(line.wdl.total)} games`;
  gamesBadge.setAttribute('data-tooltip', 'Number of games in this line after filters.');
  titleRow.append(label, gamesBadge);
  if (line.openingName && line.label) {
    const sub = el('div', 'report-highlight-subline');
    sub.textContent = line.label;
    sub.title = line.label;
    card.append(titleRow, sub);
  } else {
    card.append(titleRow);
  }

  const stats = el('div', 'report-highlight-stats');
  const adj = document.createElement('span');
  adj.className = 'stat';
  adj.textContent = `Win ${line.winRate}%`;
  if (line.winRate >= 55) adj.classList.add('good');
  else if (line.winRate <= 45) adj.classList.add('bad');
  adj.setAttribute('data-tooltip', winRateTooltip(line));
  adj.classList.add('tooltip-wide');
  const exp = document.createElement('span');
  exp.className = 'stat';
  const hElo = eloSwingForLine(line);
  exp.textContent = `~Elo Δ${formatSignedNum(hElo)}`;
  if (hElo > 0) exp.classList.add('good');
  else if (hElo < 0) exp.classList.add('bad');
  exp.setAttribute('data-tooltip', eloSwingTooltip(line));
  exp.classList.add('tooltip-wide');
  stats.append(adj, exp);

  card.append(stats);
  return card;
}

// ── Board Preview & Line Navigation ──

function selectLine(line: OpeningLine): void {
  selectedLine = line;
  lineViewIndex = line.ucis.length; // start at the end
  lineGameResultFilter = 'all';
  lastKnownOpeningName = line.openingName || line.displayLabel;

  // Orient main board to match the opening color
  setOrientation(line.color);

  // Compute FENs for each ply
  lineFens = [];
  lineLastMoves = [];
  const chess = Chess.default();
  lineFens.push(makeFen(chess.toSetup()));
  lineLastMoves.push(undefined);

  for (const uci of line.ucis) {
    const move = parseUci(uci);
    if (!move) break;
    chess.play(move);
    lineFens.push(makeFen(chess.toSetup()));
    lineLastMoves.push([uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]);
  }

  updateBoardForLine();
}

function navigateLine(delta: number): void {
  if (!selectedLine) return;
  const newIdx = lineViewIndex + delta;
  if (newIdx < 0 || newIdx >= lineFens.length) return;
  lineViewIndex = newIdx;
  updateBoardForLine();
}

function updateBoardForLine(): void {
  if (!selectedLine) return;

  const fen = lineFens[lineViewIndex];
  updateReportBoardEcoLabel(fen);
  const lastMove = lineLastMoves[lineViewIndex] as [Key, Key] | undefined;
  setBoardFen(fen, lastMove);

  // Update move table under board (reuse trainer's #moves element)
  const movesEl = document.getElementById('moves');
  if (movesEl) {
    const moves = selectedLine.moves;
    let html = '<div class="move-table">';
    for (let i = 0; i < moves.length; i += 2) {
      const moveNum = Math.floor(i / 2) + 1;
      const white = moves[i];
      const black = moves[i + 1];
      const whiteActive = (i + 1) === lineViewIndex ? ' active' : '';
      const blackActive = black && (i + 2) === lineViewIndex ? ' active' : '';
      html += `<div class="move-num">${moveNum}.</div>
        <div class="move-san clickable${whiteActive}" data-vi="${i + 1}">${white}</div>
        <div class="move-san${black ? ` clickable${blackActive}` : ''}"${black ? ` data-vi="${i + 2}"` : ''}>${black || ''}</div>`;
    }
    html += '</div>';
    movesEl.innerHTML = html;

    movesEl.querySelectorAll('.move-san.clickable').forEach((td) => {
      td.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        lineViewIndex = parseInt(target.dataset.vi!);
        updateBoardForLine();
      });
    });

    const activeEl = movesEl.querySelector('.move-san.active') as HTMLElement | null;
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  // Update nav button states
  const prevBtn = document.querySelector('.report-nav-prev') as HTMLButtonElement | null;
  const nextBtn = document.querySelector('.report-nav-next') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = lineViewIndex <= 0;
  if (nextBtn) nextBtn.disabled = lineViewIndex >= lineFens.length - 1;

  // Update counter
  const counter = document.querySelector('.report-nav-counter');
  if (counter) counter.textContent = `${lineViewIndex} / ${lineFens.length - 1}`;

  // Update "Open in trainer" button visibility
  const trainerBtn = document.querySelector('.report-trainer-btn');
  if (trainerBtn) {
    trainerBtn.classList.toggle('hidden', lineViewIndex <= 0 || !reportNavigateCallback);
  }

  // Update status block (turn + rep depth)
  updateReportDetailStatus();

  // Update continuations from this position
  renderContinuations(fen);

  renderSelectedLineGames();
}

let lastKnownOpeningName = 'Starting position';

function updateReportBoardEcoLabel(fen: string | null): void {
  const detailOpening = document.querySelector('.report-detail-opening') as HTMLElement | null;

  if (!fen) {
    lastKnownOpeningName = 'Starting position';
    if (detailOpening) detailOpening.textContent = lastKnownOpeningName;
    scheduleReportPctLabelFit();
    return;
  }

  const opening = findOpeningByFen(fen);
  if (opening) lastKnownOpeningName = opening.name;
  if (detailOpening) detailOpening.textContent = lastKnownOpeningName;
  scheduleReportPctLabelFit();
}

function updateReportDetailStatus(): void {
  const turnEl = document.querySelector('.report-detail-turn') as HTMLElement | null;
  const moveEl = document.querySelector('.report-detail-move') as HTMLElement | null;
  const repBar = document.querySelector('.report-detail-rep-bar') as HTMLElement | null;
  const repLabel = document.querySelector('.report-detail-rep-label') as HTMLElement | null;

  if (!selectedLine || lineViewIndex <= 0) {
    // No line selected or at starting position
    if (turnEl) { turnEl.textContent = ''; turnEl.className = 'turn-indicator report-detail-turn'; }
    if (moveEl) moveEl.textContent = '';
    if (repBar) repBar.style.width = '0%';
    if (repLabel) repLabel.textContent = 'Select an opening to see details';
    return;
  }

  // Turn indicator from FEN
  const fen = lineFens[lineViewIndex];
  const turnChar = fen.split(' ')[1];
  if (turnEl) {
    turnEl.textContent = turnChar === 'w' ? 'White to move' : 'Black to move';
    turnEl.className = 'turn-indicator report-detail-turn';
  }

  // Move counter
  const moveNum = Math.floor(lineViewIndex / 2) + (lineViewIndex % 2 === 0 ? 0 : 1);
  if (moveEl) moveEl.textContent = `Move ${moveNum}`;

  // Repertoire depth — count consecutive locked moves from start
  let repMoves = 0;
  for (let i = 0; i < selectedLine.moves.length && i < lineViewIndex; i++) {
    const fenBefore = lineFens[i];
    const locked = getLockedMoves(fenBefore);
    if (locked.length > 0 && locked.includes(selectedLine.ucis[i])) {
      repMoves++;
    } else {
      break;
    }
  }
  const total = lineViewIndex;
  const pct = total > 0 ? Math.round((repMoves / total) * 100) : 0;
  if (repBar) repBar.style.width = `${pct}%`;
  if (repLabel) repLabel.textContent = `${repMoves}/${total} moves in repertoire`;
}

// ── Continuations ──

function renderContinuations(fen: string): void {
  const container = document.querySelector('.report-continuations');
  if (!container) return;
  container.innerHTML = '';

  const data = queryPersonalExplorer(fen);
  if (!data || data.moves.length === 0) return;

  const heading = el('div', 'report-continuations-title');
  heading.textContent = 'Continuations';
  container.append(heading);

  const grandTotal = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);

  // Determine if this is an opponent move position for score coloring
  const isWhite = selectedLine?.color === 'white';
  const isOpponentTurn = selectedLine
    ? (isWhite ? lineViewIndex % 2 === 1 : lineViewIndex % 2 === 0)
    : false;

  for (const move of data.moves.slice(0, 8)) {
    const total = move.white + move.draws + move.black;
    if (total === 0) continue;

    const locked = isMoveLocked(fen, move.uci);
    const row = el('div', 'report-cont-row');
    if (locked) row.classList.add('locked');

    if (isOpponentTurn && selectedLine && total >= 3) {
      const pickPctRaw = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
      if (pickPctRaw >= 10) {
        const wins = isWhite ? move.white : move.black;
        const moveScore = Math.round(((wins + move.draws * 0.5) / total) * 100);
        const scoreClass = scoreSeverityClass(moveScore);
        row.classList.add(scoreClass);
      }
    }
    const wins = isWhite ? move.white : move.black;
    const losses = isWhite ? move.black : move.white;
    const winPct = Math.round((wins / total) * 100);
    const scorePct = Math.round(((wins + move.draws * 0.5) / total) * 100);
    const elo = (wins - losses) * 8;
    const eloStr = elo > 0 ? `+${elo}` : `${elo}`;
    row.setAttribute(
      'data-tooltip',
      `Score ${scorePct}% · Win ${winPct}% · ${wins}W ${move.draws}D ${losses}L · ~Elo Δ${eloStr}`,
    );
    row.classList.add('tooltip-wide');
    row.addEventListener('click', () => extendLine(move.uci, move.san));

    const san = el('span', 'report-cont-san');
    san.textContent = move.san;

    const pickPct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
    const pickBar = el('span', 'report-cont-pick');
    const pickFill = el('span', 'pct-fill');
    pickFill.style.width = `${pickPct}%`;
    const pickLabel = el('span', 'pct-label');
    pickLabel.textContent = `${Math.round(pickPct)}%`;
    pickBar.append(pickFill, pickLabel);

    const games = el('span', 'report-cont-games');
    games.textContent = formatNum(total);

    const wPct = Math.round((move.white / total) * 100);
    const dPct = Math.round((move.draws / total) * 100);
    const bPct = 100 - wPct - dPct;
    const bar = el('div', 'report-cont-bar');
    if (wPct > 0) {
      const wEl = el('span', 'bar-piece-white');
      wEl.style.width = `${wPct}%`;
      setBarPctLabel(wEl, wPct);
      bar.append(wEl);
    }
    if (dPct > 0) {
      const dEl = el('span', 'bar-draw-neutral');
      dEl.style.width = `${dPct}%`;
      setBarPctLabel(dEl, dPct);
      bar.append(dEl);
    }
    if (bPct > 0) {
      const bEl = el('span', 'bar-piece-black');
      bEl.style.width = `${bPct}%`;
      setBarPctLabel(bEl, bPct);
      bar.append(bEl);
    }

    const lockBtn = document.createElement('button');
    lockBtn.className = `report-cont-lock${locked ? ' locked' : ''}`;
    lockBtn.innerHTML = locked
      ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>';
    lockBtn.addEventListener('click', (e) => { e.stopPropagation(); });

    row.append(san, pickBar, games, bar, lockBtn);
    container.append(row);
  }
  scheduleReportPctLabelFit();
}


type LineGameRow = {
  href: string;
  result: 'win' | 'draw' | 'loss';
  userRating: number;
  oppRating: number;
  date: string;
  opponent: string | null;
};

function userResultForGame(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  if (game.re === 'w') return game.uw ? 'win' : 'loss';
  return game.uw ? 'loss' : 'win';
}

function parentFenAndLastUci(ucis: string[]): { fen: string; uci: string } | null {
  if (ucis.length === 0) return null;
  const chess = Chess.default();
  for (let i = 0; i < ucis.length - 1; i++) {
    const move = parseUci(ucis[i]);
    if (!move) return null;
    chess.play(move);
  }
  return { fen: makeFen(chess.toSetup()), uci: ucis[ucis.length - 1] };
}

function getLineGameRows(line: OpeningLine): LineGameRow[] {
  const parent = parentFenAndLastUci(line.ucis);
  const games = getPersonalGames();
  if (!parent || !games) return [];

  const indices = queryPersonalMoveGameIndices(parent.fen, parent.uci);
  const rows: LineGameRow[] = [];
  for (const idx of indices) {
    const g = games[idx];
    if (!g?.gl) continue;
    rows.push({
      href: g.gl,
      result: userResultForGame(g),
      userRating: g.ur,
      oppRating: g.or,
      date: gameDateSortKey(g) ?? '',
      opponent: g.op ?? null,
    });
  }
  rows.sort((a, b) => {
    if (!a.date || a.date === 'unknown') return 1;
    if (!b.date || b.date === 'unknown') return -1;
    return b.date.localeCompare(a.date);
  });
  return rows;
}

function renderSelectedLineGames(): void {
  const container = document.querySelector('.report-line-games');
  if (!container) return;
  container.innerHTML = '';

  const title = el('div', 'report-line-games-title');
  const titleLabel = el('span', 'report-line-games-title-label');
  titleLabel.textContent = 'Line games';
  title.append(titleLabel);
  container.append(title);

  if (!selectedLine) {
    const empty = el('div', 'report-line-games-empty');
    empty.textContent = 'Select an opening to list matching games.';
    container.append(empty);
    return;
  }

  const rows = getLineGameRows(selectedLine);
  const totals = {
    win: rows.filter(r => r.result === 'win').length,
    draw: rows.filter(r => r.result === 'draw').length,
    loss: rows.filter(r => r.result === 'loss').length,
  };
  const totalLabel = el('span', 'report-line-games-total');
  totalLabel.textContent = `${formatNum(rows.length)} total`;
  title.append(totalLabel);

  const filterRow = el('div', 'report-line-games-filters');
  const filters = el('div', 'segment-picker segment-sm') as HTMLDivElement;
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Line game results');
  const opts: Array<{ key: 'win' | 'draw' | 'loss'; label: string; count: number }> = [
    { key: 'win', label: 'Win', count: totals.win },
    { key: 'draw', label: 'Draw', count: totals.draw },
    { key: 'loss', label: 'Loss', count: totals.loss },
  ];
  for (const opt of opts) {
    const segmentBtn = el('button', 'segment-btn') as HTMLButtonElement;
    segmentBtn.type = 'button';
    segmentBtn.textContent = `${opt.label} (${formatNum(opt.count)})`;
    const isSelected = lineGameResultFilter === opt.key;
    if (isSelected) segmentBtn.classList.add('selected');
    segmentBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    segmentBtn.addEventListener('click', () => {
      lineGameResultFilter = lineGameResultFilter === opt.key ? 'all' : opt.key;
      renderSelectedLineGames();
    });
    filters.append(segmentBtn);
  }
  filterRow.append(filters);
  container.append(filterRow);

  const list = el('div', 'report-line-games-list');
  let scrollTimer = 0;
  list.addEventListener('scroll', () => {
    list.classList.add('scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => list.classList.remove('scrolling'), 1000);
  }, { passive: true });
  const shown = lineGameResultFilter === 'all'
    ? rows
    : rows.filter(r => r.result === lineGameResultFilter);

  if (shown.length === 0) {
    const empty = el('div', 'report-line-games-empty');
    empty.textContent = 'No games for this result filter.';
    list.append(empty);
  } else {
    for (const row of shown) {
      const link = document.createElement('a');
      link.className = 'report-line-game-row';
      link.href = row.href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';

      const result = document.createElement('span');
      result.className = `report-line-game-result ${row.result}`;
      result.textContent = row.result === 'win' ? 'W' : row.result === 'draw' ? 'D' : 'L';

      const opp = el('span', 'report-line-game-opp');
      const oppName = row.opponent ? row.opponent : 'Game';
      const or = row.oppRating > 0 ? ` (${row.oppRating})` : '';
      opp.textContent = `${oppName}${or}`;
      const dateSpan = el('span', 'report-line-game-date');
      dateSpan.textContent = formatShortDate(row.date);
      const external = el('span', 'report-line-game-external');
      external.setAttribute('aria-hidden', 'true');
      external.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"/><path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';

      link.append(result, opp, dateSpan, external);
      list.append(link);
    }
  }

  container.append(list);
}

function extendLine(uci: string, san: string): void {
  if (!selectedLine) return;

  // If we're not at the end of the line, truncate future moves first
  if (lineViewIndex < lineFens.length - 1) {
    selectedLine.moves.splice(lineViewIndex);
    selectedLine.ucis.splice(lineViewIndex);
    lineFens.splice(lineViewIndex + 1);
    lineLastMoves.splice(lineViewIndex + 1);
  }

  // Replay all UCIs + the new one from scratch to get the new FEN
  const chess = Chess.default();
  for (const u of selectedLine.ucis) {
    const m = parseUci(u);
    if (m) chess.play(m);
  }
  const move = parseUci(uci);
  if (!move) return;
  chess.play(move);

  const newFen = makeFen(chess.toSetup());
  selectedLine.moves.push(san);
  selectedLine.ucis.push(uci);
  selectedLine.label = selectedLine.moves.join(' ');
  lineFens.push(newFen);
  lineLastMoves.push([uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]);

  lineViewIndex = lineFens.length - 1;
  updateBoardForLine();
}

// ── Helpers ──

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = text;
  return e;
}

function formatShortDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 2) return dateStr;
  const yy = parts[0].slice(-2);
  const m = parseInt(parts[1], 10);
  if (parts.length >= 3 && parts[2] !== '01') {
    return `${parseInt(parts[2], 10)}/${m}/${yy}`;
  }
  return `${m}/${yy}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toString();
}

function formatPct(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function formatSignedPct(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${formatPct(abs)}%`;
}

function formatSignedNum(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n}`;
}

function formatImpact(n: number): string {
  return n.toFixed(2).replace(/\.00$/, '');
}

function scoreSeverityClass(
  scorePct: number,
): 'score-bad' | 'score-ok' | 'score-good' {
  if (scorePct <= 40) return 'score-bad';
  if (scorePct >= 60) return 'score-good';
  return 'score-ok';
}

function priorityScaleTooltip(): string {
  return [
    'Priority = training urgency for this line.',
    '0-2: Low, mostly fine.',
    '3-6: Rating leak, practice soon.',
    '7+: Major leak, prioritize fixing.',
  ].join('\n');
}

function gamesTooltip(line: OpeningLine): string {
  return `Record in this line: ${line.wdl.wins}W ${line.wdl.draws}D ${line.wdl.losses}L `
    + `(${line.wdl.total} games).`;
}

function winRateTooltip(line: OpeningLine): string {
  const total = line.wdl.total;
  if (total <= 0) return 'Win% unavailable: no games in this line yet.';

  const wins = line.wdl.wins;
  const draws = line.wdl.draws;
  const losses = line.wdl.losses;
  return `Win% = wins / games = ${wins} / ${total} = ${line.winRate}%. `
    + `Record: ${wins}W ${draws}D ${losses}L.`;
}

function eloSwingForWdl(wdl: WDL): number {
  const ELO_PER_DECISIVE_GAME = 8;
  return (wdl.wins - wdl.losses) * ELO_PER_DECISIVE_GAME;
}

function eloSwingForLine(line: OpeningLine): number {
  return eloSwingForWdl(line.wdl);
}

function eloSwingTooltip(line: OpeningLine): string {
  const wins = line.wdl.wins;
  const losses = line.wdl.losses;
  const draws = line.wdl.draws;
  const swing = eloSwingForLine(line);
  return `Simple Elo estimate: (wins - losses) * 8 = (${wins} - ${losses}) * 8 `
    + `= ${swing > 0 ? '+' : ''}${swing}. Draws (${draws}) count as 0.`;
}

function impactTooltip(line: OpeningLine): string {
  const vsElo = line.deltaVsExpectedPct == null
    ? 'n/a'
    : `${line.deltaVsExpectedPct > 0 ? '+' : ''}${line.deltaVsExpectedPct}%`;
  const gapPts = line.wdl.total > 0 ? (line.impact / line.wdl.total) * 100 : 0;
  return [
    'Priority shows how urgently this line should be practiced.',
    '0-2: Low, mostly fine.',
    '3-6: Rating leak, practice soon.',
    '7+: Major leak, prioritize fixing.',
    `Basis: gap ${gapPts.toFixed(1)} pts x ${line.wdl.total} games.`,
    `Adjusted ${line.adjustedScorePct}% | Raw ${line.rawScorePct}% | Vs Elo ${vsElo} | CI +/-${line.scoreCiPct}.`,
  ].join('\n');
}

function winRatePct(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return Math.round((wdl.wins / wdl.total) * 100);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
