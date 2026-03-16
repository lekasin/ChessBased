import type {
  AppConfig,
  BotWeighting,
  ExplorerMove,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  MoveHistoryEntry,
  PlayerColor,
  PositionAnalysis,
} from './types';
import { RATING_OPTIONS, SPEED_OPTIONS } from './types';
import type { Key } from '@lichess-org/chessground/types';
import { getMoveHistory, getViewIndex, isViewingHistory, setAutoShapes, getOrientation, setOrientation, replayLine } from './board';
import { isMoveLocked, lockMove, unlockMove, getLockedMoves } from './repertoire';
import { findOpeningByEco, findPgnByEco } from './opening-index';
import { exportActiveOpening, exportAll } from './pgn-export';
import { getExplorerData, getExplorerCache, getPhase } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';
import { formatScore } from './engine';
import type { EngineLine } from './engine';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan, parseSan } from 'chessops/san';
import { makeUci } from 'chessops';
import {
  getExplorerMode, setExplorerMode, hasPersonalData, getPersonalConfig,
  queryPersonalExplorer, clearPersonalData, importFromLichess, importFromChesscom,
  initPersonalExplorer, getPersonalStats, setPersonalFilters, getPersonalFilters,
  getFilteredGameCount, getPersonalGames, gameMatchesFilters, isDBReady,
  type ExplorerMode, type Platform, type GameMeta,
} from './personal-explorer';
import { confirmModal, type ConfirmButton } from './confirm';
import { openPersonalImportModal } from './ui-modals';
// Circular imports from ui.ts - these work in ESM since they're only used inside function bodies
import {
  renderSystemPicker, updateMoveList, updateAlertBanner,
  getConfig, getNextMoveUci, getEvalWinPct, getLoadedGame, setLoadedGame, clearLoadedGame,
  dispatchConfigChange, dispatchNewGame, dispatchExplorerMoveClick,
  dispatchOpeningChange, dispatchModeChange, dispatchRetryExplorer, dispatchContinue,
  currentAnalysis, badgeSymbol, applySidebarTab,
} from './ui';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BAR_PCT_LABEL_ATTR = 'data-pct-label';

// Remember last engine line count so toggling on restores previous setting
let lastEngineLineCount = 3;

function fitExplorerBarLabels(root: ParentNode): void {
  const segments = root.querySelectorAll<HTMLElement>(`.explorer-bar [${BAR_PCT_LABEL_ATTR}]`);
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

function scheduleExplorerBarLabelFit(root: ParentNode): void {
  requestAnimationFrame(() => fitExplorerBarLabels(root));
}

// Whether explorer content should always be shown (manual mode, history view)
let explorerAlwaysShow = false;
// Temporary reveal during live play (reset on move)
let explorerRevealed = false;

function setExplorerAlwaysShow(show: boolean): void {
  explorerAlwaysShow = show;
}

function resetExplorerRevealed(): void {
  explorerRevealed = false;
}

function shouldShowExplorerContent(): boolean {
  return explorerAlwaysShow || explorerRevealed;
}

const EXPLORER_ROWS = 10;

function uciToSan(fen: string, uciMoves: string[], maxMoves = 6): string[] {
  const setup = parseFen(fen);
  if (!setup.isOk) return uciMoves.slice(0, maxMoves);
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return uciMoves.slice(0, maxMoves);

  const chess = pos.value;
  const sans: string[] = [];
  for (let i = 0; i < Math.min(uciMoves.length, maxMoves); i++) {
    const move = parseUci(uciMoves[i]);
    if (!move) break;
    try {
      const san = makeSan(chess, move);
      sans.push(san);
      chess.play(move);
    } catch {
      break;
    }
  }
  return sans;
}

// Top engine move UCIs from latest engine lines: uci → rank (1-based)
let engineTopMoves: Map<string, number> = new Map();

function renderEngineLines(lines: EngineLine[], fen: string): void {
  const el = document.getElementById('engine-lines');
  if (!el) return;

  // Update top engine moves and refresh explorer highlights
  const newMap = new Map<string, number>();
  for (const l of lines) {
    const uci = l.pv[0];
    if (uci && !newMap.has(uci)) newMap.set(uci, l.rank);
  }
  const changed = newMap.size !== engineTopMoves.size || [...newMap].some(([u, r]) => engineTopMoves.get(u) !== r);
  engineTopMoves = newMap;
  if (changed) refreshEngineHighlights();

  if (lines.length === 0) {
    el.innerHTML = '';
    return;
  }

  const sideToMove = fen.split(' ')[1];
  const moveNum = parseInt(fen.split(' ')[5] || '1');

  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const evalText = formatScore(line.score);
    const isPositive = line.score.type === 'mate' ? line.score.value > 0 : line.score.value > 0;
    const isNeutral = line.score.type === 'cp' && Math.abs(line.score.value) < 20;
    const evalClass = isNeutral ? 'neutral' : isPositive ? 'positive' : 'negative';
    const bestClass = i === 0 ? ' engine-line-best' : '';

    const sans = uciToSan(fen, line.pv);
    let moveStr = '';
    let curMoveNum = moveNum;
    let whiteToMove = sideToMove === 'w';
    for (let j = 0; j < sans.length; j++) {
      if (whiteToMove) {
        moveStr += `${curMoveNum}.\u2009${sans[j]} `;
      } else {
        if (j === 0) moveStr += `${curMoveNum}...\u2009`;
        moveStr += `${sans[j]} `;
        curMoveNum++;
      }
      whiteToMove = !whiteToMove;
    }

    const firstUci = line.pv[0] || '';
    html += `<div class="engine-line${bestClass}" data-uci="${firstUci}">
      <span class="engine-line-rank">${line.rank}</span>
      <span class="engine-line-eval ${evalClass}">${evalText}</span>
      <span class="engine-line-moves">${moveStr.trim()}</span>
    </div>`;
  }

  // Build header row with gear config
  const headerHtml = `<div class="engine-lines-header">
    <span class="engine-lines-title">Engine</span>
    <div class="engine-lines-cog-wrap">
      <button class="engine-lines-cog" data-tooltip="Configure engine lines">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/>
        </svg>
      </button>
      <div class="engine-lines-config hidden">
        ${[1, 2, 3].map(n => `<button class="engine-lines-config-opt${getConfig().engineLineCount === n ? ' selected' : ''}" data-lines="${n}">${n} line${n > 1 ? 's' : ''}</button>`).join('')}
      </div>
    </div>
  </div>`;

  el.innerHTML = headerHtml + html;

  // Gear icon toggles config popover
  const cogBtn = el.querySelector('.engine-lines-cog')!;
  const configPanel = el.querySelector('.engine-lines-config')!;
  cogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    configPanel.classList.toggle('hidden');
  });

  // Line count options
  configPanel.querySelectorAll('.engine-lines-config-opt').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = parseInt((btn as HTMLElement).dataset.lines!);
      getConfig().engineLineCount = n;
      lastEngineLineCount = n;
      configPanel.classList.add('hidden');
      configPanel.querySelectorAll('.engine-lines-config-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      dispatchConfigChange(getConfig());
    });
  });

  // Hover arrows + click to play (same pattern as explorer)
  el.querySelectorAll('.engine-line').forEach((row) => {
    const uci = (row as HTMLElement).dataset.uci;
    if (!uci || uci.length < 4) return;
    const orig = uci.slice(0, 2) as Key;
    const dest = uci.slice(2, 4) as Key;

    row.addEventListener('mouseenter', () => {
      setAutoShapes([{ orig, dest, brush: 'blue' }]);
    });
    row.addEventListener('mouseleave', () => {
      setAutoShapes([]);
    });
    row.addEventListener('click', () => {
      dispatchExplorerMoveClick(uci);
    });
  });
}

