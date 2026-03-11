import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { loadConfig, saveConfig } from './config';
import { loadRepertoire } from './repertoire';
import {
  startGame, newGame, setListeners, updateConfig, getPhase,
  getExplorerData, fetchExplorerForFen, playExplorerMove, continueFromHere, playAutoMove, tryBotMove,
} from './game';
import {
  flipBoard, navigateBack, navigateForward, navigateTo, onViewChange,
  getMoveHistory, getViewIndex, isViewingHistory, showFen, replayLine, setOrientation,
  redrawBoard,
} from './board';
import {
  initUI,
  updateStatus,
  updateMoveList,
  updateExplorerPanel,
  updateAlertBanner,
  setExplorerAlwaysShow,
  resetExplorerRevealed,
  setNextMoveUci,
  setEvalWinPct,
  initSidebarTabs,
  renderEngineLines,
  setEngineLinesVisible,
  switchSidebarTab,
  toggleLockCurrentMove,
  isAnyModalOpen,
  openHelpModal,
  getLoadedGame,
  clearLoadedGame,
} from './ui';
import { renderHistoryTree, refreshHistoryTree, setSelectedFen, type LineEntry } from './history-tree';
import { setTreeNavigateCallback } from './tree-ui';
import { closeReportPage, openReportPage, setReportNavigateCallback } from './report-ui';
import { getCurrentMode, switchMode, onModeChange, applyModeClass, initModeRouting } from './mode';
import { setPersonalFilters, isDBReady } from './personal-explorer';
import { initMobileTabs } from './mobile-tabs';
import { hasCompletedOnboarding, showOnboarding } from './onboarding';
import type { AppConfig, GamePhase } from './types';
import { initEngine, evaluate, winningChance, formatScore, setMultiPV, setEngineErrorListener, retryEngine } from './engine';
import type { EvalScore, EngineLine } from './engine';
import { pushKeyLayer } from './keyboard';


const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let config = loadConfig();
let currentOpeningName: string | undefined;

function computeNextMoveUci(): string | null {
  const history = getMoveHistory();
  const vi = getViewIndex();
  // vi is the position after move vi. The next move from this position is history[vi].
  if (vi < history.length) {
    return history[vi].uci;
  }
  return null;
}

function getViewedFen(): string {
  const history = getMoveHistory();
  const vi = getViewIndex();
  if (vi === 0) return STARTING_FEN;
  return history[vi - 1].fen;
}

function updateEvalBar(score: EvalScore): void {
  const fillEl = document.getElementById('eval-fill')!;
  const labelEl = document.getElementById('eval-label')!;

  const whiteChance = winningChance(score);
  fillEl.style.height = `${(whiteChance * 100).toFixed(1)}%`;

  const text = formatScore(score);
  labelEl.textContent = text;

  if (score.value < 0 || (score.type === 'mate' && score.value < 0)) {
    labelEl.className = 'black-advantage';
  } else {
    labelEl.className = '';
  }

  // Update alert banner with engine eval (white's perspective, 0-100)
  setEvalWinPct(whiteChance * 100);
  updateAlertBanner();
}

function setEvalBarVisible(visible: boolean): void {
  document.getElementById('eval-bar')!.classList.toggle('hidden', !visible);
}

function setEvalBarLoading(): void {
  const labelEl = document.getElementById('eval-label')!;
  labelEl.textContent = '...';
  labelEl.className = 'eval-loading';
}

function requestEval(fen: string): void {
  setEvalWinPct(null); // clear stale eval while new one computes
  const linesEnabled = config.engineLineCount > 0;
  if (!config.showEval && !linesEnabled) return;

  setEvalBarLoading();
  setMultiPV(linesEnabled ? config.engineLineCount : 1);

  const linesCallback = linesEnabled
    ? (lines: EngineLine[]) => renderEngineLines(lines, fen)
    : undefined;

  evaluate(fen, config.showEval ? updateEvalBar : () => {}, linesCallback);
}

function refreshExplorerMode(): void {
  setExplorerAlwaysShow(config.playerColor === 'both' || isViewingHistory() || config.showExplorer);
}

function refreshTreeIfVisible(): void {
  const pgnPanel = document.getElementById('opening-lines-pgn');
  if (pgnPanel) refreshHistoryTree(pgnPanel);
}

