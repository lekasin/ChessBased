import type {
  AppConfig,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  MoveHistoryEntry,
  PlayerColor,
  PositionAnalysis,
} from './types';
import { getMoveHistory, getViewIndex, isViewingHistory, navigateTo, replayLine } from './board';
import {
  isMoveLocked, lockMove, unlockMove, getLockedMoves,
  getOpeningNames, getActiveOpening, switchOpening, createOpening, deleteOpening, renameOpening,
  mergeMultiple,
  FREE_PLAY_NAME,
  FULL_REPERTOIRE_NAME,
} from './repertoire';
import { initLibraryModal, openLibraryModal } from './opening-library';
import { exportActiveOpening, exportAll } from './pgn-export';
import { getExplorerData, getExplorerCache, getPhase } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';
import {
  getExplorerMode, setExplorerMode, initPersonalExplorer,
  type GameMeta,
} from './personal-explorer';
import { isReportPageOpen } from './report-ui';
import { confirmModal, type ConfirmButton } from './confirm';
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
let lastEngineLineCount = 3;
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
  if (config.engineLineCount > 0) lastEngineLineCount = config.engineLineCount;
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
  renderConfigPanel();
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

type PickerMode = 'normal' | 'rename' | 'merge-select';
let pickerMode: PickerMode = 'normal';

