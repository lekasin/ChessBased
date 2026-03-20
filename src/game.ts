import type {
  AppConfig,
  ExplorerResponse,
  GamePhase,
  MoveHistoryEntry,
} from './types';
import {
  initBoard,
  playBotMove,
  getFen,
  getTurn,
  isGameOver,
  isViewingHistory,
  truncateToView,
  resetBoard,
  setOrientation,
  getMoveHistory,
} from './board';
import { queryExplorer, setRetryListener } from './explorer';
import { selectBotMove } from './bot';
import { getExplorerMode, queryPersonalExplorer } from './personal-explorer';
import { getBestMove, setEngineStrength } from './engine';

function cacheKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

let phase: GamePhase = 'USER_TURN';
let config: AppConfig;

let currentExplorerData: ExplorerResponse | null = null;
let currentExplorerFen: string = '';
let currentExplorerError: string | null = null;
let autoMoveInProgress = false;

// Cache explorer responses to avoid re-fetching when navigating
const explorerCache = new Map<string, ExplorerResponse>();

type PhaseListener = (phase: GamePhase) => void;
type ExplorerListener = () => void;
type MoveListener = () => void;
type UserMoveValidator = (preFen: string, uci: string) => boolean; // return true = move rejected

let onPhaseChange: PhaseListener | null = null;
let onExplorerUpdate: ExplorerListener | null = null;
let onMoveUpdate: MoveListener | null = null;
let userMoveValidator: UserMoveValidator | null = null;

export function setUserMoveValidator(cb: UserMoveValidator | null): void {
  userMoveValidator = cb;
}

export function setListeners(
  phaseCb: PhaseListener,
  explorerCb: ExplorerListener,
  moveCb: MoveListener,
): void {
  onPhaseChange = phaseCb;
  onExplorerUpdate = explorerCb;
  onMoveUpdate = moveCb;

  setRetryListener((attempt, max, delaySec) => {
    currentExplorerError = `Rate limited — retrying in ${delaySec}s (${attempt}/${max})`;
    onExplorerUpdate?.();
  });
}

function setPhase(p: GamePhase): void {
  phase = p;
  onPhaseChange?.(p);
}

export function getPhase(): GamePhase {
  return phase;
}

export function getExplorerData(): { data: ExplorerResponse | null; fen: string; error: string | null } {
  return { data: currentExplorerData, fen: currentExplorerFen, error: currentExplorerError };
}

/** Returns the color the bot plays, or null if manual mode */
function botColor(): 'white' | 'black' | null {
  if (config.playerColor === 'white') return 'black';
  if (config.playerColor === 'black') return 'white';
  return null;
}

/** Should the bot play right now? */
function shouldBotPlay(): boolean {
  const bot = botColor();
  return bot !== null && getTurn() === bot;
}

export function startGame(
  boardElement: HTMLElement,
  appConfig: AppConfig,
): void {
  config = appConfig;
  currentExplorerData = null;
  currentExplorerFen = '';
  explorerCache.clear();

  const boardColor = config.playerColor === 'both' ? 'white' : config.playerColor;
  initBoard(boardElement, boardColor, onUserMove);
  setPhase('USER_TURN');

  if (shouldBotPlay()) {
    doBotTurn();
  } else {
    fetchExplorerForFen(getFen());
  }
}

export function resumeFromPosition(appConfig: AppConfig): void {
  config = appConfig;
  currentExplorerData = null;
  currentExplorerFen = '';
  autoMoveInProgress = false;
  if (engineMode) {
    setEngineStrength(0);
    engineMode = false;
  }
  explorerCache.clear();

  // Truncate to current view if navigated backwards
  if (isViewingHistory()) {
    truncateToView();
  }

  const boardColor = config.playerColor === 'both' ? 'white' : config.playerColor;
  setOrientation(boardColor);
  setPhase('USER_TURN');
  onMoveUpdate?.();
  onExplorerUpdate?.();

  if (shouldBotPlay()) {
    doBotTurn();
  } else {
    fetchExplorerForFen(getFen());
  }
}

export function newGame(appConfig: AppConfig): void {
  config = appConfig;
  currentExplorerData = null;
  currentExplorerFen = '';
  autoMoveInProgress = false;
  if (engineMode) {
    setEngineStrength(0); // restore full strength for eval
    engineMode = false;
  }
  explorerCache.clear();

  const boardColor = config.playerColor === 'both' ? 'white' : config.playerColor;
  resetBoard(boardColor);
  setPhase('USER_TURN');
  onMoveUpdate?.();
  onExplorerUpdate?.();

  if (shouldBotPlay()) {
    doBotTurn();
  } else {
    fetchExplorerForFen(getFen());
  }
}

export async function fetchExplorerForFen(fen: string): Promise<ExplorerResponse | null> {
  // Check cache first
  const cached = explorerCache.get(cacheKey(fen));
  if (cached) {
    currentExplorerData = cached;
    currentExplorerFen = fen;
    currentExplorerError = null;
    onExplorerUpdate?.();
    return cached;
  }

  // Skip Lichess API call when in personal mode — data isn't displayed
  if (getExplorerMode() === 'personal') {
    currentExplorerData = null;
    currentExplorerFen = fen;
    onExplorerUpdate?.();
    return null;
  }

  try {
    const data = await queryExplorer(fen, config);
    if (data) {
      explorerCache.set(cacheKey(fen), data);
    }
    currentExplorerData = data;
    currentExplorerFen = fen;
    currentExplorerError = null;
    onExplorerUpdate?.();
    return data;
  } catch (err) {
    currentExplorerData = null;
    currentExplorerFen = fen;
    currentExplorerError = err instanceof Error ? err.message : 'Explorer request failed';
    onExplorerUpdate?.();
    return null;
  }
}

