import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { loadConfig, saveConfig } from './config';
import { loadRepertoire, switchOpening, getLockedMoves } from './repertoire';
import {
  startGame, newGame, resumeFromPosition, setListeners, updateConfig, getPhase, setUserMoveValidator, continueVsEngine,
  getExplorerData, fetchExplorerForFen, playExplorerMove, continueFromHere, playAutoMove, tryBotMove,
} from './game';
import {
  flipBoard, navigateBack, navigateForward, navigateTo, onViewChange,
  getMoveHistory, getViewIndex, isViewingHistory, showFen, replayLine, setOrientation,
  redrawBoard, setAutoShapes, getFen,
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
import {
  renderPlayPanel, setPlayStartCallback, setPlayQuitCallback, setPlayRestartCallback,
  setContinueVsEngineCallback, setResumeFromPositionCallback, setHintCallback,
  refreshPlayPicker, renderPlayingView, updatePlayStatus, updatePlayMoveList,
  setPlayingState, isPlaying, showStrictMiss, showEndOverlaySuccess, restartPlay, showPlayToast,
} from './play-ui';
import { getCurrentMode, switchMode, onModeChange, applyModeClass, initModeRouting } from './mode';
import { setPersonalFilters, isDBReady, getPersonalConfig, getPersonalGames } from './personal-explorer';
import { initMobileTabs } from './mobile-tabs';
import { hasCompletedOnboarding, showOnboarding } from './onboarding';
import type { AppConfig, GamePhase } from './types';
import { Chess, parseUci } from 'chessops';
import { parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { initEngine, evaluate, winningChance, formatScore, setMultiPV, setEngineErrorListener, retryEngine, getBestMove } from './engine';
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

  setEvalBarLoading();
  setMultiPV(linesEnabled ? config.engineLineCount : 1);

  const linesCallback = linesEnabled
    ? (lines: EngineLine[]) => renderEngineLines(lines, fen)
    : undefined;

  evaluate(fen, updateEvalBar, linesCallback);
}

function refreshExplorerMode(): void {
  setExplorerAlwaysShow(config.playerColor === 'both' || isViewingHistory());
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
      updatePlayStatus(phase, currentOpeningName);
      // Drill mode: end successfully when user's turn has no repertoire moves
      if (phase === 'USER_TURN' && isPlaying() && config.playMode === 'drill') {
        const fen = getFen();
        const fenKey = fen.split(' ').slice(0, 4).join(' ');
        const locked = getLockedMoves(fenKey);
        if (locked.length === 0) {
          showEndOverlaySuccess();
        }
      }
    },
    () => {
      const { data } = getExplorerData();
      if (data?.opening?.name) {
        currentOpeningName = data.opening.name;
      }
      updateStatus(getPhase(), currentOpeningName);
      updatePlayStatus(getPhase(), currentOpeningName);
      setNextMoveUci(computeNextMoveUci());
      refreshExplorerMode();
      updateExplorerPanel();
      updateAlertBanner();
    },
    () => {
      resetHint();
      resetExplorerRevealed();
      refreshExplorerMode();
      updateMoveList();
      updatePlayMoveList();
      updateExplorerPanel();
      requestEval(getViewedFen());
    },
  );

  initUI(
    config,
    (newConfig: AppConfig) => {
      const linesToggled = newConfig.engineLineCount !== config.engineLineCount;
      config = { ...newConfig };
      saveConfig(config);
      updateConfig(config);
      refreshExplorerMode();
      setEngineLinesVisible(config.engineLineCount > 0);
      updateExplorerPanel();
      updateAlertBanner();
      updateMoveList();
      if (linesToggled && config.engineLineCount === 0) {
        renderEngineLines([], '');
        setMultiPV(1);
      }
      if (linesToggled && config.engineLineCount > 0) {
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

  // Hint system for play mode
  let hintStep = 0; // 0=none, 1=pieces highlighted, 2=arrows shown
  let hintMoves: string[] = []; // UCI strings for current hint

  function resetHint(): void {
    if (hintStep > 0) {
      setAutoShapes([]);
      hintStep = 0;
      hintMoves = [];
    }
  }

  async function getHintMoves(): Promise<string[]> {
    const fen = getFen();
    const fenKey = fen.split(' ').slice(0, 4).join(' ');
    const locked = getLockedMoves(fenKey);
    if (locked.length > 0) return locked;

    // Fall back to best explorer move by win rate (min 5% play rate)
    const { data } = getExplorerData();
    if (data && data.moves.length > 0) {
      const totalGames = data.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
      const isWhite = fen.split(' ')[1] === 'w';
      const candidates = data.moves
        .filter(m => {
          const games = m.white + m.draws + m.black;
          return totalGames > 0 && (games / totalGames) >= 0.05;
        })
        .sort((a, b) => {
          const aGames = a.white + a.draws + a.black;
          const bGames = b.white + b.draws + b.black;
          const aWr = aGames > 0 ? (isWhite ? a.white : a.black) / aGames : 0;
          const bWr = bGames > 0 ? (isWhite ? b.white : b.black) / bGames : 0;
          return bWr - aWr;
        });
      if (candidates.length > 0) return [candidates[0].uci];
    }

    // Fall back to Stockfish best move
    const best = await getBestMove(fen);
    return best ? [best] : [];
  }

  let hintLoading = false;

  async function advanceHint(): Promise<void> {
    if (hintLoading) return;

    if (hintStep === 0) {
      hintLoading = true;
      hintMoves = await getHintMoves();
      hintLoading = false;
      if (hintMoves.length === 0) return;
      // Show which piece(s) to move
      const origins = [...new Set(hintMoves.map(u => u.slice(0, 2)))];
      setAutoShapes(origins.map(sq => ({ orig: sq as any, brush: 'yellow' })));
      hintStep = 1;
    } else if (hintStep === 1) {
      // Show full move arrow(s)
      setAutoShapes(hintMoves.map(u => ({
        orig: u.slice(0, 2) as any,
        dest: u.slice(2, 4) as any,
        brush: 'yellow',
      })));
      hintStep = 2;
    } else {
      // Make the move (first hint move)
      setAutoShapes([]);
      hintStep = 0;
      const uci = hintMoves[0];
      hintMoves = [];
      playExplorerMove(uci);
    }
  }

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

    // ── Play mode keys ──
    if (getCurrentMode() === 'play') {
      if (isPlaying()) {
        const phase = getPhase();
        const gameEnded = phase === 'GAME_OVER' || phase === 'OUT_OF_BOOK';

        switch (e.key) {
          case ' ':
            e.preventDefault();
            if (gameEnded) {
              restartPlay();
            } else if (phase === 'USER_TURN' && !isViewingHistory()) {
              advanceHint();
            }
            return true;
          case 'n':
            restartPlay();
            return true;
          case 'f':
            flipBoard();
            return true;
          case '1': switchMode('play'); return true;
          case '2': switchMode('explore'); return true;
          case '3': switchMode('report'); return true;
        }
      } else {
        // Pre-game setup
        switch (e.key) {
          case ' ':
            e.preventDefault();
            document.getElementById('play-start-btn')?.click();
            return true;
          case 'f':
            flipBoard();
            return true;
          case '1': switchMode('play'); return true;
          case '2': switchMode('explore'); return true;
          case '3': switchMode('report'); return true;
        }
      }
      return false;
    }

    // ── Explore mode keys ──
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
        switchMode('play');
        return true;
      case '2':
        switchMode('explore');
        return true;
      case '3':
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
    switchMode('explore');
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
  setEvalBarVisible(true);
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

  // ── Play panel ──
  renderPlayPanel();

  function uciToSan(fen: string, uci: string): string | null {
    const setup = parseFen(fen);
    if (!setup.isOk) return null;
    const pos = Chess.fromSetup(setup.value);
    if (!pos.isOk) return null;
    const move = parseUci(uci);
    if (!move) return null;
    return makeSan(pos.value, move);
  }

  function getEngineTargetElo(): number {
    // Try user's rating from Chess.com stats snapshot
    const pc = getPersonalConfig();
    if (pc?.chesscomStats?.timeClassRatings) {
      const ratings = pc.chesscomStats.timeClassRatings;
      let best = 0;
      for (const tc of ['rapid', 'blitz', 'bullet', 'classical'] as const) {
        const r = ratings[tc]?.currentRating;
        if (r && r > best) best = r;
      }
      if (best > 0) return best;
    }

    // Try latest rating from imported games (works for Lichess + Chess.com)
    const games = getPersonalGames();
    if (games && games.length > 0) {
      for (let i = games.length - 1; i >= 0; i--) {
        if (games[i].ur > 0) return Math.round(games[i].ur);
      }
    }

    // Fall back to midpoint of selected DB rating range
    const r = config.ratings;
    if (r.length > 0) {
      return Math.round((r[0] + r[r.length - 1]) / 2);
    }
    return 1500;
  }

  function startPlayGame(opening: string, side: 'white' | 'black'): void {
    config = loadConfig(); // reload to pick up playMode and other UI changes
    switchOpening(opening);
    config.playerColor = side;
    saveConfig(config);
    setOrientation(side);
    currentOpeningName = undefined;

    if (config.playMode === 'strict' || config.playMode === 'drill') {
      setUserMoveValidator((preFen, uci) => {
        const fenKey = preFen.split(' ').slice(0, 4).join(' ');
        const locked = getLockedMoves(fenKey);
        if (locked.length === 0) {
          if (config.playMode === 'drill') {
            // Repertoire complete — success!
            showEndOverlaySuccess();
            return true;
          }
          return false; // strict: no repertoire = any move is fine
        }
        if (locked.includes(uci)) return false; // correct move
        // Wrong move — show what was correct
        const correctSans = locked
          .map(u => uciToSan(preFen, u))
          .filter((s): s is string => s !== null);
        showStrictMiss(correctSans);
        return true; // reject
      });
    } else {
      // Relaxed mode: show toast when leaving repertoire
      setUserMoveValidator((preFen, _uci) => {
        const fenKey = preFen.split(' ').slice(0, 4).join(' ');
        const locked = getLockedMoves(fenKey);
        if (locked.length > 0 && !locked.includes(_uci)) {
          showPlayToast('Left your repertoire');
        }
        return false; // never reject
      });
    }

    newGame(config);
    renderPlayingView(getPhase(), currentOpeningName);
  }

  setPlayStartCallback(startPlayGame);
  setPlayRestartCallback(startPlayGame);
  setPlayQuitCallback(() => {
    setUserMoveValidator(null);
    config.playerColor = 'both';
    saveConfig(config);
    updateConfig(config);
  });
  setContinueVsEngineCallback(() => {
    setUserMoveValidator(null);
    const targetElo = getEngineTargetElo();
    continueVsEngine(targetElo);
  });
  setResumeFromPositionCallback((side) => {
    config = loadConfig();
    config.playerColor = side;
    saveConfig(config);
    currentOpeningName = undefined;

    if (config.playMode === 'strict' || config.playMode === 'drill') {
      setUserMoveValidator((preFen, uci) => {
        const fenKey = preFen.split(' ').slice(0, 4).join(' ');
        const locked = getLockedMoves(fenKey);
        if (locked.length === 0) {
          if (config.playMode === 'drill') {
            showEndOverlaySuccess();
            return true;
          }
          return false;
        }
        if (locked.includes(uci)) return false;
        const correctSans = locked
          .map(u => uciToSan(preFen, u))
          .filter((s): s is string => s !== null);
        showStrictMiss(correctSans);
        return true;
      });
    } else {
      setUserMoveValidator((preFen, _uci) => {
        const fenKey = preFen.split(' ').slice(0, 4).join(' ');
        const locked = getLockedMoves(fenKey);
        if (locked.length > 0 && !locked.includes(_uci)) {
          showPlayToast('Left your repertoire');
        }
        return false;
      });
    }

    resumeFromPosition(config);
    renderPlayingView(getPhase(), currentOpeningName);
  });
  setHintCallback(() => advanceHint());

  // ── Nav bar + mode switching ──
  initModeRouting();

  // Wire nav tab clicks
  document.querySelectorAll<HTMLButtonElement>('#app-nav .app-nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as 'play' | 'explore' | 'report';
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
    if (mode !== 'play' && isPlaying()) {
      setUserMoveValidator(null);
      setPlayingState(false);
    }
    if (mode === 'explore') {
      config.playerColor = 'both';
      saveConfig(config);
      updateConfig(config);
      updateMoveList();
      fetchExplorerForFen(getViewedFen());
    }
    if (mode === 'play') refreshPlayPicker();

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