function setEngineLinesVisible(visible: boolean): void {
  const el = document.getElementById('engine-lines');
  if (el) el.classList.toggle('hidden', !visible);
  if (!visible) {
    engineTopMoves.clear();
    refreshEngineHighlights();
  }
}

function engineStarHtml(rank: number): string {
  const cls = rank === 1 ? 'engine-star-gold' : rank === 2 ? 'engine-star-silver' : 'engine-star-bronze';
  return `<span class="engine-star ${cls}" data-tooltip="Engine #${rank}">&#9733;</span>`;
}

function refreshEngineHighlights(): void {
  const rows = document.querySelectorAll('#explorer-moves .explorer-move[data-uci]');
  rows.forEach((row) => {
    const uci = (row as HTMLElement).dataset.uci;
    if (!uci) return;
    const badgeCol = row.querySelector('.explorer-badge-col');
    if (!badgeCol) return;
    // Remove existing engine star
    badgeCol.querySelector('.engine-star')?.remove();
    const rank = engineTopMoves.get(uci);
    if (rank) {
      badgeCol.insertAdjacentHTML('afterbegin', engineStarHtml(rank));
    }
  });
}

let explorerFiltersOpen = false;
let recentGamesFiltersOpen = false;
let personalColorFilter: 'both' | 'white' | 'black' = 'white';
let filterClickOutsideHandler: ((e: MouseEvent) => void) | null = null;



