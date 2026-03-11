import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { Chess, parseUci, isNormal } from 'chessops';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { MoveHistoryEntry } from './types';
import { playMoveSound } from './sound';

export interface BoardState {
  cg: Api;
  chess: Chess;
  moveHistory: MoveHistoryEntry[];
}

export type MoveCallback = (entry: MoveHistoryEntry) => void;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let state: BoardState | null = null;
let onUserMove: MoveCallback | null = null;

// Navigation state: viewIndex === moveHistory.length means "live"
let viewIndex: number = 0;
let viewChangeCallback: ((index: number, total: number) => void) | null = null;

export function initBoard(
  element: HTMLElement,
  playerColor: 'white' | 'black',
  moveCallback: MoveCallback,
): BoardState {
  const chess = Chess.default();
  onUserMove = moveCallback;
  viewIndex = 0;

  const cg = Chessground(element, {
    fen: makeFen(chess.toSetup()),
    orientation: playerColor,
    turnColor: 'white',
    movable: {
      free: false,
      color: 'both',
      dests: chessgroundDests(chess),
      showDests: true,
      events: {
        after: handleUserMove,
      },
    },
    animation: {
      enabled: true,
      duration: 200,
    },
    premovable: {
      enabled: false,
    },
    highlight: {
      lastMove: true,
      check: true,
    },
  });

  state = { cg, chess, moveHistory: [] };
  return state;
}

export function onViewChange(cb: (index: number, total: number) => void): void {
  viewChangeCallback = cb;
}

function handleUserMove(orig: Key, dest: Key): void {
  if (!state) return;

  // If viewing history, truncate to the viewed position first
  if (isViewingHistory()) {
    if (!truncateToView()) return;
  }

  const { chess } = state;

  let uci = `${orig}${dest}`;
  const fromSquareIdx = squareNameToIndex(orig);
  const toSquareIdx = squareNameToIndex(dest);

  if (fromSquareIdx === undefined || toSquareIdx === undefined) return;

  const piece = chess.board.get(fromSquareIdx);
  if (piece && piece.role === 'pawn') {
    const destRank = dest.charAt(1);
    if (destRank === '8' || destRank === '1') {
      uci += 'q';
    }
  }

  const move = parseUci(uci);
  if (!move) return;

  const san = makeSan(chess, move);
  playMoveSound(san.includes('x'));
  chess.play(move);

  const fen = makeFen(chess.toSetup());
  const entry: MoveHistoryEntry = { san, uci, fen };
  state.moveHistory.push(entry);

  // Snap to live
  viewIndex = state.moveHistory.length;

  syncBoard();

  if (onUserMove) {
    onUserMove(entry);
  }
}

export function playBotMove(uci: string): MoveHistoryEntry | null {
  if (!state) return null;

  const { chess, cg } = state;
  const move = parseUci(uci);
  if (!move) return null;

  if (!isNormal(move)) return null;

  const san = makeSan(chess, move);
  if (san === '--') return null;
  playMoveSound(san.includes('x'));

  const orig = indexToSquareName(move.from) as Key;
  const dest = indexToSquareName(move.to) as Key;

  chess.play(move);

  cg.move(orig, dest);

  const fen = makeFen(chess.toSetup());
  const entry: MoveHistoryEntry = { san, uci, fen };
  state.moveHistory.push(entry);

  // Snap to live
  viewIndex = state.moveHistory.length;

  syncBoard();
  return entry;
}

function syncBoard(): void {
  if (!state) return;
  const { cg, chess } = state;

  const turnColor = chess.turn === 'white' ? 'white' : 'black';

  cg.set({
    fen: makeFen(chess.toSetup()),
    turnColor,
    movable: {
      color: 'both',
      dests: chessgroundDests(chess),
    },
    check: chess.isCheck()
      ? turnColor
      : false,
  });
}

export function getFen(): string {
  if (!state) return '';
  return makeFen(state.chess.toSetup());
}

export function isGameOver(): boolean {
  if (!state) return false;
  return state.chess.isEnd();
}

export function getTurn(): 'white' | 'black' {
  if (!state) return 'white';
  return state.chess.turn;
}

export function getMoveHistory(): MoveHistoryEntry[] {
  return state?.moveHistory ?? [];
}

export function getViewIndex(): number {
  return viewIndex;
}

export function isViewingHistory(): boolean {
  if (!state) return false;
  return viewIndex < state.moveHistory.length;
}

export function navigateBack(): void {
  if (!state || viewIndex <= 0) return;
  viewIndex--;
  showViewPosition();
}

export function navigateForward(): void {
  if (!state) return;
  if (viewIndex >= state.moveHistory.length) return;
  viewIndex++;
  showViewPosition();
}

export function navigateTo(index: number): void {
  if (!state) return;
  if (index < 0 || index > state.moveHistory.length) return;
  if (index === viewIndex) return;
  viewIndex = index;
  showViewPosition();
}

