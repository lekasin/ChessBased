export interface EvalScore {
  type: 'cp' | 'mate';
  value: number; // centipawns or moves to mate (negative = black advantage)
  depth: number;
}

export interface EngineLine {
  rank: number;       // multipv index (1-based)
  score: EvalScore;
  pv: string[];       // UCI moves: ["e2e4", "e7e5", "g1f3"]
  depth: number;
}

type EvalCallback = (score: EvalScore) => void;
type LinesCallback = (lines: EngineLine[]) => void;
type EngineErrorCallback = (msg: string) => void;

const SEARCH_DEPTH = 18;
const STOP_TIMEOUT_MS = 10_000;

// --- Deferred promise helper ---

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- Engine state ---

let worker: Worker | null = null;
let idle: Deferred<void> = deferred(); // resolves when engine is idle (no search running)
let searching = false;
let queued: { fen: string; onUpdate: EvalCallback } | null = null;
let currentCallback: EvalCallback | null = null;
let stopTimeout: ReturnType<typeof setTimeout> | null = null;
let stopping: Promise<void> | null = null; // non-null while waiting for stop to complete

let linesCallback: LinesCallback | null = null;
let currentLines: Map<number, EngineLine> = new Map();
let currentMultiPV = 1;
let searchBlackToMove = false;
let pendingLinesCallback: LinesCallback | null = null;
let onEngineError: EngineErrorCallback | null = null;
let initFailCount = 0;

// Start idle
idle.resolve();

function send(cmd: string): void {
  worker?.postMessage(cmd);
}

function onMessage(e: MessageEvent): void {
  const line: string = e.data;

  if (line === 'readyok') {
    return; // handled by waitReady
  }

  if (line.startsWith('info') && line.includes(' score ') && currentCallback) {
    const score = parseScore(line);
    if (score) {
      // Only call the main eval callback for the best line (multipv 1 or absent)
      const mpvMatch = line.match(/\bmultipv (\d+)/);
      const mpvRank = mpvMatch ? parseInt(mpvMatch[1]) : 1;
      if (mpvRank === 1) currentCallback(score);

      // Accumulate lines for the lines panel
      if (linesCallback) {
        const pvMatch = line.match(/\bpv (.+)/);
        const pv = pvMatch ? pvMatch[1].split(/\s+/) : [];
        currentLines.set(mpvRank, { rank: mpvRank, score, pv, depth: score.depth });
        const sorted = Array.from(currentLines.values()).sort((a, b) => a.rank - b.rank);
        linesCallback(sorted);
      }
    }
  }

  if (line.startsWith('bestmove')) {
    searching = false;
    if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null; }
    idle.resolve();

    // If a new eval was queued while we waited, start it now
    if (queued) {
      const { fen, onUpdate } = queued;
      queued = null;
      startSearch(fen, onUpdate);
    }
  }
}

function parseScore(line: string): EvalScore | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const depth = depthMatch ? parseInt(depthMatch[1]) : 0;

  if (cpMatch) return { type: 'cp', value: parseInt(cpMatch[1]), depth };
  if (mateMatch) return { type: 'mate', value: parseInt(mateMatch[1]), depth };
  return null;
}

function waitReady(): Promise<void> {
  const d = deferred<void>();
  const handler = (e: MessageEvent) => {
    if (e.data === 'readyok') {
      worker!.removeEventListener('message', handler);
      d.resolve();
    }
  };
  worker!.addEventListener('message', handler);
  send('isready');
  return d.promise;
}

function createWorker(): Worker {
  const w = new Worker('/stockfish.js');
  w.addEventListener('message', onMessage);

  w.addEventListener('error', () => {
    console.warn('Stockfish worker crashed, restarting…');
    initFailCount++;
    const pending = queued || (searching && currentCallback
      ? { fen: '', onUpdate: currentCallback }
      : null);
    teardown(w);

    if (initFailCount >= 2) {
      onEngineError?.('Engine unavailable — your browser may not support WebAssembly');
      return;
    }

    initEngine();
    if (pending && pending.fen) {
      evaluate(pending.fen, pending.onUpdate);
    }
  });

  return w;
}

function teardown(w: Worker): void {
  w.removeEventListener('message', onMessage);
  try { w.terminate(); } catch (_) { /* already dead */ }
  worker = null;
  searching = false;
  currentCallback = null;
  queued = null;
  if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null; }
  stopping = null;
  idle = deferred();
  idle.resolve();
}