function renderPersonalColorPicker(el: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'personal-color-picker';

  const picker = document.createElement('div');
  picker.className = 'segment-picker segment-sm';
  const labels: Record<'both' | 'white' | 'black', string> = {
    both: 'Both',
    white: 'My Side',
    black: 'Their Side',
  };
  for (const value of ['both', 'white', 'black'] as const) {
    const btn = document.createElement('button');
    btn.className = 'segment-btn' + (personalColorFilter === value ? ' selected' : '');
    btn.textContent = labels[value];
    btn.addEventListener('click', () => {
      personalColorFilter = value;
      updateExplorerPanel();
    });
    picker.append(btn);
  }

  wrap.append(picker);

  const cfg = getPersonalConfig();
  if (cfg) {
    const filterBtn = document.createElement('button');
    filterBtn.className = 'personal-action-btn' + (explorerFiltersOpen ? ' active' : '');
    filterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>`;
    filterBtn.setAttribute('data-tooltip', 'Filter games');
    filterBtn.addEventListener('click', () => {
      explorerFiltersOpen = !explorerFiltersOpen;
      updateExplorerPanel();
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'personal-action-btn';
    refreshBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
    refreshBtn.setAttribute('data-tooltip', 'Refresh games');
    refreshBtn.addEventListener('click', () => refreshExplorerGames(refreshBtn));

    wrap.append(filterBtn, refreshBtn);
  }

  el.append(wrap);
}

function renderPersonalFilterPanel(el: HTMLElement, context: 'explorer' | 'recent-games' = 'explorer'): void {
  // Clean up previous click-outside handler
  if (filterClickOutsideHandler) {
    document.removeEventListener('mousedown', filterClickOutsideHandler);
    filterClickOutsideHandler = null;
  }

  const isOpen = context === 'recent-games' ? recentGamesFiltersOpen : explorerFiltersOpen;
  if (!isOpen) return;
  const stats = getPersonalStats();
  if (!stats) return;
  const filters = getPersonalFilters();

  const panel = document.createElement('div');
  panel.className = 'personal-filter-panel';

  // Color filter (recent-games only)
  if (context === 'recent-games') {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Color</div>`;
    const picker = document.createElement('div');
    picker.className = 'segment-picker segment-sm';
    for (const value of ['all', 'white', 'black'] as const) {
      const btn = document.createElement('button');
      btn.className = 'segment-btn' + (recentGamesColorFilter === value ? ' selected' : '');
      btn.textContent = value === 'all' ? 'All' : value === 'white' ? 'White' : 'Black';
      btn.addEventListener('click', () => {
        recentGamesColorFilter = value;
        picker.querySelectorAll('.segment-btn').forEach(b => b.classList.toggle('selected', b === btn));
        updateRecentGamesList();
      });
      picker.append(btn);
    }
    section.append(picker);
    panel.append(section);
  }

  // Time class chips
  if (stats.timeClasses.length > 1) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Time control</div>`;
    const chips = document.createElement('div');
    chips.className = 'chip-grid';
    const activeTC = filters.timeClasses ?? [];
    for (const tc of stats.timeClasses) {
      const chip = document.createElement('button');
      chip.className = 'chip chip-sm' + (activeTC.length === 0 || activeTC.includes(tc) ? ' selected' : '');
      chip.dataset.tc = tc;
      chip.textContent = tc.charAt(0).toUpperCase() + tc.slice(1);
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        applyFiltersFromPanel(panel, context);
      });
      chips.append(chip);
    }
    section.append(chips);
    panel.append(section);
  }

  // Rating range (explorer only)
  if (context === 'explorer' && stats.minRating < stats.maxRating) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Your rating</div>`;
    const row = document.createElement('div');
    row.className = 'personal-filter-range';
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.placeholder = String(stats.minRating);
    minInput.className = 'filter-input';
    minInput.id = 'filter-min-rating';
    if (filters.minRating != null) minInput.value = String(filters.minRating);
    const sep = document.createElement('span');
    sep.className = 'filter-range-sep';
    sep.textContent = '–';
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.placeholder = String(stats.maxRating);
    maxInput.className = 'filter-input';
    maxInput.id = 'filter-max-rating';
    if (filters.maxRating != null) maxInput.value = String(filters.maxRating);

    const applyRating = () => applyFiltersFromPanel(panel, context);
    minInput.addEventListener('change', applyRating);
    maxInput.addEventListener('change', applyRating);

    row.append(minInput, sep, maxInput);
    section.append(row);
    panel.append(section);
  }

  // Date range (explorer only)
  if (context === 'explorer' && stats.minDate && stats.maxDate) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Date range</div>`;

    // Quick presets
    const now = new Date();
    const toYmd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const parseYmd = (ymd: string) => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    const todayYmd = toYmd(now);
    const rangeEndYmd = stats.maxDate < todayYmd ? stats.maxDate : todayYmd;
    const rangeEnd = parseYmd(rangeEndYmd);
    const daysAgo = (n: number) => {
      const d = new Date(rangeEnd);
      d.setDate(rangeEnd.getDate() - n);
      return toYmd(d);
    };

    const presets: Array<{ label: string; since?: string; until?: string }> = [
      { label: 'All', since: undefined, until: undefined },
      { label: 'Last 7d', since: daysAgo(6), until: rangeEndYmd },
      { label: 'Last 30d', since: daysAgo(29), until: rangeEndYmd },
      { label: 'Last 90d', since: daysAgo(89), until: rangeEndYmd },
    ];

    const presetRow = document.createElement('div');
    presetRow.className = 'chip-grid';
    for (const preset of presets) {
      const chip = document.createElement('button');
      chip.className = 'chip chip-sm';
      if ((filters.sinceDate ?? undefined) === preset.since && (filters.untilDate ?? undefined) === preset.until) {
        chip.classList.add('selected');
      }
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        const current = getPersonalFilters();
        // Toggle off if already selected
        if ((current.sinceDate ?? undefined) === preset.since && (current.untilDate ?? undefined) === preset.until) {
          setPersonalFilters({
            ...current,
            sinceDate: undefined,
            untilDate: undefined,
            sinceMonth: undefined,
            untilMonth: undefined,
          });
        } else {
          setPersonalFilters({
            ...current,
            sinceDate: preset.since,
            untilDate: preset.until,
            sinceMonth: undefined,
            untilMonth: undefined,
          });
        }
        refreshPersonalMoves();
        // Rebuild filter panel to update preset + picker state
        const wrap = panel.parentElement!;
        panel.remove();
        renderPersonalFilterPanel(wrap, context);
      });
      presetRow.append(chip);
    }
    section.append(presetRow);

    // Custom pickers
    const row = document.createElement('div');
    row.className = 'personal-filter-range';

    const sinceInput = document.createElement('input');
    sinceInput.type = 'date';
    sinceInput.className = 'filter-input';
    sinceInput.id = 'filter-since-date';
    sinceInput.min = stats.minDate;
    sinceInput.max = stats.maxDate;
    if (filters.sinceDate) sinceInput.value = filters.sinceDate;

    const applyDate = () => applyFiltersFromPanel(panel, context);
    sinceInput.addEventListener('change', applyDate);
    const sep = document.createElement('span');
    sep.className = 'filter-range-sep';
    sep.textContent = '–';
    const untilInput = document.createElement('input');
    untilInput.type = 'date';
    untilInput.className = 'filter-input';
    untilInput.id = 'filter-until-date';
    untilInput.min = stats.minDate;
    untilInput.max = stats.maxDate;
    if (filters.untilDate) untilInput.value = filters.untilDate;
    untilInput.addEventListener('change', applyDate);

    row.append(sinceInput, sep, untilInput);
    section.append(row);
    panel.append(section);
  }

  // Reset button (color is managed by the board-matching checkbox, not here)
  const hasActiveFilters = context === 'recent-games'
    ? (filters.timeClasses && filters.timeClasses.length > 0)
    : (filters.timeClasses && filters.timeClasses.length > 0) ||
      filters.minRating != null || filters.maxRating != null ||
      filters.sinceDate || filters.untilDate ||
      filters.sinceMonth || filters.untilMonth;
  if (hasActiveFilters) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn sm ghost';
    resetBtn.textContent = 'Reset filters';
    resetBtn.addEventListener('click', () => {
      if (context === 'recent-games') {
        // Only reset time classes, preserve rating/date filters
        const current = getPersonalFilters();
        setPersonalFilters({ ...current, timeClasses: undefined });
        updateRecentGamesPanel();
      } else {
        setPersonalFilters({});
        updateExplorerPanel();
      }
    });
    panel.append(resetBtn);
  }

  el.append(panel);

  // Close on click outside
  requestAnimationFrame(() => {
    filterClickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.personal-filter-panel, .personal-color-picker, .recent-games-header, .recent-games-filters')) return;
      if (context === 'recent-games') recentGamesFiltersOpen = false;
      else explorerFiltersOpen = false;
      document.removeEventListener('mousedown', filterClickOutsideHandler!);
      filterClickOutsideHandler = null;
      if (context === 'recent-games') updateRecentGamesPanel();
      else updateExplorerPanel();
    };
    document.addEventListener('mousedown', filterClickOutsideHandler);
  });
}

function applyFiltersFromPanel(panel: HTMLElement, context: 'explorer' | 'recent-games' = 'explorer'): void {
  // Collect time class chips
  const allChips = panel.querySelectorAll('.chip[data-tc]');
  const selectedChips = panel.querySelectorAll('.chip[data-tc].selected');
  let timeClasses: string[] | undefined;
  if (selectedChips.length > 0 && selectedChips.length < allChips.length) {
    timeClasses = Array.from(selectedChips).map(c => (c as HTMLElement).dataset.tc!);
  }

  if (context === 'recent-games') {
    // Only update time classes, preserve existing rating/date/color filters
    const current = getPersonalFilters();
    setPersonalFilters({ ...current, timeClasses });
    updateRecentGamesList();
    return;
  }

  // Collect rating range
  const minEl = panel.querySelector('#filter-min-rating') as HTMLInputElement | null;
  const maxEl = panel.querySelector('#filter-max-rating') as HTMLInputElement | null;
  const minRating = minEl?.value ? parseInt(minEl.value) : undefined;
  const maxRating = maxEl?.value ? parseInt(maxEl.value) : undefined;

  // Collect date range
  const sinceEl = panel.querySelector('#filter-since-date') as HTMLInputElement | null;
  const untilEl = panel.querySelector('#filter-until-date') as HTMLInputElement | null;
  const sinceDate = sinceEl?.value || undefined;
  const untilDate = untilEl?.value || undefined;

  // Resolve color from picker relative to board orientation
  let color: 'white' | 'black' | undefined;
  if (personalColorFilter !== 'both') {
    const orientation = getOrientation();
    const opposite = orientation === 'white' ? 'black' : 'white';
    color = personalColorFilter === 'white' ? orientation : opposite;
  }

  setPersonalFilters({
    timeClasses,
    minRating,
    maxRating,
    sinceDate,
    untilDate,
    sinceMonth: undefined,
    untilMonth: undefined,
    color,
  });
  refreshPersonalMoves();
}

/** Refresh only the move rows + info text without rebuilding the filter panel */
function refreshPersonalMoves(): void {
  const el = document.getElementById('explorer-moves')!;
  const { fen } = getExplorerData();

  // Remove old move rows and empty state
  el.querySelectorAll('.explorer-header, .explorer-list, .personal-empty-state').forEach(e => e.remove());

  const personalData = queryPersonalExplorer(fen);
  const moves = personalData?.moves ?? [];
  if (moves.length === 0) {
    const noData = document.createElement('div');
    noData.className = 'personal-empty-state';
    noData.style.padding = '16px';
    const totalGames = getFilteredGameCount();
    noData.textContent = totalGames > 0
      ? `None of your ${totalGames.toLocaleString()} games reached this position.`
      : 'No games in this position.';
    el.append(noData);
    return;
  }

  renderMoveRows(moves, fen, null, el);
  if (!explorerFiltersOpen) updateRecentGamesPanel();
}

function renderPersonalLoadingState(el: HTMLElement): void {
  let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
  html += '<div class="explorer-list explorer-skeleton">';
  for (let i = 0; i < EXPLORER_ROWS; i++) {
    html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
  }
  html += '</div>';
  const container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) el.append(container.firstChild);
}

function renderPersonalEmptyState(el: HTMLElement): void {
  const empty = document.createElement('div');
  empty.className = 'personal-empty-state';
  empty.innerHTML = `<div>No games imported yet.</div>`;
  const importBtn = document.createElement('button');
  importBtn.className = 'btn btn-primary';
  importBtn.textContent = 'Import games';
  importBtn.addEventListener('click', () => openPersonalImportModal());
  empty.append(importBtn);
  el.append(empty);
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function createMonthPicker(
  id: string,
  value: string,
  minMonth: string,
  maxMonth: string,
  placeholder: string,
  onChange: () => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'month-picker';
  wrap.id = id;
  wrap.dataset.value = value;

  const trigger = document.createElement('button');
  trigger.className = 'month-picker-trigger';
  trigger.type = 'button';
  if (value) {
    const [y, m] = value.split('-');
    trigger.textContent = `${MONTH_ABBR[parseInt(m) - 1]} ${y}`;
    trigger.classList.add('has-value');
  } else {
    trigger.textContent = placeholder;
  }

  let dropdown: HTMLElement | null = null;
  let closeHandler: ((e: MouseEvent) => void) | null = null;

  const minY = parseInt(minMonth.split('-')[0]);
  const maxY = parseInt(maxMonth.split('-')[0]);

  function isInRange(year: number, month: number): boolean {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    return key >= minMonth && key <= maxMonth;
  }

  function openDropdown() {
    if (dropdown) { closeDropdown(); return; }

    const currentValue = wrap.dataset.value;
    let viewYear = currentValue ? parseInt(currentValue.split('-')[0]) : maxY;

    dropdown = document.createElement('div');
    dropdown.className = 'month-picker-dropdown';

    function render() {
      dropdown!.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'month-picker-header';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'month-picker-nav';
      prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
      prevBtn.disabled = viewYear <= minY;
      prevBtn.addEventListener('click', (e) => { e.stopPropagation(); viewYear--; render(); });

      const yearLabel = document.createElement('span');
      yearLabel.className = 'month-picker-year';
      yearLabel.textContent = String(viewYear);

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'month-picker-nav';
      nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
      nextBtn.disabled = viewYear >= maxY;
      nextBtn.addEventListener('click', (e) => { e.stopPropagation(); viewYear++; render(); });

      header.append(prevBtn, yearLabel, nextBtn);
      dropdown!.append(header);

      const grid = document.createElement('div');
      grid.className = 'month-picker-grid';

      for (let m = 1; m <= 12; m++) {
        const key = `${viewYear}-${String(m).padStart(2, '0')}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'month-picker-cell';
        btn.textContent = MONTH_ABBR[m - 1];

        const inRange = isInRange(viewYear, m);
        if (!inRange) {
          btn.disabled = true;
          btn.classList.add('out-of-range');
        }
        if (key === wrap.dataset.value) {
          btn.classList.add('selected');
        }

        if (inRange) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            wrap.dataset.value = key;
            trigger.textContent = `${MONTH_ABBR[m - 1]} ${viewYear}`;
            trigger.classList.add('has-value');
            closeDropdown();
            onChange();
          });
        }
        grid.append(btn);
      }

      dropdown!.append(grid);

      // Clear button
      if (wrap.dataset.value) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'month-picker-clear';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          wrap.dataset.value = '';
          trigger.textContent = placeholder;
          trigger.classList.remove('has-value');
          closeDropdown();
          onChange();
        });
        dropdown!.append(clearBtn);
      }
    }

    render();
    wrap.append(dropdown);

    requestAnimationFrame(() => {
      closeHandler = (e: MouseEvent) => {
        if (!wrap.contains(e.target as Node)) closeDropdown();
      };
      document.addEventListener('mousedown', closeHandler);
    });
  }

  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    if (closeHandler) {
      document.removeEventListener('mousedown', closeHandler);
      closeHandler = null;
    }
  }

  trigger.addEventListener('click', (e) => { e.stopPropagation(); openDropdown(); });
  wrap.append(trigger);
  return wrap;
}