function boot(): void {
  loadRepertoire();

  const boardEl = document.getElementById('board')!;

  initEngine();

  setEngineErrorListener((msg) => {
    const labelEl = document.getElementById('eval-label')!;
    const barEl = document.getElementById('eval-bar')!;
    labelEl.textContent = '!';
    labelEl.className = 'engine-error';
    barEl.setAttribute('data-tooltip', msg + ' — click to retry');
    barEl.classList.add('engine-error-state');
    barEl.onclick = () => {
      barEl.classList.remove('engine-error-state');
      barEl.onclick = null;
      retryEngine();
      requestEval(getViewedFen());
    };
  });

  setListeners(
    (phase: GamePhase) => {
      updateStatus(phase, currentOpeningName);
    },
    () => {
      const { data } = getExplorerData();
      if (data?.opening?.name) {
        currentOpeningName = data.opening.name;
      }
      updateStatus(getPhase(), currentOpeningName);
      setNextMoveUci(computeNextMoveUci());
      refreshExplorerMode();
      updateExplorerPanel();
      updateAlertBanner();
    },
    () => {
      resetExplorerRevealed();
      refreshExplorerMode();
      updateMoveList();
      updateExplorerPanel();
      requestEval(getViewedFen());
    },
  );

  initUI(
    config,
    (newConfig: AppConfig) => {
      const evalToggled = newConfig.showEval !== config.showEval;
      const linesToggled = newConfig.engineLineCount !== config.engineLineCount;
      config = { ...newConfig };
      saveConfig(config);
      updateConfig(config);
      refreshExplorerMode();
      setEvalBarVisible(config.showEval);
      setEngineLinesVisible(config.engineLineCount > 0);
      updateExplorerPanel();
      updateAlertBanner();
      updateMoveList();
      if (linesToggled && config.engineLineCount === 0) {
        renderEngineLines([], '');
        setMultiPV(1);
      }
      if ((evalToggled && config.showEval) || (linesToggled && config.engineLineCount > 0)) {
        requestEval(getViewedFen());
      }
    },
    () => {
      clearLoadedGame();
      currentOpeningName = undefined;
      newGame(config);
    },
    () => {
      flipBoard();
      updateExplorerPanel();
    },
    (uci: string) => {
      playExplorerMove(uci);
    },
    () => {
      continueFromHere();
    },
    () => {
      clearLoadedGame();
      currentOpeningName = undefined;
      newGame(config);
      updateExplorerPanel();
      updateAlertBanner();
      refreshTreeIfVisible();
    },
    () => {
      // Explorer mode changed — re-render panel and trigger bot if needed
      updateExplorerPanel();
      updateAlertBanner();
      tryBotMove();
    },
    () => {
      // Retry explorer fetch for current position
      fetchExplorerForFen(getViewedFen());
    },
  );

  pushKeyLayer('main', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'ArrowLeft') {
      if (isInput) return false;
      e.preventDefault();
      navigateBack();
      return true;
    }
    if (e.key === 'ArrowRight') {
      if (isInput) return false;
      e.preventDefault();
      navigateForward();
      return true;
    }
    if (e.key === 'ArrowUp') {
      if (isInput) return false;
      e.preventDefault();
      navigateTo(0);
      return true;
    }
    if (e.key === 'ArrowDown') {
      if (isInput) return false;
      e.preventDefault();
      navigateTo(getMoveHistory().length);
      return true;
    }

    if (isInput || isAnyModalOpen()) return false;

    switch (e.key) {
      case 'n':
        clearLoadedGame();
        currentOpeningName = undefined;
        newGame(config);
        return true;
      case 'f':
        flipBoard();
        updateExplorerPanel();
        return true;
      case 'l':
        toggleLockCurrentMove();
        return true;
      case 'e':
        document.getElementById('eval-chip')?.click();
        return true;
      case ' ':
        e.preventDefault();
        if (getLoadedGame()) {
          if (isViewingHistory()) {
            navigateForward();
          }
        } else if (isViewingHistory()) {
          continueFromHere();
        } else if (getPhase() === 'OUT_OF_BOOK' || getPhase() === 'GAME_OVER') {
          currentOpeningName = undefined;
          newGame(config);
        } else {
          playAutoMove();
        }
        return true;
      case '1':
        switchMode('trainer');
        return true;
      case '2':
        switchMode('report');
        return true;
      case 'd':
        switchSidebarTab('database');
        return true;
      case 'g':
        switchSidebarTab('personal');
        return true;
      case '?':
        openHelpModal();
        return true;
    }
    return false;
  });

  onViewChange((_index, _total) => {
    updateMoveList();
    refreshExplorerMode();
    const fen = getViewedFen();
    setNextMoveUci(computeNextMoveUci());
    fetchExplorerForFen(fen);
    requestEval(fen);
  });

  // Initialize sidebar tabs and tree panels
  const pgnPanel = document.getElementById('opening-lines-pgn')!;
  initSidebarTabs();

  const navigateToLine = (fen: string, line: LineEntry[]) => {
    if (line.length > 0) {
      replayLine(line);
    } else {
      showFen(fen);
    }
    setSelectedFen(fen);
    fetchExplorerForFen(fen);
    requestEval(fen);
    updateMoveList();
    updateExplorerPanel();
    updateAlertBanner();
    refreshTreeIfVisible();
  };
  renderHistoryTree(pgnPanel, navigateToLine);
  setTreeNavigateCallback(navigateToLine);

  // Report → trainer navigation
  setReportNavigateCallback((moves, fen, orientation, filters) => {
    switchMode('trainer');
    setPersonalFilters(filters);
    setOrientation(orientation);
    replayLine(moves);
    switchSidebarTab('personal');
    fetchExplorerForFen(fen);
    requestEval(fen);
    updateMoveList();
    updateExplorerPanel();
    updateAlertBanner();
    refreshTreeIfVisible();
  });

  // Tooltip on eval bar (JS popup isn't clipped by overflow:hidden)
  const evalBar = document.getElementById('eval-bar')!;
  evalBar.setAttribute('data-tooltip', 'Stockfish evaluation — white plays from bottom');
  evalBar.classList.add('tooltip-below');

  startGame(boardEl, config);
  refreshExplorerMode();
  updateMoveList();
  updateExplorerPanel();
  setEvalBarVisible(config.showEval);
  setEngineLinesVisible(config.engineLineCount > 0);
  requestEval(STARTING_FEN);

  if (!hasCompletedOnboarding()) {
    showOnboarding();
  }

  // TEMP: trigger onboarding from console with replayOnboarding()
  (window as any).replayOnboarding = () => {
    localStorage.removeItem('chessbased-onboarding-complete');
    showOnboarding();
  };

  initMobileTabs();

  // ── Nav bar + mode switching ──
  initModeRouting();

  // Wire nav tab clicks
  document.querySelectorAll<HTMLButtonElement>('#app-nav .app-nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as 'trainer' | 'report';
      switchMode(mode);
    });
  });

  // Wire nav help button
  document.getElementById('nav-help-btn')?.addEventListener('click', openHelpModal);

  // Sliding indicator — position the shared underline on the active tab
  const navIndicator = document.querySelector<HTMLElement>('.app-nav-indicator');
  function updateNavIndicator(mode: string): void {
    const tab = document.querySelector<HTMLElement>(`.app-nav-tab[data-mode="${mode}"]`);
    if (!navIndicator || !tab) return;
    const tabsRect = tab.parentElement!.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    navIndicator.style.left = `${tabRect.left - tabsRect.left + 8}px`;
    navIndicator.style.width = `${tabRect.width - 16}px`;
  }
  // Set initial position without animation
  if (navIndicator) navIndicator.style.transition = 'none';
  updateNavIndicator(getCurrentMode());
  requestAnimationFrame(() => {
    if (navIndicator) navIndicator.style.transition = '';
  });

  onModeChange((mode) => {
    document.querySelectorAll<HTMLButtonElement>('#app-nav .app-nav-tab').forEach(t =>
      t.classList.toggle('selected', t.dataset.mode === mode)
    );
    updateNavIndicator(mode);

    if (mode === 'report') openReportPage();
    else closeReportPage();

    if (document.startViewTransition) {
      const transition = document.startViewTransition(() => applyModeClass(mode));
      transition.finished.then(() => redrawBoard());
    } else {
      applyModeClass(mode);
      redrawBoard();
    }
  });

  // Restore report page if hash says #report on initial load
  if (getCurrentMode() === 'report') {
    const waitForDB = () => {
      if (isDBReady()) { openReportPage(); return; }
      setTimeout(waitForDB, 50);
    };
    waitForDB();
  }
}

boot();
