import type {
  AppConfig,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  MoveHistoryEntry,
  PositionAnalysis,
} from './types';
import { getMoveHistory, getViewIndex, isViewingHistory, navigateTo, replayLine } from './board';
import {
  isMoveLocked, lockMove, unlockMove, getLockedMoves,
  getActiveOpening, createOpening,
  FREE_PLAY_NAME,
} from './repertoire';
import { createOpeningPicker } from './opening-picker';
import { initLibraryModal, openLibraryModal } from './opening-library';
import { exportActiveOpening, exportAll } from './pgn-export';
import { getExplorerData, getExplorerCache, getPhase } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';
import {
  getExplorerMode, setExplorerMode, initPersonalExplorer,
  type GameMeta,
} from './personal-explorer';
import { isReportPageOpen } from './report-ui';
import {
  updateExplorerPanel, updateRecentGamesPanel,
  setExplorerAlwaysShow, resetExplorerRevealed,
  renderEngineLines, setEngineLinesVisible,
  formatGames, userResult, shortDate, uciStringToLine,
} from './ui-explorer';
import { initHelpModal, openHelpModal, openPgnModal } from './ui-modals';

type ContinueCallback = () => void;
type OpeningChangeCallback = () => void;
type ModeChangeCallback = () => void;

type ConfigChangeCallback = (config: AppConfig) => void;
type NewGameCallback = () => void;
type FlipCallback = () => void;
type ExplorerMoveClickCallback = (uci: string) => void;

type RetryExplorerCallback = () => void;

let configChangeCb: ConfigChangeCallback;
let newGameCb: NewGameCallback;
let flipCb: FlipCallback;
let explorerMoveClickCb: ExplorerMoveClickCallback | null = null;
let continueCb: ContinueCallback | null = null;
let openingChangeCb: OpeningChangeCallback | null = null;
let modeChangeCb: ModeChangeCallback | null = null;
let retryExplorerCb: RetryExplorerCallback | null = null;
let currentConfig: AppConfig;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Track which UCI was played next from the currently viewed position
let nextMoveUci: string | null = null;

// Current engine eval as win% for the side to move (0-100), null if unavailable
let currentEvalWinPct: number | null = null;

// Currently loaded game for replay mode
let loadedGame: GameMeta | null = null;

// Remember last engine line count so toggling on restores previous setting
type HistoryLinesView = 'history' | 'lines';
let historyLinesView: HistoryLinesView = 'history';

// ── Getters & Dispatchers (for sub-modules) ──

export function getConfig(): AppConfig {
  return currentConfig;
}

export function getNextMoveUci(): string | null {
  return nextMoveUci;
}

export function getEvalWinPct(): number | null {
  return currentEvalWinPct;
}

export function setLoadedGame(game: GameMeta | null): void {
  loadedGame = game;
}

export function dispatchConfigChange(config: AppConfig): void {
  currentConfig = config;
  configChangeCb(config);
}

export function dispatchNewGame(): void {
  newGameCb();
}

export function dispatchExplorerMoveClick(uci: string): void {
  explorerMoveClickCb?.(uci);
}

export function dispatchOpeningChange(): void {
  openingChangeCb?.();
}

export function dispatchModeChange(): void {
  modeChangeCb?.();
}

export function dispatchRetryExplorer(): void {
  retryExplorerCb?.();
}

export function dispatchContinue(): void {
  continueCb?.();
}

// ── Init ──

export function initUI(
  config: AppConfig,
  onConfigChange: ConfigChangeCallback,
  onNewGame: NewGameCallback,
  onFlip: FlipCallback,
  onExplorerMoveClick?: ExplorerMoveClickCallback,
  onContinue?: ContinueCallback,
  onRepertoireChange?: OpeningChangeCallback,
  onModeChange?: ModeChangeCallback,
  onRetryExplorer?: RetryExplorerCallback,
): void {
  currentConfig = { ...config };
  configChangeCb = onConfigChange;
  newGameCb = onNewGame;
  flipCb = onFlip;
  explorerMoveClickCb = onExplorerMoveClick ?? null;
  continueCb = onContinue ?? null;
  openingChangeCb = onRepertoireChange ?? null;
  modeChangeCb = onModeChange ?? null;
  retryExplorerCb = onRetryExplorer ?? null;

  initPersonalExplorer().then(() => {
    // Re-render explorer panel once DB is loaded, in case user is already in personal mode
    if (getExplorerMode() === 'personal') updateExplorerPanel();
    updateRecentGamesPanel();
  });
  initHistoryLinesToggle();
  renderSystemPicker();
  renderControls();
  initHelpModal();
  initTooltips();
  document.addEventListener('click', () => closeAllDropdowns());
}