function renderMoveRows(
  moves: ExplorerMove[],
  fen: string,
  analysis: PositionAnalysis | null,
  el: HTMLElement,
): void {
  const visibleMoves = moves.slice(0, EXPLORER_ROWS);
  const totalAllMoves = moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);

  const pctValues = visibleMoves.map(m => {
    const t = m.white + m.draws + m.black;
    return totalAllMoves > 0 ? (t / totalAllMoves) * 100 : 0;
  });

  let html = '<div class="explorer-header"><span>Move</span><span></span><span>Play rate</span><span>Games</span><span>Results</span><span></span></div>';
  html += '<div class="explorer-list">';

  for (let i = 0; i < visibleMoves.length; i++) {
    const move = visibleMoves[i];
    const total = move.white + move.draws + move.black;
    const pctNum = pctValues[i];
    const pct = pctNum.toFixed(1);
    const locked = isMoveLocked(fen, move.uci);
    const played = getNextMoveUci() === move.uci ? ' played' : '';
    const lockedCls = locked ? ' locked' : '';

    const wPct = total > 0 ? Math.round((move.white / total) * 100) : 0;
    const dPct = total > 0 ? Math.round((move.draws / total) * 100) : 0;
    const bPct = 100 - wPct - dPct;

    const badge = analysis ? getBadgeForMove(analysis, move.uci) : null;
    const badgeTooltipMap: Record<string, string> = { best: 'Best move', blunder: 'Mistake', trap: 'Popular trap' };
    const badgeTooltipAttr = badge && badge !== 'book' && badgeTooltipMap[badge] ? ` data-tooltip="${badgeTooltipMap[badge]}"` : '';
    const badgeHtml = badge && badge !== 'book' ? `<span class="move-badge badge-${badge.replace('_', '-')}"${badgeTooltipAttr}>${badgeSymbol(badge)}</span>` : '';
    const engineRank = engineTopMoves.get(move.uci);
    const starHtml = engineRank ? engineStarHtml(engineRank) : '';

    html += `<div class="explorer-move${played}${lockedCls}" data-uci="${move.uci}">
      <span class="explorer-san">${move.san}</span>
      <span class="explorer-badge-col">${starHtml}${badgeHtml}</span>
      <span class="explorer-pct"><span class="pct-fill" style="width:${pctNum}%"></span><span class="pct-label">${pct}%</span></span>
      <span class="explorer-games">${formatGames(total)}</span>
      <span class="explorer-bar">
        <span class="bar-white" style="width:${wPct}%" ${BAR_PCT_LABEL_ATTR}="${wPct}%">${wPct}%</span>
        <span class="bar-draw-neutral" style="width:${dPct}%" ${BAR_PCT_LABEL_ATTR}="${dPct}%">${dPct}%</span>
        <span class="bar-black" style="width:${bPct}%" ${BAR_PCT_LABEL_ATTR}="${bPct}%">${bPct}%</span>
      </span>
      <button class="lock-btn ${locked ? 'locked' : ''}"
              data-uci="${move.uci}" data-fen="${encodeURIComponent(fen)}"
              title="${locked ? 'Remove from opening' : 'Add to opening'}">
        ${locked
          ? '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>'
        }
      </button>
    </div>`;
  }

  for (let i = visibleMoves.length; i < EXPLORER_ROWS; i++) {
    html += `<div class="explorer-move empty-row">
      <span class="skeleton-bar" style="width:24px"></span>
      <span></span>
      <span class="skeleton-bar" style="width:32px"></span>
      <span class="skeleton-bar" style="width:20px"></span>
      <span class="skeleton-bar" style="width:100%"></span>
      <span></span>
    </div>`;
  }

  html += '</div>';

  const container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) el.append(container.firstChild);
  scheduleExplorerBarLabelFit(el);

  wireExplorerRowEvents(el, fen);
}