export function renderSystemPicker(): void {
  const el = document.getElementById('system-picker')!;
  el.innerHTML = '';

  const active = getActiveOpening();
  const isFreePlay = active === FREE_PLAY_NAME;

  if (pickerMode !== 'merge-select' && pickerMode !== 'rename') {
    pickerMode = 'normal';
  }
  renderNormalMode(el, active, isFreePlay);

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

const SVG_EDIT = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const SVG_GLOBE = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>';

const SVG_LAYERS = '<svg viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z"/></svg>';
const SVG_MERGE = '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>';
const SVG_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

let dropdownOpen = false;
let mergeSelected: Set<string> = new Set();
let dropdownOutsideClickCleanup: (() => void) | null = null;

function makeCardIcon(type: 'free-play' | 'full-rep' | 'custom'): HTMLElement {
  const icon = document.createElement('div');
  icon.className = `system-card-icon ${type}`;
  const svgMap = { 'free-play': SVG_GLOBE, 'full-rep': SVG_LAYERS, 'custom': SVG_BOOK };
  const tooltipMap = { 'free-play': 'Free Play', 'full-rep': 'Full Repertoire', 'custom': 'Custom opening' };
  icon.innerHTML = svgMap[type];
  icon.setAttribute('data-tooltip', tooltipMap[type]);
  icon.classList.add('tooltip-below');
  icon.querySelector('svg')!.setAttribute('width', '16');
  icon.querySelector('svg')!.setAttribute('height', '16');
  icon.querySelector('svg')!.style.fill = 'currentColor';
  return icon;
}

function renderNormalMode(el: HTMLElement, active: string, _isFreePlay: boolean): void {
  const names = getOpeningNames();
  const customRepertoires = names.filter(n => n !== FREE_PLAY_NAME);
  const isFreePlayActive = active === FREE_PLAY_NAME;
  const isFullRepActive = active === FULL_REPERTOIRE_NAME;
  const isCustomActive = !isFreePlayActive && !isFullRepActive;

  // Clean up stale outside-click listener from previous render
  dropdownOutsideClickCleanup?.();
  dropdownOutsideClickCleanup = null;

  // ── Single dropdown card ──
  const wrapper = document.createElement('div');
  wrapper.className = 'system-dropdown-anchor';

  const card = document.createElement('div');
  card.className = 'system-card active';

  const activeIconType = isFreePlayActive ? 'free-play' : isFullRepActive ? 'full-rep' : 'custom';
  card.append(makeCardIcon(activeIconType));

  const isRenaming = pickerMode === 'rename' && isCustomActive;

  if (isRenaming) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'system-card-rename-input';
    input.value = active;
    input.placeholder = 'Opening name...';

    function saveRename(): void {
      const newName = input.value.trim();
      if (newName && newName !== active) {
        renameOpening(active, newName);
        openingChangeCb?.();
      }
      pickerMode = 'normal';
      renderSystemPicker();
    }

    function cancelRename(): void {
      pickerMode = 'normal';
      renderSystemPicker();
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') saveRename();
      if (e.key === 'Escape') cancelRename();
    });
    input.addEventListener('blur', saveRename);

    card.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  } else {
    const nameEl = document.createElement('div');
    nameEl.className = 'system-card-name';
    nameEl.textContent = active;
    card.append(nameEl);
  }

  // Inline icon actions for custom openings
  if (isCustomActive) {
    const actions = document.createElement('div');
    actions.className = 'system-card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'system-card-action-btn';
    renameBtn.setAttribute('data-tooltip', 'Rename');
    renameBtn.innerHTML = SVG_EDIT;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownOpen = false;
      pickerMode = 'rename';
      renderSystemPicker();
    });

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'system-card-action-btn';
    mergeBtn.setAttribute('data-tooltip', 'Merge openings');
    mergeBtn.innerHTML = SVG_MERGE;
    const customCount = names.filter(n => n !== FREE_PLAY_NAME).length;
    if (customCount < 2) {
      mergeBtn.style.display = 'none';
    }
    mergeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mergeSelected = new Set([active]);
      pickerMode = 'merge-select';
      dropdownOpen = true;
      renderSystemPicker();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'system-card-action-btn danger';
    deleteBtn.setAttribute('data-tooltip', 'Delete opening');
    deleteBtn.innerHTML = SVG_TRASH;
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const anchorRect = deleteBtn.getBoundingClientRect();
      dropdownOpen = false;
      renderSystemPicker();
      const result = await confirmModal({
        title: `Delete "${active}"?`,
        message: 'This will permanently remove this opening and all its locked moves.',
        buttons: [{ label: 'Delete', value: 'delete', style: 'danger' }],
        danger: true,
        anchor: anchorRect,
      });
      if (result === 'delete') {
        deleteOpening(active);
        pickerMode = 'normal';
        openingChangeCb?.();
        renderSystemPicker();
      }
    });

    actions.append(renameBtn, mergeBtn, deleteBtn);
    card.append(actions);
  }

    // Dropdown chevron
    const chevron = document.createElement('div');
    chevron.className = `system-dropdown-chevron${dropdownOpen ? ' open' : ''}`;
    chevron.innerHTML = SVG_CHEVRON;
    card.append(chevron);

    card.addEventListener('click', () => {
      dropdownOpen = !dropdownOpen;
      if (pickerMode === 'merge-select') {
        pickerMode = 'normal';
      }
      renderSystemPicker();
    });

    wrapper.append(card);

    // Dropdown list
    if (dropdownOpen) {
      // Close on click outside
      requestAnimationFrame(() => {
        const onClickOutside = (e: MouseEvent) => {
          if (!wrapper.contains(e.target as Node)) {
            dropdownOpen = false;
            if (pickerMode === 'merge-select') pickerMode = 'normal';
            cleanup();
            renderSystemPicker();
          }
        };
        function cleanup() {
          document.removeEventListener('click', onClickOutside, true);
          dropdownOutsideClickCleanup = null;
        }
        document.addEventListener('click', onClickOutside, true);
        dropdownOutsideClickCleanup = cleanup;
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'system-dropdown';

      if (pickerMode === 'merge-select') {
        // Merge-select: header + checkboxes for all custom openings + merge/cancel
        const header = document.createElement('div');
        header.className = 'system-dropdown-header';
        header.textContent = 'Select openings to merge';
        dropdown.append(header);

        for (const name of customRepertoires) {
          const checked = mergeSelected.has(name);
          const item = document.createElement('div');
          item.className = 'system-dropdown-item';

          const check = document.createElement('div');
          check.className = 'system-card-check';
          if (checked) check.classList.add('checked');
          check.innerHTML = SVG_CHECK;
          check.querySelector('svg')!.setAttribute('width', '10');
          check.querySelector('svg')!.setAttribute('height', '10');
          check.querySelector('svg')!.style.fill = '#fff';
          check.querySelector('svg')!.style.opacity = checked ? '1' : '0';
          item.append(check);

          const itemName = document.createElement('div');
          itemName.className = 'system-card-name';
          itemName.textContent = name;
          item.append(itemName);

          item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mergeSelected.has(name)) {
              mergeSelected.delete(name);
            } else {
              mergeSelected.add(name);
            }
            // Update checkbox in-place
            const isNowChecked = mergeSelected.has(name);
            check.classList.toggle('checked', isNowChecked);
            check.querySelector('svg')!.style.opacity = isNowChecked ? '1' : '0';
            // Update merge button
            updateMergeAction();
          });
          dropdown.append(item);
        }

        // Merge button
        const mergeAction = document.createElement('div');
        mergeAction.className = 'system-dropdown-item system-dropdown-add';
        mergeAction.innerHTML = `${SVG_MERGE} <span class="system-card-name">Merge ${mergeSelected.size} openings</span>`;
        mergeAction.querySelector('svg')!.setAttribute('width', '14');
        mergeAction.querySelector('svg')!.setAttribute('height', '14');
        mergeAction.querySelector('svg')!.style.fill = 'currentColor';

        function updateMergeAction() {
          const count = mergeSelected.size;
          mergeAction.querySelector('.system-card-name')!.textContent = `Merge ${count} openings`;
          mergeAction.style.opacity = count < 2 ? '0.4' : '';
          mergeAction.style.pointerEvents = count < 2 ? 'none' : '';
        }
        updateMergeAction();
        mergeAction.addEventListener('click', async () => {
          const selectedNames = [...mergeSelected];
          dropdownOpen = false;
          pickerMode = 'normal';
          renderSystemPicker();

          const buttons: ConfirmButton[] = selectedNames.map(n => ({ label: n, value: n }));
          buttons.push({ label: 'New opening', value: '__new__', style: 'primary' });

          const result = await confirmModal({
            title: 'Merge into\u2026',
            message: 'Choose which name to keep. All locked moves will be combined and the rest deleted.',
            buttons,
            layout: 'vertical',
          });
          if (result) {
            mergeMultiple(selectedNames, result === '__new__' ? null : result);
            openingChangeCb?.();
            renderSystemPicker();
          }
        });
        dropdown.append(mergeAction);

        const cancelItem = document.createElement('div');
        cancelItem.className = 'system-dropdown-item system-dropdown-cancel';
        cancelItem.innerHTML = `${SVG_CLOSE} <span class="system-card-name">Cancel</span>`;
        cancelItem.querySelector('svg')!.setAttribute('width', '14');
        cancelItem.querySelector('svg')!.setAttribute('height', '14');
        cancelItem.querySelector('svg')!.style.fill = 'currentColor';
        cancelItem.addEventListener('click', () => {
          dropdownOpen = false;
          pickerMode = 'normal';
          renderSystemPicker();
        });
        dropdown.append(cancelItem);
      } else {
        // Normal dropdown: New opening, divider, Free Play, Full Repertoire, divider, custom openings

        // New opening (always first)
        const addItem = document.createElement('div');
        addItem.className = 'system-dropdown-item system-dropdown-add';
        addItem.innerHTML = `${SVG_PLUS} <span class="system-card-name">New opening</span>`;
        addItem.querySelector('svg')!.setAttribute('width', '16');
        addItem.querySelector('svg')!.setAttribute('height', '16');
        addItem.querySelector('svg')!.style.fill = 'currentColor';
        addItem.addEventListener('click', () => {
          dropdownOpen = false;
          createOpening();
          openingChangeCb?.();
          pickerMode = 'rename';
          renderSystemPicker();
        });
        dropdown.append(addItem);

        // Divider after New opening
        const divider1 = document.createElement('div');
        divider1.className = 'system-dropdown-divider';
        dropdown.append(divider1);

        // Free Play option
        if (!isFreePlayActive) {
          const fpItem = document.createElement('div');
          fpItem.className = 'system-dropdown-item';
          fpItem.append(makeCardIcon('free-play'));
          const fpName = document.createElement('div');
          fpName.className = 'system-card-name';
          fpName.textContent = FREE_PLAY_NAME;
          fpItem.append(fpName);
          fpItem.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(FREE_PLAY_NAME);
            openingChangeCb?.();
            renderSystemPicker();
          });
          dropdown.append(fpItem);
        }

        // Full Repertoire option (when 2+ custom openings exist)
        if (customRepertoires.length > 1 && !isFullRepActive) {
          const frItem = document.createElement('div');
          frItem.className = 'system-dropdown-item';
          frItem.append(makeCardIcon('full-rep'));
          const frName = document.createElement('div');
          frName.className = 'system-card-name';
          frName.textContent = FULL_REPERTOIRE_NAME;
          frItem.append(frName);
          frItem.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(FULL_REPERTOIRE_NAME);
            openingChangeCb?.();
            renderSystemPicker();
          });
          dropdown.append(frItem);
        }

        // Divider before custom openings (if any exist)
        if (customRepertoires.length > 0) {
          const divider2 = document.createElement('div');
          divider2.className = 'system-dropdown-divider';
          dropdown.append(divider2);
        }

        // Custom openings
        for (const name of customRepertoires) {
          if (name === active && isCustomActive) continue;
          const item = document.createElement('div');
          item.className = 'system-dropdown-item';

          item.append(makeCardIcon('custom'));

          const itemName = document.createElement('div');
          itemName.className = 'system-card-name';
          itemName.textContent = name;
          item.append(itemName);

          item.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(name);
            openingChangeCb?.();
            renderSystemPicker();
          });

          dropdown.append(item);
        }
      }

      wrapper.append(dropdown);
    }

    el.append(wrapper);


}