function setHistoryLinesView(view: HistoryLinesView): void {
  historyLinesView = view;
  const showHistory = view === 'history';

  document.getElementById('moves')?.classList.toggle('hidden', !showHistory);
  document.getElementById('move-actions')?.classList.toggle('hidden', !showHistory);
  document.getElementById('opening-lines')?.classList.toggle('hidden', showHistory);

  const buttons = document.querySelectorAll<HTMLButtonElement>('#history-lines-toggle .segment-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.historyLinesView === view);
  });
}

function initHistoryLinesToggle(): void {
  const toggle = document.getElementById('history-lines-toggle');
  if (!toggle) return;

  const buttons = toggle.querySelectorAll<HTMLButtonElement>('.segment-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.historyLinesView === 'lines' ? 'lines' : 'history';
      if (view === historyLinesView) return;
      setHistoryLinesView(view);
    });
  });

  setHistoryLinesView(historyLinesView);
}

// ── System Picker ──

const explorePicker = createOpeningPicker({
  mode: 'explore',
  getContainer: () => document.getElementById('system-picker'),
  onChange: () => {
    openingChangeCb?.();
    renderRepertoireActions();
  },
});

export function renderSystemPicker(): void {
  explorePicker.render();
  renderRepertoireActions();
}

function renderRepertoireActions(): void {
  const el = document.getElementById('repertoire-actions');
  if (!el) return;
  el.innerHTML = '';

  const active = getActiveOpening();
  const isFreePlay = active === FREE_PLAY_NAME;

  const primaryRow = document.createElement('div');
  primaryRow.className = 'repertoire-primary-row';

  const libraryBtn = document.createElement('button');
  libraryBtn.className = 'btn';
  libraryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg> Browse openings';
  libraryBtn.setAttribute('data-tooltip', 'Browse common openings to add');
  libraryBtn.addEventListener('click', () => {
    initLibraryModal(() => {
      renderSystemPicker();
      updateExplorerPanel();
      updateMoveList();
      openingChangeCb?.();
    });
    openLibraryModal();
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn';
  importBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Import PGN';
  importBtn.setAttribute('data-tooltip', 'Import from PGN or Lichess study');
  importBtn.addEventListener('click', () => openPgnModal());

  primaryRow.append(libraryBtn, importBtn);

  const overflowWrap = document.createElement('div');
  overflowWrap.className = 'overflow-btn-wrap';

  const overflowBtn = document.createElement('button');
  overflowBtn.className = 'btn icon';
  overflowBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  overflowBtn.setAttribute('data-tooltip', 'More actions');

  const overflowMenu = document.createElement('div');
  overflowMenu.className = 'overflow-menu';

  const copyItem = document.createElement('button');
  copyItem.className = 'overflow-menu-item';
  copyItem.textContent = 'Copy PGN';
  copyItem.disabled = isFreePlay;
  copyItem.addEventListener('click', () => {
    const pgn = exportActiveOpening();
    if (!pgn) return;
    navigator.clipboard.writeText(pgn).then(() => {
      const orig = copyItem.textContent;
      copyItem.textContent = 'Copied!';
      setTimeout(() => { copyItem.textContent = orig; }, 1500);
    });
    overflowMenu.classList.remove('visible');
  });

  const exportAllItem = document.createElement('button');
  exportAllItem.className = 'overflow-menu-item';
  exportAllItem.textContent = 'Export repertoire';
  exportAllItem.addEventListener('click', () => {
    downloadPgn(exportAll(), 'repertoire.pgn');
    overflowMenu.classList.remove('visible');
  });

  overflowMenu.append(copyItem, exportAllItem);

  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !overflowMenu.classList.contains('visible');
    overflowMenu.classList.toggle('visible');
    if (opening) {
      const close = () => {
        overflowMenu.classList.remove('visible');
        document.removeEventListener('click', close);
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  });

  overflowWrap.append(overflowBtn, overflowMenu);
  primaryRow.append(overflowWrap);

  el.append(primaryRow);
}

function renderControls(): void {
  const el = document.getElementById('controls')!;
  el.innerHTML = '';

  const flipBtn = document.createElement('button');
  flipBtn.textContent = 'Flip Board';
  flipBtn.className = 'btn';
  flipBtn.addEventListener('click', () => flipCb());

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn btn-primary';
  resetBtn.addEventListener('click', () => newGameCb());

  el.append(flipBtn, resetBtn);
}



function closeAllDropdowns(): void {
  document.querySelectorAll('.explorer-cog-popover').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.engine-lines-config').forEach(p => p.classList.add('hidden'));
}

// ── Status ──

export function updateStatus(phase: GamePhase, openingName?: string): void {
  const el = document.getElementById('status')!;
  let text = '';

  text += `<div class="opening-name">${openingName || 'Starting position'}</div>`;

  // Status row: turn indicator + move number
  const history = getMoveHistory();
  const moveNum = Math.floor(history.length / 2) + 1;
  const moveLabel = history.length > 0 ? `Move ${moveNum}` : '';

  text += '<div class="status-row">';
  switch (phase) {
    case 'USER_TURN':
      text += '<span class="turn-indicator">Your turn</span>';
      break;
    case 'BOT_THINKING':
      text += '<span class="turn-indicator thinking">Thinking...</span>';
      break;
    case 'OUT_OF_BOOK':
      text += '<span class="turn-indicator out-of-book" data-tooltip="Position left the opening database">Out of book</span>';
      break;
    case 'GAME_OVER':
      text += '<span class="turn-indicator game-over">Game over</span>';
      break;
  }
  if (moveLabel) {
    text += `<span class="move-counter">${moveLabel}</span>`;
  }
  text += '</div>';

  // Repertoire depth indicator
  let repMoves = 0;
  if (history.length > 0) {
    for (let i = 0; i < history.length; i++) {
      const fenBefore = i === 0 ? STARTING_FEN : history[i - 1].fen;
      const locked = getLockedMoves(fenBefore);
      if (locked.length > 0 && locked.includes(history[i].uci)) {
        repMoves++;
      } else {
        break;
      }
    }
  }
  const pct = history.length > 0 ? Math.round((repMoves / history.length) * 100) : 0;
  const depthLabel = history.length > 0
    ? `${repMoves}/${history.length} moves in repertoire`
    : 'No moves yet';
  text += `<div class="rep-depth" data-tooltip="Consecutive moves matching your repertoire"><span class="rep-depth-bar" style="width:${pct}%"></span><span class="rep-depth-label">${depthLabel}</span></div>`;

  el.innerHTML = text;
}

// ── Move History ──

function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function repClass(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const locked = getLockedMoves(fenBefore);
  if (locked.length === 0) return '';
  if (locked.includes(history[moveIndex].uci)) return ' rep-hit';
  return ' rep-miss';
}

function buildParentContext(
  parentFen: string,
  playedUci: string,
  cache: Map<string, ExplorerResponse>,
): ParentContext | undefined {
  const parentData = cache.get(fenKey(parentFen));
  if (!parentData || parentData.moves.length === 0) return undefined;
  const parentSide = parentFen.split(' ')[1] as 'w' | 'b';
  return { parentMoves: parentData.moves, playedUci, parentSide };
}

function historyBadge(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const cache = getExplorerCache();
  const explorerData = cache.get(fenKey(fenBefore));
  if (!explorerData || explorerData.moves.length === 0) return '';

  // Build parent context: the position before fenBefore, and the move that led to fenBefore
  let parentContext: ParentContext | undefined;
  if (moveIndex >= 1) {
    const grandparentFen = moveIndex <= 1 ? STARTING_FEN : history[moveIndex - 2].fen;
    const playedUci = history[moveIndex - 1].uci;
    parentContext = buildParentContext(grandparentFen, playedUci, cache);
  }

  const sideToMove = fenBefore.split(' ')[1] as 'w' | 'b';
  const analysis = analyzePosition(explorerData.moves, sideToMove, parentContext);
  const badge = getBadgeForMove(analysis, history[moveIndex].uci);
  if (!badge || badge === 'book') return '';

  return `<span class="history-badge badge-${badge.replace('_', '-')}">${badgeSymbol(badge)}</span>`;
}

export function updateMoveList(): void {
  const el = document.getElementById('moves')!;
  const history = getMoveHistory();

  if (history.length === 0) {
    el.innerHTML = '<div class="move-list-empty">No moves yet</div>';
    document.getElementById('move-actions')!.innerHTML = '';
    return;
  }

  const vi = getViewIndex();

  // Check if any moves have repertoire coloring
  let hasRepHit = false;
  let hasRepMiss = false;
  for (let i = 0; i < history.length && (!hasRepHit || !hasRepMiss); i++) {
    const cls = repClass(i, history);
    if (cls === ' rep-hit') hasRepHit = true;
    if (cls === ' rep-miss') hasRepMiss = true;
  }

  let html = '';
  if (loadedGame) {
    const result = userResult(loadedGame);
    const resultLabel = result === 'win' ? 'W' : result === 'draw' ? 'D' : 'L';
    const oppName = loadedGame.op ?? 'Opponent';
    const dateStr = shortDate(loadedGame.da ?? loadedGame.mo);
    html += `<div class="game-info-banner">` +
      `<span class="game-info-result ${result}">${resultLabel}</span>` +
      `<span class="game-info-details">vs ${oppName} (${loadedGame.or}) &middot; ${dateStr}</span>` +
      `<button class="game-info-dismiss" title="Back to training">&times;</button>` +
      `</div>`;
  }
  if (hasRepHit || hasRepMiss) {
    html += '<div class="move-legend">';
    if (hasRepHit) html += '<span class="move-legend-item"><span class="move-legend-dot hit"></span>In repertoire</span>';
    if (hasRepMiss) html += '<span class="move-legend-item"><span class="move-legend-dot miss"></span>Deviated</span>';
    html += '</div>';
  }

  html += '<div class="move-table">';
  for (let i = 0; i < history.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const white = history[i];
    const black = history[i + 1];
    const whiteActive = (i + 1) === vi ? ' active' : '';
    const blackActive = black && (i + 2) === vi ? ' active' : '';
    const whiteRepClass = repClass(i, history);
    const blackRepClass = black ? repClass(i + 1, history) : '';
    const whiteBadge = historyBadge(i, history);
    const blackBadge = black ? historyBadge(i + 1, history) : '';
    html += `<div class="move-num">${moveNum}.</div>
      <div class="move-san clickable${whiteActive}${whiteRepClass}" data-vi="${i + 1}">${white.san}${whiteBadge}</div>
      <div class="move-san${black ? ` clickable${blackActive}${blackRepClass}` : ''}"${black ? ` data-vi="${i + 2}"` : ''}>${black ? black.san + blackBadge : ''}</div>`;
  }
  html += '</div>';

  el.innerHTML = html;

  el.querySelectorAll('.move-san.clickable').forEach((td) => {
    td.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const vi = parseInt(target.dataset.vi!);
      navigateTo(vi);
    });
  });

  // Render action buttons in separate container
  const actionsEl = document.getElementById('move-actions')!;
  const upTo = isViewingHistory() ? vi : history.length;
  const allLocked = upTo > 0 && history.slice(0, upTo).every((m, i) => {
    const fen = i === 0 ? STARTING_FEN : history[i - 1].fen;
    return isMoveLocked(fen, m.uci);
  });
  let actionsHtml = '';
  if (isViewingHistory() && continueCb) {
    actionsHtml += '<button class="btn continue-btn">Continue from here</button>';
  }
  if (!allLocked) {
    actionsHtml += '<button class="btn lock-line-btn" data-tooltip="Lock all moves up to here">Add to opening</button>';
    actionsHtml += '<button class="btn lock-line-new-btn" data-tooltip="Lock into a new opening">Add new opening</button>';
  }
  actionsEl.innerHTML = actionsHtml;

  const continueBtn = actionsEl.querySelector('.continue-btn');
  if (continueBtn && continueCb) {
    continueBtn.addEventListener('click', () => continueCb!());
  }

  function lockLineToRepertoire(forceNew: boolean): void {
    if (forceNew) {
      const { data } = getExplorerData();
      const openingName = data?.opening?.name;
      createOpening(openingName);
      renderSystemPicker();
    }
    const upTo = isViewingHistory() ? vi : history.length;
    let repertoireCreated = false;
    for (let i = 0; i < upTo; i++) {
      const fen = i === 0 ? STARTING_FEN : history[i - 1].fen;
      if (lockMove(fen, history[i].uci)) repertoireCreated = true;
    }
    if (repertoireCreated && !forceNew) {
      renderSystemPicker();
    }
    updateExplorerPanel();
    updateMoveList();
    updateAlertBanner();
  }

  actionsEl.querySelector('.lock-line-btn')
    ?.addEventListener('click', () => lockLineToRepertoire(false));
  actionsEl.querySelector('.lock-line-new-btn')
    ?.addEventListener('click', () => lockLineToRepertoire(true));

  const bannerEl = el.querySelector('.game-info-banner');
  if (bannerEl) {
    bannerEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.game-info-dismiss')) {
        clearLoadedGame();
        return;
      }
      if (loadedGame?.mv) {
        const line = uciStringToLine(loadedGame.mv);
        if (line.length > 0) replayLine(line, 0);
      }
    });
  }

  const activeEl = el.querySelector('.move-san.active') as HTMLElement | null;
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'nearest' });
  } else if (loadedGame) {
    el.scrollTop = 0;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

export function setNextMoveUci(uci: string | null): void {
  nextMoveUci = uci;
}

export function setEvalWinPct(winPct: number | null): void {
  currentEvalWinPct = winPct;
}

export function getLoadedGame(): GameMeta | null {
  return loadedGame;
}

export function clearLoadedGame(): void {
  loadedGame = null;
  updateMoveList();
  updateRecentGamesPanel();
}

// ── Analysis ──

export function currentAnalysis(): { analysis: PositionAnalysis; parentContext?: ParentContext } | null {
  const { data, fen } = getExplorerData();
  const moves = data?.moves ?? [];
  if (moves.length === 0) return null;

  const sideToMove = fen.split(' ')[1] as 'w' | 'b';
  let parentContext: ParentContext | undefined;
  const history = getMoveHistory();
  const cache = getExplorerCache();
  const vi = getViewIndex();
  const currentMoveIndex = vi - 1;
  if (currentMoveIndex >= 0) {
    const parentFen = currentMoveIndex === 0 ? STARTING_FEN : history[currentMoveIndex - 1].fen;
    const playedUci = history[currentMoveIndex].uci;
    parentContext = buildParentContext(parentFen, playedUci, cache);
  }

  // Convert eval to side-to-move win% if available
  // currentEvalWinPct is always from white's perspective, flip for black
  const evalWinPct = currentEvalWinPct != null
    ? (sideToMove === 'w' ? currentEvalWinPct : 100 - currentEvalWinPct)
    : undefined;

  const analysis = analyzePosition(moves, sideToMove, parentContext, evalWinPct);
  return { analysis, parentContext };
}

export function updateAlertBanner(): void {
  const el = document.getElementById('alert-banner');
  if (el) el.innerHTML = '';
}

// ── Utilities ──

export function badgeSymbol(badge: MoveBadge): string {
  switch (badge) {
    case 'best': return '!';
    case 'blunder': return '?';
    case 'trap': return '?!';
    default: return '';
  }
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

// ── Tooltip System ──

function initTooltips(): void {
  const popup = document.createElement('div');
  popup.className = 'tooltip-popup';
  document.body.append(popup);

  const MARGIN = 8;

  function showPopup(target: HTMLElement, content: string, isHtml: boolean): void {
    if (isHtml) {
      popup.innerHTML = content;
    } else {
      popup.textContent = content;
    }
    popup.classList.toggle('tooltip-wide', target.classList.contains('tooltip-wide') || isHtml);
    popup.classList.toggle('tooltip-preline', target.classList.contains('tooltip-preline'));

    // Position off-screen to measure
    popup.style.left = '0';
    popup.style.top = '0';
    popup.classList.add('visible');

    const rect = target.getBoundingClientRect();
    const popRect = popup.getBoundingClientRect();
    const below = target.classList.contains('tooltip-below');

    let top: number;
    if (below || rect.top - popRect.height - MARGIN < 0) {
      top = rect.bottom + MARGIN;
    } else {
      top = rect.top - popRect.height - MARGIN;
    }

    let left = rect.left + rect.width / 2 - popRect.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - popRect.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - popRect.height - MARGIN));

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  document.addEventListener('mouseenter', (e) => {
    const el = e.target as HTMLElement;

    // Info-icon tooltips (rich HTML)
    const infoWrap = el.closest?.('.info-icon-wrap') as HTMLElement | null;
    if (infoWrap) {
      const infoTip = infoWrap.querySelector('.info-tooltip') as HTMLElement | null;
      if (infoTip) {
        showPopup(infoWrap, infoTip.innerHTML, true);
        return;
      }
    }

    // Data-tooltip (plain text)
    const target = el.closest?.('[data-tooltip]') as HTMLElement | null;
    if (!target) return;
    const isHtmlTooltip = target.classList.contains('tooltip-html');
    showPopup(target, target.getAttribute('data-tooltip')!, isHtmlTooltip);
  }, true);

  document.addEventListener('mouseleave', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest?.('.info-icon-wrap') || el.closest?.('[data-tooltip]')) {
      popup.classList.remove('visible');
    }
  }, true);
}