let lastToggledUci: string | null = null;

function wireExplorerRowEvents(el: HTMLElement, fen: string): void {
  // Animate lock button that was just toggled
  if (lastToggledUci) {
    const btn = el.querySelector(`.lock-btn[data-uci="${lastToggledUci}"]`) as HTMLElement | null;
    if (btn) {
      btn.classList.add('lock-snap');
      btn.addEventListener('animationend', () => btn.classList.remove('lock-snap'), { once: true });
    }
    lastToggledUci = null;
  }

  el.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const uci = target.dataset.uci!;
      const btnFen = decodeURIComponent(target.dataset.fen!);
      lastToggledUci = uci;
      if (isMoveLocked(btnFen, uci)) {
        unlockMove(btnFen, uci);
      } else {
        if (lockMove(btnFen, uci)) {
          renderSystemPicker();
          dispatchOpeningChange();
        }
      }
      updateExplorerPanel();
    });
  });

  el.querySelectorAll('.explorer-move:not(.empty-row)').forEach((row) => {
    row.addEventListener('mouseenter', () => {
      const uci = (row as HTMLElement).dataset.uci;
      if (!uci || uci.length < 4) return;
      const orig = uci.slice(0, 2) as Key;
      const dest = uci.slice(2, 4) as Key;
      setAutoShapes([{ orig, dest, brush: 'blue' }]);
    });
    row.addEventListener('mouseleave', () => {
      setAutoShapes([]);
    });
  });

  el.querySelectorAll('.explorer-move').forEach((row) => {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lock-btn')) return;
      const uci = (row as HTMLElement).dataset.uci!;
      dispatchExplorerMoveClick(uci);
    });
  });
}

function boardFen(): string {
  const history = getMoveHistory();
  const vi = getViewIndex();
  if (vi === 0) return STARTING_FEN;
  return history[vi - 1].fen;
}

function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function closeAllDropdowns(): void {
  document.querySelectorAll('.explorer-cog-popover').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.engine-lines-config').forEach(p => p.classList.add('hidden'));
}