const MODE_OPTIONS: { value: PlayerColor; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'both', label: 'Manual' },
];

function renderControls(): void {
  const el = document.getElementById('controls')!;
  el.innerHTML = '';

  const newGameBtn = document.createElement('button');
  newGameBtn.textContent = 'New Game';
  newGameBtn.className = 'btn btn-primary';
  newGameBtn.addEventListener('click', () => newGameCb());

  const flipBtn = document.createElement('button');
  flipBtn.textContent = 'Flip Board';
  flipBtn.className = 'btn';
  flipBtn.addEventListener('click', () => flipCb());

  const segmentSection = document.createElement('div');
  segmentSection.className = 'config-toggle-header';

  const segment = document.createElement('div');
  segment.className = 'segment-picker';

  for (const opt of MODE_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = `segment-btn${currentConfig.playerColor === opt.value ? ' selected' : ''}`;
    btn.textContent = opt.label;
    btn.dataset.value = opt.value;
    btn.addEventListener('click', () => {
      if (currentConfig.playerColor === opt.value) return;
      currentConfig.playerColor = opt.value;
      segment.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      configChangeCb(currentConfig);
    });
    segment.append(btn);
  }

  const segmentInfo = document.createElement('div');
  segmentInfo.className = 'info-icon-wrap';
  segmentInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const segmentTooltip = document.createElement('div');
  segmentTooltip.className = 'info-tooltip';
  segmentTooltip.innerHTML =
    '<b>White</b> — you play white, bot plays black.<br>' +
    '<b>Black</b> — you play black, bot plays white.<br>' +
    '<b>Manual</b> — play both sides freely, no bot.';
  segmentInfo.append(segmentTooltip);

  segmentSection.append(segment, segmentInfo);

  el.append(segmentSection, flipBtn, newGameBtn);
}