async function stopCurrent(): Promise<void> {
  if (!searching) return;

  // If already stopping, just wait for that to finish
  if (stopping) { await stopping; return; }

  send('stop');

  // Race: either bestmove arrives or we timeout and reset
  const timeout = new Promise<'timeout'>((res) => {
    stopTimeout = setTimeout(() => res('timeout'), STOP_TIMEOUT_MS);
  });

  stopping = (async () => {
    const result = await Promise.race([
      idle.promise.then(() => 'done' as const),
      timeout,
    ]);

    if (result === 'timeout') {
      console.warn('Stockfish stop timed out, resetting worker…');
      if (worker) teardown(worker);
      initEngine();
      await waitReady();
    }
    stopping = null;
  })();

  await stopping;
}

async function startSearch(fen: string, onUpdate: EvalCallback): Promise<void> {
  // Normalize scores to white's perspective
  const blackToMove = fen.split(' ')[1] === 'b';
  searchBlackToMove = blackToMove;
  currentCallback = (score: EvalScore) => {
    onUpdate({
      ...score,
      value: blackToMove ? -score.value : score.value,
    });
  };

  // Clear accumulated lines for this new search
  currentLines = new Map();

  // Wrap the lines callback to normalize scores to white's perspective
  if (pendingLinesCallback) {
    const rawCb = pendingLinesCallback;
    linesCallback = (lines: EngineLine[]) => {
      rawCb(lines.map(l => ({
        ...l,
        score: {
          ...l.score,
          value: searchBlackToMove ? -l.score.value : l.score.value,
        },
      })));
    };
  } else {
    linesCallback = null;
  }

  // Fresh deferred for this search
  idle = deferred();
  searching = true;

  send(`position fen ${fen}`);
  send(`go depth ${SEARCH_DEPTH}`);
}

// --- Public API ---

export function initEngine(): void {
  if (worker) return;
  worker = createWorker();
  send('uci');
  if (currentMultiPV > 1) {
    send(`setoption name MultiPV value ${currentMultiPV}`);
  }
  send('isready');
}

export function setMultiPV(count: number): void {
  const clamped = Math.max(1, Math.min(count, 5));
  if (clamped === currentMultiPV) return;
  currentMultiPV = clamped;
  if (worker) {
    send(`setoption name MultiPV value ${currentMultiPV}`);
  }
}

export async function evaluate(fen: string, onUpdate: EvalCallback, onLines?: LinesCallback): Promise<void> {
  if (!worker) initEngine();

  pendingLinesCallback = onLines ?? null;

  // If a search is running, queue this and stop the current one.
  // If something is already queued, replace it (only latest matters).
  if (searching) {
    queued = { fen, onUpdate };
    await stopCurrent();
    // stopCurrent resolves → bestmove handler picks up queued work
    return;
  }

  await startSearch(fen, onUpdate);
}

/** Set engine strength via UCI_LimitStrength + UCI_Elo (1320-3190, or 0 for full strength) */
export function setEngineStrength(elo: number): void {
  if (!worker) initEngine();
  if (elo <= 0) {
    send('setoption name UCI_LimitStrength value false');
  } else {
    const clamped = Math.max(1320, Math.min(3190, elo));
    send('setoption name UCI_LimitStrength value true');
    send(`setoption name UCI_Elo value ${clamped}`);
  }
}

/** Run a search and return the best move UCI string */
export async function getBestMove(fen: string): Promise<string | null> {
  if (!worker) initEngine();

  // Stop any running search and clear queue so we get a clean slot
  if (searching) {
    queued = null;
    await stopCurrent();
  }

  // Now idle — run a fresh search and capture best move from PV
  let bestMove: string | null = null;
  pendingLinesCallback = (lines) => {
    if (lines.length > 0 && lines[0].pv.length > 0) {
      bestMove = lines[0].pv[0];
    }
  };

  await startSearch(fen, () => {});
  await idle.promise; // wait for search to actually finish
  return bestMove;
}

/** Convert eval score to white's winning chance 0..1 (0.5 = equal) */
export function winningChance(score: EvalScore): number {
  if (score.type === 'mate') {
    return score.value > 0 ? 1 : 0;
  }
  // Lichess winning chances formula
  return 1 / (1 + Math.exp(-0.00368208 * score.value));
}

export function formatScore(score: EvalScore): string {
  if (score.type === 'mate') {
    return `M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${sign}${pawns.toFixed(1)}`;
}

export function setEngineErrorListener(cb: EngineErrorCallback | null): void {
  onEngineError = cb;
}

export function retryEngine(): void {
  initFailCount = 0;
  if (worker) {
    teardown(worker);
  }
  initEngine();
}

export function isEngineReady(): boolean {
  return worker !== null;
}

export function destroyEngine(): void {
  if (worker) {
    send('quit');
    teardown(worker);
  }
}