function updateExplorerPanel(): void {
  const el = document.getElementById('explorer-moves')!;
  el.innerHTML = '';

  const mode = getExplorerMode();
  const { fen, error } = getExplorerData();
  const currentBoardFen = boardFen();

  // Explorer data doesn't match the board — show loading skeleton
  if (mode === 'database' && !error && fenKey(fen) !== fenKey(currentBoardFen)) {
    let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
    html += '<div class="explorer-list explorer-skeleton">';
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
    }
    html += '</div>';
    const container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) el.append(container.firstChild);
    return;
  }

  if (mode === 'personal') {
    if (!isDBReady()) {
      renderPersonalLoadingState(el);
      return;
    }
    if (!hasPersonalData()) {
      renderPersonalEmptyState(el);
      return;
    }

    // Apply color filter from picker (resolve relative to board orientation)
    let targetColor: 'white' | 'black' | undefined;
    if (personalColorFilter === 'both') {
      targetColor = undefined;
    } else {
      const orientation = getOrientation();
      const opposite = orientation === 'white' ? 'black' : 'white';
      targetColor = personalColorFilter === 'white' ? orientation : opposite;
    }
    const current = getPersonalFilters();
    if (current.color !== targetColor) {
      setPersonalFilters({ ...current, color: targetColor });
    }

    renderPersonalColorPicker(el);

    if (explorerFiltersOpen) {
      const infoWrap = document.createElement('div');
      infoWrap.className = 'personal-info-wrap';
      renderPersonalFilterPanel(infoWrap);
      el.append(infoWrap);
    }

    const personalData = queryPersonalExplorer(currentBoardFen);
    const moves = personalData?.moves ?? [];
    if (moves.length === 0) {
      const noData = document.createElement('div');
      noData.className = 'personal-empty-state';
      noData.style.padding = '16px';
      const totalGames = getFilteredGameCount();
      noData.textContent = totalGames > 0
        ? `None of your ${totalGames.toLocaleString()} games reached this position.`
        : 'No games in this position.';
      el.append(noData);
      updateRecentGamesPanel();
      return;
    }

    // No analysis badges in personal mode
    renderMoveRows(moves, currentBoardFen, null, el);
    updateRecentGamesPanel();
    return;
  }

  // Database mode — original logic
  const showContent = shouldShowExplorerContent();
  const { data } = getExplorerData();
  const moves = data?.moves ?? [];

  // Info bar (matches personal tab height)
  const infoBar = document.createElement('div');
  infoBar.className = 'database-info-bar';
  const openingName = data?.opening?.name;
  if (openingName) {
    infoBar.innerHTML = `<span class="database-opening-name">${openingName}</span>`;
  } else {
    infoBar.innerHTML = `<span class="database-opening-name text-muted">Lichess database</span>`;
  }
  const totalGames = moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
  if (totalGames > 0) {
    infoBar.innerHTML += `<span class="database-game-count">${formatGames(totalGames)}</span>`;
  }

  // Cog icon for bot settings popover
  const cogWrap = document.createElement('div');
  cogWrap.className = 'explorer-cog-wrap';
  const cogBtn = document.createElement('button');
  cogBtn.className = 'explorer-cog-btn';
  cogBtn.title = 'Explorer settings';
  cogBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/></svg>';

  const popover = document.createElement('div');
  popover.className = 'explorer-cog-popover hidden';
  popover.addEventListener('click', (e) => e.stopPropagation());

  // Top moves slider
  const topNLabel = document.createElement('label');
  topNLabel.className = 'cog-popover-label';
  topNLabel.textContent = `Top moves: ${getConfig().topMoves}`;
  const topNSlider = document.createElement('input');
  topNSlider.type = 'range';
  topNSlider.min = '1';
  topNSlider.max = '10';
  topNSlider.value = String(getConfig().topMoves);
  topNSlider.addEventListener('input', () => {
    getConfig().topMoves = parseInt(topNSlider.value);
    topNLabel.textContent = `Top moves: ${getConfig().topMoves}`;
    dispatchConfigChange(getConfig());
  });

  // Bot min play rate slider
  const playRateLabel = document.createElement('label');
  playRateLabel.className = 'cog-popover-label';
  playRateLabel.textContent = `Min play rate: ${getConfig().botMinPlayRatePct}%`;
  const playRateSlider = document.createElement('input');
  playRateSlider.type = 'range';
  playRateSlider.min = '1';
  playRateSlider.max = '30';
  playRateSlider.value = String(getConfig().botMinPlayRatePct);
  playRateSlider.addEventListener('input', () => {
    getConfig().botMinPlayRatePct = parseInt(playRateSlider.value);
    playRateLabel.textContent = `Min play rate: ${getConfig().botMinPlayRatePct}%`;
    dispatchConfigChange(getConfig());
  });

  // Bot weighting segment
  const weightLabel = document.createElement('label');
  weightLabel.className = 'cog-popover-label';
  weightLabel.textContent = 'Move selection';
  const weightSegment = document.createElement('div');
  weightSegment.className = 'segment-picker segment-sm';
  for (const opt of [{ value: 'weighted' as BotWeighting, label: 'Weighted' }, { value: 'equal' as BotWeighting, label: 'Equal' }]) {
    const btn = document.createElement('button');
    btn.className = `segment-btn${getConfig().botWeighting === opt.value ? ' selected' : ''}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      if (getConfig().botWeighting === opt.value) return;
      getConfig().botWeighting = opt.value;
      weightSegment.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      dispatchConfigChange(getConfig());
    });
    weightSegment.append(btn);
  }

  // Rating chips
  const ratingsLabel = document.createElement('label');
  ratingsLabel.className = 'cog-popover-label';
  ratingsLabel.textContent = 'Ratings';
  const ratingsGrid = document.createElement('div');
  ratingsGrid.className = 'chip-grid';
  for (const r of RATING_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = 'chip chip-sm';
    if (getConfig().ratings.includes(r)) chip.classList.add('selected');
    chip.textContent = String(r);
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      getConfig().ratings = Array.from(ratingsGrid.querySelectorAll('.chip.selected'))
        .map(c => Number(c.textContent)).sort((a, b) => a - b);
      dispatchConfigChange(getConfig());
    });
    ratingsGrid.append(chip);
  }

  // Time control chips
  const speedsLabel = document.createElement('label');
  speedsLabel.className = 'cog-popover-label';
  speedsLabel.textContent = 'Time controls';
  const speedsGrid = document.createElement('div');
  speedsGrid.className = 'chip-grid';
  for (const s of SPEED_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = 'chip chip-sm';
    if (getConfig().speeds.includes(s)) chip.classList.add('selected');
    chip.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    chip.dataset.speed = s;
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      getConfig().speeds = Array.from(speedsGrid.querySelectorAll('.chip.selected'))
        .map(c => (c as HTMLElement).dataset.speed!);
      dispatchConfigChange(getConfig());
    });
    speedsGrid.append(chip);
  }

  const divider = document.createElement('hr');
  divider.className = 'cog-popover-divider';

  // Lichess API token (collapsed by default)
  const tokenToggle = document.createElement('button');
  tokenToggle.className = 'token-toggle';
  tokenToggle.textContent = getConfig().lichessToken ? 'Custom token \u2713' : 'Use own Lichess token';
  const tokenSection = document.createElement('div');
  tokenSection.className = 'token-section hidden';
  const tokenWrap = document.createElement('div');
  tokenWrap.className = 'token-input-wrap';
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'token-input';
  tokenInput.placeholder = 'lip_...';
  tokenInput.value = getConfig().lichessToken || '';
  tokenInput.spellcheck = false;
  tokenInput.autocomplete = 'off';
  tokenInput.addEventListener('change', () => {
    const val = tokenInput.value.trim();
    getConfig().lichessToken = val;
    tokenToggle.textContent = val ? 'Custom token \u2713' : 'Use own Lichess token';
    dispatchConfigChange(getConfig());
  });
  tokenWrap.append(tokenInput);
  const tokenHint = document.createElement('a');
  tokenHint.className = 'token-hint';
  tokenHint.href = 'https://lichess.org/account/oauth/token/create';
  tokenHint.target = '_blank';
  tokenHint.rel = 'noopener';
  tokenHint.textContent = 'Create token (no scopes needed)';
  tokenSection.append(tokenWrap, tokenHint);
  tokenToggle.addEventListener('click', () => {
    tokenSection.classList.toggle('hidden');
  });

  const divider2 = document.createElement('hr');
  divider2.className = 'cog-popover-divider';

  popover.append(ratingsLabel, ratingsGrid, speedsLabel, speedsGrid, divider, topNLabel, topNSlider, playRateLabel, playRateSlider, weightLabel, weightSegment, divider2, tokenToggle, tokenSection);

  cogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !popover.classList.contains('hidden');
    closeAllDropdowns();
    if (!isOpen) popover.classList.remove('hidden');
  });

  cogWrap.append(cogBtn);
  infoBar.append(cogWrap, popover);
  el.append(infoBar);

  if (error || !showContent) {
    const loading = !data && !error;
    let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
    html += `<div class="explorer-list explorer-skeleton${loading ? '' : ' skeleton-static'}">`;
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += `<div class="explorer-move${loading ? ' skeleton-row' : ''}">&nbsp;</div>`;
    }
    if (error) {
      const isRetrying = error.includes('retrying');
      html += '<div class="explorer-hint explorer-hint-error">';
      if (isRetrying) {
        html += '<div class="explorer-error-spinner"></div>';
        html += `<span>${error}</span>`;
        html += '<span class="explorer-error-sub">Retrying automatically</span>';
      } else {
        const isNetwork = error.startsWith('network:');
        const displayMsg = error.replace(/^(network|ratelimit|error):/, '');
        html += '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
        html += `<span>${displayMsg}</span>`;
        if (isNetwork) {
          html += '<span class="explorer-error-sub">Check your internet connection</span>';
        }
        html += '<button class="btn btn-sm explorer-error-retry">Retry</button>';
      }
      if (hasPersonalData()) {
        html += '<button class="btn btn-sm explorer-error-switch">Switch to My Games</button>';
      }
      html += '</div>';
    } else {
      html += '<div class="explorer-hint">Moves hidden while you think \u2014 click to peek</div>';
    }
    html += '</div>';
    const container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) el.append(container.firstChild);

    const list = el.querySelector('.explorer-list')!;
    if (error) {
      const retryBtn = list.querySelector('.explorer-error-retry');
      retryBtn?.addEventListener('click', () => dispatchRetryExplorer());
      const switchBtn = list.querySelector('.explorer-error-switch');
      switchBtn?.addEventListener('click', () => applySidebarTab('personal'));
    } else {
      list.addEventListener('click', () => {
        explorerRevealed = true;
        updateExplorerPanel();
      });
    }
    return;
  }

  // Out-of-book / no moves empty state
  if (moves.length === 0 && data) {
    const phase = getPhase();
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'explorer-empty-state';
    if (phase === 'OUT_OF_BOOK' || phase === 'GAME_OVER') {
      const msgEl = document.createElement('span');
      msgEl.textContent = 'No moves found in the opening database';
      emptyDiv.append(msgEl);
      const newGameBtn = document.createElement('button');
      newGameBtn.className = 'btn btn-sm';
      newGameBtn.textContent = 'New game';
      newGameBtn.addEventListener('click', () => dispatchNewGame());
      emptyDiv.append(newGameBtn);
    } else {
      emptyDiv.textContent = 'No moves in the database for this position.';
    }
    el.append(emptyDiv);
    updateRecentGamesPanel();
    return;
  }

  const showBadges = getConfig().showMoveBadges && moves.length > 0;
  const result = showBadges ? currentAnalysis() : null;
  const analysis = result?.analysis ?? null;

  if (showBadges && analysis) {
    const legend = document.createElement('div');
    legend.className = 'badge-legend';
    legend.innerHTML =
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-best"></span> Best</span>' +
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-blunder"></span> Mistake</span>' +
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-trap"></span> Trap</span>';
    el.appendChild(legend);
  }

  renderMoveRows(moves, fen, analysis, el);
  updateRecentGamesPanel();
}

let savedRecentGamesScroll = 0;

function updateRecentGamesPanel(): void {
  const container = document.getElementById('recent-games-container');
  if (!container) return;
  const prevList = container.querySelector('.recent-games-list');
  if (prevList) savedRecentGamesScroll = prevList.scrollTop;
  container.innerHTML = '';
  const hasData = isDBReady() && hasPersonalData();
  const sectionHeader = document.getElementById('games-section-header');

  // Update topbar user identity
  const navIdentity = document.getElementById('nav-user-identity');
  if (navIdentity) {
    if (hasData) {
      const cfg = getPersonalConfig()!;
      navIdentity.classList.remove('hidden');
      const nameEl = navIdentity.querySelector('.nav-user-name');
      const countEl = navIdentity.querySelector('.nav-user-count');
      if (nameEl) nameEl.textContent = cfg.username;
      if (countEl) countEl.textContent = `· ${formatGames(cfg.gameCount)}`;

      // Wire refresh button (only once)
      const refreshBtn = navIdentity.querySelector<HTMLButtonElement>('[data-action="refresh"]');
      if (refreshBtn && !refreshBtn.dataset.wired) {
        refreshBtn.dataset.wired = '1';
        refreshBtn.addEventListener('click', () => refreshRecentGames(refreshBtn));
      }

      // Wire clear button (only once)
      const clearBtn = navIdentity.querySelector<HTMLButtonElement>('[data-action="clear"]');
      if (clearBtn && !clearBtn.dataset.wired) {
        clearBtn.dataset.wired = '1';
        clearBtn.addEventListener('click', async () => {
          const result = await confirmModal({
            title: 'Clear imported games?',
            message: 'This will remove all imported game data. You can re-import at any time.',
            buttons: [{ label: 'Clear', value: 'clear', style: 'danger' }],
            danger: true,
            anchor: clearBtn,
          });
          if (result !== 'clear') return;
          await clearPersonalData();
          explorerFiltersOpen = false;
          recentGamesFiltersOpen = false;
          updateExplorerPanel();
          updateRecentGamesPanel();
        });
      }
    } else {
      navIdentity.classList.add('hidden');
    }
  }

  // Show/hide sidebar tabs based on whether personal data exists
  const sidebarTabs = document.getElementById('sidebar-tabs');
  if (sidebarTabs) {
    sidebarTabs.style.display = hasData || !isDBReady() ? '' : 'none';
    if (!hasData && isDBReady() && getExplorerMode() === 'personal') {
      applySidebarTab('database');
    }
  }

  const gamesSection = sectionHeader?.closest('.sidebar-section-games') as HTMLElement | null;

  if (!hasData) {
    // Reset header to static "Games"
    if (sectionHeader) {
      sectionHeader.className = 'sidebar-section-header';
      sectionHeader.style.display = '';
      sectionHeader.innerHTML = 'Games';
    }
    gamesSection?.classList.remove('games-card');
    const empty = document.createElement('div');
    empty.className = 'recent-games-empty';
    empty.innerHTML =
      `<p class="recent-games-empty-title">Import your games</p>` +
      `<p>Connect your Lichess or Chess.com account to unlock personal features:</p>` +
      `<ul>` +
      `<li>Browse your <b>recent games</b> and jump to any opening</li>` +
      `<li>Get a <b>games report</b> that identifies your weaknesses</li>` +
      `<li>Practice against <b>your opponents' moves</b> instead of the global database</li>` +
      `</ul>`;
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-primary';
    importBtn.textContent = 'Import games';
    importBtn.addEventListener('click', () => openPersonalImportModal());
    empty.append(importBtn);
    container.append(empty);
    return;
  }

  // Hide the section header — label lives inside the filter row
  if (sectionHeader) {
    sectionHeader.className = 'sidebar-section-header';
    sectionHeader.style.display = 'none';
  }

  renderRecentGames(container);
}