function renderConfigPanel(): void {
  const inlineEl = document.getElementById('config-inline')!;
  inlineEl.innerHTML = '';

  // ── Display chips ──
  const displaySection = document.createElement('div');
  displaySection.className = 'config-toggle-section';

  const displayGrid = document.createElement('div');
  displayGrid.className = 'chip-grid';

  const evalChip = document.createElement('button');
  evalChip.className = `chip${currentConfig.showEval ? ' selected' : ''}`;
  evalChip.textContent = 'Eval';
  evalChip.setAttribute('data-tooltip', 'Stockfish evaluation bar next to the board');
  evalChip.addEventListener('click', () => {
    const isOn = evalChip.classList.toggle('selected');
    currentConfig.showEval = isOn;
    configChangeCb(currentConfig);
  });

  const badgesChip = document.createElement('button');
  badgesChip.className = `chip${currentConfig.showMoveBadges ? ' selected' : ''}`;
  badgesChip.textContent = 'Badges';
  badgesChip.setAttribute('data-tooltip', 'Mark best moves (!), mistakes (?), and traps (?!)');
  badgesChip.addEventListener('click', () => {
    const isOn = badgesChip.classList.toggle('selected');
    currentConfig.showMoveBadges = isOn;
    configChangeCb(currentConfig);
  });

  const explorerChip = document.createElement('button');
  explorerChip.className = `chip${currentConfig.showExplorer ? ' selected' : ''}`;
  explorerChip.textContent = 'Explorer';
  explorerChip.setAttribute('data-tooltip', 'Show explorer during bot play');
  explorerChip.addEventListener('click', () => {
    const isOn = explorerChip.classList.toggle('selected');
    currentConfig.showExplorer = isOn;
    configChangeCb(currentConfig);
  });

  const engineLinesChip = document.createElement('button');
  const elCount = currentConfig.engineLineCount;
  engineLinesChip.className = `chip${elCount > 0 ? ' selected' : ''}`;
  engineLinesChip.textContent = 'Engine';
  engineLinesChip.setAttribute('data-tooltip', 'Show engine analysis lines');
  engineLinesChip.addEventListener('click', () => {
    const wasOn = currentConfig.engineLineCount > 0;
    currentConfig.engineLineCount = wasOn ? 0 : (lastEngineLineCount || 1);
    engineLinesChip.classList.toggle('selected', !wasOn);
    configChangeCb(currentConfig);
  });

  displayGrid.append(evalChip, badgesChip, explorerChip, engineLinesChip);
  displaySection.append(displayGrid);

  inlineEl.append(displaySection);
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
    const whiteBadge = currentConfig.showMoveBadges ? historyBadge(i, history) : '';
    const blackBadge = black && currentConfig.showMoveBadges ? historyBadge(i + 1, history) : '';
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