// ── Sidebar Tabs ──

type SidebarTab = 'database' | 'personal';
let activeTab: SidebarTab = 'database';

export function initSidebarTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .segment-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab as SidebarTab;
      if (id === activeTab) return;
      applySidebarTab(id);
    });
  });

}

export function applySidebarTab(id: SidebarTab): void {
  activeTab = id;

  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .segment-btn');
  tabs.forEach(t => t.classList.toggle('selected', t.dataset.tab === id));



  const mode = id === 'database' ? 'database' : 'personal';
  if (getExplorerMode() !== mode) {
    setExplorerMode(mode);
    modeChangeCb?.();
  }
  updateExplorerPanel();
}

export function switchSidebarTab(id: SidebarTab): void {
  if (id === activeTab) return;
  applySidebarTab(id);
}

export function toggleLockCurrentMove(): void {
  const { data, fen } = getExplorerData();
  if (!data || !fen || !nextMoveUci) return;

  const move = data.moves.find(m => m.uci === nextMoveUci);
  if (!move) return;

  if (isMoveLocked(fen, nextMoveUci)) {
    unlockMove(fen, nextMoveUci);
  } else {
    if (lockMove(fen, nextMoveUci)) {
      renderSystemPicker();
      openingChangeCb?.();
    }
  }
  updateExplorerPanel();
  updateMoveList();
}

export function isAnyModalOpen(): boolean {
  if (isReportPageOpen()) return true;
  const modalIds = ['settings-drawer', 'pgn-modal', 'help-modal', 'personal-import-modal', 'library-modal', 'confirm-overlay', 'onboarding-overlay'];
  return modalIds.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

// ── Re-exports from sub-modules ──

export {
  updateExplorerPanel, setExplorerAlwaysShow, resetExplorerRevealed,
  renderEngineLines, setEngineLinesVisible,
} from './ui-explorer';
export { openHelpModal } from './ui-modals';