// ── Recent Games ──

let recentGamesRefreshing = false;
let recentGamesColorFilter: 'all' | 'white' | 'black' = 'all';

async function refreshRecentGames(btn: HTMLButtonElement): Promise<void> {
  if (recentGamesRefreshing) return;
  const cfg = getPersonalConfig();
  if (!cfg) return;

  recentGamesRefreshing = true;
  btn.disabled = true;
  btn.classList.add('spinning');

  try {
    if (cfg.platform === 'lichess') {
      await importFromLichess(cfg.username, () => {});
    } else {
      await importFromChesscom(cfg.username, () => {});
    }
    updateRecentGamesPanel();
    updateExplorerPanel();
  } finally {
    recentGamesRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

async function refreshExplorerGames(btn: HTMLButtonElement): Promise<void> {
  if (recentGamesRefreshing) return;
  const cfg = getPersonalConfig();
  if (!cfg) return;

  recentGamesRefreshing = true;
  btn.disabled = true;
  btn.classList.add('spinning');

  try {
    if (cfg.platform === 'lichess') {
      await importFromLichess(cfg.username, () => {});
    } else {
      await importFromChesscom(cfg.username, () => {});
    }
    updateRecentGamesPanel();
    updateExplorerPanel();
  } finally {
    recentGamesRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function userResult(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  const whiteWon = game.re === 'w';
  return (whiteWon === game.uw) ? 'win' : 'loss';
}

function shortDate(dateStr: string): string {
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

function pgnToLine(pgn: string): MoveHistoryEntry[] {
  const tokens = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/).filter(t => t && t !== '*');
  const chess = Chess.default();
  const line: MoveHistoryEntry[] = [];
  for (const san of tokens) {
    const move = parseSan(chess, san);
    if (!move) break;
    const uci = makeUci(move);
    chess.play(move);
    line.push({ san, uci, fen: '' }); // fen rebuilt by replayLine
  }
  return line;
}

function uciStringToLine(uciStr: string): MoveHistoryEntry[] {
  const tokens = uciStr.trim().split(/\s+/).filter(Boolean);
  const chess = Chess.default();
  const line: MoveHistoryEntry[] = [];
  for (const token of tokens) {
    const move = parseUci(token);
    if (!move) break;
    const san = makeSan(chess, move);
    chess.play(move);
    line.push({ san, uci: token, fen: '' });
  }
  return line;
}

function gameTimestamp(game: GameMeta): string {
  const date = game.da ?? game.mo;
  const time = game.ti ?? '';
  return time ? `${date}T${time}` : date;
}

function renderRecentGames(container: HTMLElement): void {
  const games = getPersonalGames();
  if (!games || games.length === 0) return;

  // Sort all games by date, newest first
  const indexed = games.map((g, i) => ({ game: g, idx: i }));
  indexed.sort((a, b) => {
    const cmp = gameTimestamp(b.game).localeCompare(gameTimestamp(a.game));
    return cmp !== 0 ? cmp : b.idx - a.idx;
  });

  // Apply color filter + personal filters (time control, rating, date)
  const filtered = indexed.filter(({ game }) => {
    if (recentGamesColorFilter === 'white' && !game.uw) return false;
    if (recentGamesColorFilter === 'black' && game.uw) return false;
    return gameMatchesFilters(game, { ignoreColor: true });
  });

  const section = document.createElement('div');
  section.className = 'recent-games';

  // Filter label + icon row
  const filterRow = document.createElement('div');
  filterRow.className = 'recent-games-filters';
  const filterLabel = document.createElement('span');
  filterLabel.className = 'recent-games-filters-label';
  filterLabel.textContent = 'Recent Games';
  filterRow.append(filterLabel);

  const filterBtn = document.createElement('button');
  filterBtn.className = 'games-identity-action' + (recentGamesFiltersOpen ? ' active' : '');
  filterBtn.title = 'Filter games';
  filterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>`;
  filterBtn.addEventListener('click', () => {
    recentGamesFiltersOpen = !recentGamesFiltersOpen;
    updateRecentGamesPanel();
  });
  filterRow.append(filterBtn);
  section.append(filterRow);

  // Shared personal filter panel (time control, rating, date)
  const filterWrap = document.createElement('div');
  filterWrap.className = 'personal-info-wrap';
  renderPersonalFilterPanel(filterWrap, 'recent-games');
  section.append(filterWrap);

  const BATCH_SIZE = 40;
  let rendered = 0;

  const list = document.createElement('div');
  list.className = 'recent-games-list';
  let recentScrollTimer = 0;
  list.addEventListener('scroll', () => {
    list.classList.add('scrolling');
    clearTimeout(recentScrollTimer);
    recentScrollTimer = window.setTimeout(() => list.classList.remove('scrolling'), 1000);
  }, { passive: true });

  function renderBatch(): void {
    const end = Math.min(rendered + BATCH_SIZE, filtered.length);
    for (let i = rendered; i < end; i++) {
      list.append(renderGameRow(filtered[i].game));
    }
    rendered = end;
  }

  // Render enough batches to cover the saved scroll position
  const estimatedRowHeight = 30;
  const minItems = savedRecentGamesScroll > 0
    ? Math.ceil(savedRecentGamesScroll / estimatedRowHeight) + BATCH_SIZE
    : BATCH_SIZE;
  while (rendered < Math.min(minItems, filtered.length)) {
    renderBatch();
  }

  list.addEventListener('scroll', () => {
    if (rendered >= filtered.length) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      renderBatch();
    }
  });

  section.append(list);
  container.append(section);

  if (savedRecentGamesScroll > 0) {
    list.scrollTop = savedRecentGamesScroll;
  }
}

function updateRecentGamesList(): void {
  const el = document.querySelector<HTMLElement>('.recent-games-list');
  if (!el) return;
  const list = el;
  list.innerHTML = '';

  const games = getPersonalGames();
  if (!games || games.length === 0) return;

  const indexed = games.map((g, i) => ({ game: g, idx: i }));
  indexed.sort((a, b) => {
    const cmp = gameTimestamp(b.game).localeCompare(gameTimestamp(a.game));
    return cmp !== 0 ? cmp : b.idx - a.idx;
  });

  const filtered = indexed.filter(({ game }) => {
    if (recentGamesColorFilter === 'white' && !game.uw) return false;
    if (recentGamesColorFilter === 'black' && game.uw) return false;
    return gameMatchesFilters(game, { ignoreColor: true });
  });

  const BATCH_SIZE = 40;
  let rendered = 0;

  function renderBatch(): void {
    const end = Math.min(rendered + BATCH_SIZE, filtered.length);
    for (let i = rendered; i < end; i++) {
      list.append(renderGameRow(filtered[i].game));
    }
    rendered = end;
  }

  renderBatch();

  list.addEventListener('scroll', () => {
    if (rendered >= filtered.length) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      renderBatch();
    }
  });
}

function downloadPgn(pgn: string, filename: string): void {
  if (!pgn) return;
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatGames(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function tcIcon(tc: string): string {
  switch (tc) {
    case 'bullet': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>';
    case 'blitz': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 23c-1.2 0-2.4-.3-3.5-.7 2.3-1.7 3.5-4.5 3.5-7.3 0-3-1.5-5.8-3.9-7.5C6.4 9.2 5.5 11.5 5.5 14c0 1-.1 2-.4 3C3.2 15.2 2 12.7 2 10c0-4.6 3.4-8.4 7.8-9-.5.8-.8 1.8-.8 2.8 0 2.9 2.4 5.2 5.3 5.2 2.2 0 4-.1 5.2-1.5.4 1 .5 2 .5 3 0 6.9-5 12.5-8 12.5z"/></svg>';
    case 'rapid': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>';
    case 'classical': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 2l.5 3H11V2H6zm7 0v3h4.5L18 2h-5zM6 22l.5-3H11v3H6zm7 0v-3h4.5l.5 3h-5zm-6.5-5H11v-4H5.2l1.3 4zm7.5-4v4h4.5l1.3-4H14zM5.7 11H11V7H6.5L5.7 11zM13 7v4h5.3l-.8-4H13z"/></svg>';
    case 'daily': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>';
    default: return '';
  }
}

function renderGameRow(game: GameMeta): HTMLDivElement {
  const result = userResult(game);

  const row = document.createElement('div');
  row.className = 'recent-game-row';

  if (getLoadedGame() === game) {
    row.classList.add('selected');
  }

  if (game.mv || game.ec) {
    const color = game.uw ? 'white' : 'black';
    row.classList.add('clickable');
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.recent-game-external')) return;
      if (getLoadedGame() === game) {
        clearLoadedGame();
        dispatchNewGame();
        return;
      }
      let line: MoveHistoryEntry[] = [];
      if (game.mv) {
        line = uciStringToLine(game.mv);
      } else if (game.ec) {
        const entry = findPgnByEco(game.ec);
        if (entry) line = pgnToLine(entry.pgn);
      }
      if (line.length > 0) {
        setLoadedGame(game);
        setOrientation(color);
        replayLine(line, 0);
        updateRecentGamesPanel();
      }
    });
  }

  row.classList.add(game.uw ? 'as-white' : 'as-black');

  const badge = document.createElement('span');
  badge.className = `recent-game-result ${result}`;
  badge.textContent = result === 'win' ? 'W' : result === 'draw' ? 'D' : 'L';

  const tcSvg = tcIcon(game.tc);
  const tcEl = document.createElement('span');
  tcEl.className = 'recent-game-tc';
  if (tcSvg) {
    tcEl.innerHTML = tcSvg;
    tcEl.title = game.tc.charAt(0).toUpperCase() + game.tc.slice(1);
  }

  const opening = document.createElement('span');
  opening.className = 'recent-game-opening';
  opening.textContent = (game.ec ? findOpeningByEco(game.ec) ?? game.ec : '—');

  const rating = document.createElement('span');
  rating.className = 'recent-game-rating';
  rating.textContent = String(game.or);

  const oppName = game.op ?? 'Opponent';
  const dateStr = shortDate(game.da ?? game.mo);
  const tooltip = `vs ${oppName} (${game.or}) · ${dateStr}`;
  row.setAttribute('data-tooltip', tooltip);

  row.append(badge, tcEl, opening, rating);

  if (game.gl) {
    const ext = document.createElement('a');
    ext.className = 'recent-game-external';
    ext.href = game.gl;
    ext.target = '_blank';
    ext.rel = 'noreferrer noopener';
    ext.title = 'Open game';
    ext.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"/><path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';
    ext.addEventListener('click', (e) => e.stopPropagation());
    row.append(ext);
  }

  return row;
}

export {
  updateExplorerPanel, setExplorerAlwaysShow, resetExplorerRevealed,
  renderEngineLines, setEngineLinesVisible,
  formatGames, updateRecentGamesPanel,
  fitExplorerBarLabels, scheduleExplorerBarLabelFit,
  BAR_PCT_LABEL_ATTR,
  userResult, shortDate, uciStringToLine,
};