async function onUserMove(entry: MoveHistoryEntry): Promise<void> {
  onMoveUpdate?.();

  // Strict mode check: validate user move against repertoire (not in engine mode)
  if (userMoveValidator && !engineMode) {
    const history = getMoveHistory();
    const preFen = history.length <= 1
      ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
      : history[history.length - 2].fen;
    if (userMoveValidator(preFen, entry.uci)) {
      setPhase('GAME_OVER');
      return;
    }
  }

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  if (shouldBotPlay()) {
    if (engineMode) {
      await doEngineBotTurn();
    } else {
      await doBotTurn();
    }
  } else {
    setPhase('USER_TURN');
    if (!engineMode) await fetchExplorerForFen(getFen());
  }
}

let botTurnId = 0;

async function doBotTurn(): Promise<void> {
  const turnId = botTurnId;
  setPhase('BOT_THINKING');

  const fen = getFen();
  let data: ExplorerResponse | null = null;

  if (getExplorerMode() === 'personal') {
    data = queryPersonalExplorer(fen);
  }
  if (!data) {
    data = await fetchExplorerForFen(fen);
  }
  if (turnId !== botTurnId) return; // superseded

  if (!data || data.moves.length === 0) {
    setPhase('OUT_OF_BOOK');
    return;
  }

  const selected = selectBotMove(data.moves, fen, config.topMoves, config.botWeighting === 'weighted', config.botMinPlayRatePct);
  if (!selected) {
    setPhase('OUT_OF_BOOK');
    return;
  }

  const delay = 300 + Math.random() * 400;
  await new Promise((r) => setTimeout(r, delay));
  if (turnId !== botTurnId) return; // superseded

  playBotMove(selected.uci);
  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  setPhase('USER_TURN');
  await fetchExplorerForFen(getFen());
}

let engineMode = false;

async function doEngineBotTurn(): Promise<void> {
  const turnId = botTurnId;
  setPhase('BOT_THINKING');

  const fen = getFen();
  const bestMove = await getBestMove(fen);

  if (turnId !== botTurnId) return;
  if (!bestMove) {
    setPhase('GAME_OVER');
    return;
  }

  const delay = 300 + Math.random() * 400;
  await new Promise((r) => setTimeout(r, delay));
  if (turnId !== botTurnId) return;

  playBotMove(bestMove);
  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  setPhase('USER_TURN');
}

export function continueVsEngine(targetElo?: number): void {
  engineMode = true;
  setEngineStrength(targetElo ?? 0);
  if (shouldBotPlay()) {
    botTurnId++;
    doEngineBotTurn();
  } else {
    setPhase('USER_TURN');
  }
}

export function isEngineMode(): boolean {
  return engineMode;
}

export async function playExplorerMove(uci: string): Promise<void> {
  if (isViewingHistory()) {
    if (!truncateToView()) return;
  }

  const entry = playBotMove(uci);
  if (!entry) return;

  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  if (shouldBotPlay()) {
    await doBotTurn();
  } else {
    setPhase('USER_TURN');
    await fetchExplorerForFen(getFen());
  }
}

export async function continueFromHere(): Promise<void> {
  if (!isViewingHistory()) return;
  if (!truncateToView()) return;

  onMoveUpdate?.();

  if (shouldBotPlay()) {
    await doBotTurn();
  } else {
    setPhase('USER_TURN');
    await fetchExplorerForFen(getFen());
  }
}

export async function playAutoMove(): Promise<void> {
  if (autoMoveInProgress) return;
  if (isViewingHistory() || isGameOver() || phase === 'BOT_THINKING') return;

  autoMoveInProgress = true;
  try {
    // Only use cached data if it matches the current position
    const fen = getFen();
    const data = (currentExplorerFen === fen && currentExplorerData)
      ? currentExplorerData
      : await fetchExplorerForFen(fen);
    if (!data || data.moves.length === 0) return;

    const selected = selectBotMove(data.moves, getFen(), config.topMoves, config.botWeighting === 'weighted', config.botMinPlayRatePct);
    if (!selected) return;

    const entry = playBotMove(selected.uci);
    if (!entry) return;
    onMoveUpdate?.();

    if (isGameOver()) {
      setPhase('GAME_OVER');
      return;
    }

    if (shouldBotPlay()) {
      await doBotTurn();
    } else {
      setPhase('USER_TURN');
      await fetchExplorerForFen(getFen());
    }
  } finally {
    autoMoveInProgress = false;
  }
}

export function tryBotMove(): void {
  if (!isViewingHistory() && !isGameOver() && shouldBotPlay()) {
    botTurnId++; // cancel any in-flight bot turn
    doBotTurn();
  }
}

export function getExplorerCache(): Map<string, ExplorerResponse> {
  return explorerCache;
}

export function updateConfig(newConfig: AppConfig): void {
  const oldColor = config.playerColor;
  const explorerParamsChanged =
    JSON.stringify(newConfig.ratings) !== JSON.stringify(config.ratings) ||
    JSON.stringify(newConfig.speeds) !== JSON.stringify(config.speeds);
  config = newConfig;

  if (explorerParamsChanged) {
    explorerCache.clear();
    fetchExplorerForFen(getFen());
  }

  // Update board orientation if mode changed (manual mode keeps current orientation)
  if (newConfig.playerColor !== oldColor) {
    if (newConfig.playerColor !== 'both') {
      setOrientation(newConfig.playerColor);
    }

    // If the bot should now play in the current position, trigger it
    if (!isViewingHistory() && !isGameOver() && shouldBotPlay() && phase !== 'BOT_THINKING') {
      doBotTurn();
    }
  }
}