export function truncateToView(): boolean {
  if (!state) return false;
  if (viewIndex >= state.moveHistory.length) return false;

  const fen = viewIndex === 0 ? STARTING_FEN : state.moveHistory[viewIndex - 1].fen;

  const setup = parseFen(fen);
  if (!setup.isOk) return false;
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return false;

  state.chess = pos.value;
  state.moveHistory = state.moveHistory.slice(0, viewIndex);
  // Now viewIndex === moveHistory.length → live
  syncBoard();
  return true;
}

function showViewPosition(): void {
  if (!state) return;
  const { cg, chess, moveHistory } = state;
  const isLive = viewIndex === moveHistory.length;

  if (isLive) {
    // Restore live board
    syncBoard();
  } else {
    // Show historical position — interactive so user can branch
    const fen = viewIndex === 0 ? STARTING_FEN : moveHistory[viewIndex - 1].fen;

    const setup = parseFen(fen);
    let isCheck = false;
    let turnColor: 'white' | 'black' = 'white';
    let dests = new Map<Key, Key[]>();
    if (setup.isOk) {
      const pos = Chess.fromSetup(setup.value);
      if (pos.isOk) {
        isCheck = pos.value.isCheck();
        turnColor = pos.value.turn;
        dests = chessgroundDests(pos.value);
      }
    }

    // Determine last move highlight
    let lastMove: [Key, Key] | undefined;
    if (viewIndex > 0) {
      const uci = moveHistory[viewIndex - 1].uci;
      const from = uci.slice(0, 2) as Key;
      const to = uci.slice(2, 4) as Key;
      lastMove = [from, to];
    }

    cg.set({
      fen,
      turnColor,
      lastMove,
      movable: {
        color: 'both',
        dests,
      },
      check: isCheck ? turnColor : false,
    });
  }

  viewChangeCallback?.(viewIndex, moveHistory.length);
}

export function resetBoard(playerColor: 'white' | 'black'): void {
  if (!state) return;

  const chess = Chess.default();
  state.chess = chess;
  state.moveHistory = [];
  viewIndex = 0;

  state.cg.set({
    fen: makeFen(chess.toSetup()),
    orientation: playerColor,
    turnColor: 'white',
    lastMove: undefined,
    check: false,
    movable: {
      color: 'both',
      dests: chessgroundDests(chess),
    },
  });
}

export function replayLine(line: MoveHistoryEntry[], startIndex?: number): void {
  if (!state) return;

  const chess = Chess.default();
  const history: MoveHistoryEntry[] = [];

  for (const entry of line) {
    const move = parseUci(entry.uci);
    if (!move) break;
    chess.play(move);
    history.push({ san: entry.san, uci: entry.uci, fen: makeFen(chess.toSetup()) });
  }

  state.chess = chess;
  state.moveHistory = history;
  viewIndex = startIndex != null ? Math.min(startIndex, history.length) : history.length;
  if (viewIndex < history.length) showViewPosition();
  else syncBoard();
  viewChangeCallback?.(viewIndex, history.length);
}

export function setOrientation(color: 'white' | 'black'): void {
  if (!state) return;
  state.cg.set({ orientation: color });
}

export function getOrientation(): 'white' | 'black' {
  return state?.cg.state.orientation ?? 'white';
}

export function flipBoard(): void {
  if (!state) return;
  state.cg.toggleOrientation();
}

export function showFen(fen: string): void {
  if (!state) return;
  const setup = parseFen(fen);
  if (!setup.isOk) return;
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return;

  state.cg.set({
    fen,
    turnColor: pos.value.turn,
    lastMove: undefined,
    movable: {
      color: 'both',
      dests: chessgroundDests(pos.value),
    },
    check: pos.value.isCheck() ? pos.value.turn : false,
  });
}

export function setAutoShapes(shapes: { orig: Key; dest?: Key; brush?: string }[]): void {
  if (!state) return;
  state.cg.setAutoShapes(shapes);
}

export function getBoard(): BoardState | null {
  return state;
}

export function redrawBoard(): void {
  state?.cg.redrawAll();
}

export function setViewOnly(viewOnly: boolean): void {
  if (!state) return;
  state.cg.set({
    viewOnly,
    movable: viewOnly ? { color: undefined } : {
      color: 'both',
      dests: chessgroundDests(state.chess),
    },
  });
}

export function setBoardFen(fen: string, lastMove?: [Key, Key]): void {
  if (!state) return;
  state.cg.set({ fen, lastMove });
}

function squareNameToIndex(name: string): number | undefined {
  if (name.length !== 2) return undefined;
  const file = name.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = name.charCodeAt(1) - '1'.charCodeAt(0);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return undefined;
  return rank * 8 + file;
}

function indexToSquareName(index: number): string {
  const file = String.fromCharCode('a'.charCodeAt(0) + (index % 8));
  const rank = String.fromCharCode('1'.charCodeAt(0) + Math.floor(index / 8));
  return `${file}${rank}`;
}
