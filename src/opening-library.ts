import openings from './data/openings.json';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import { Chess } from 'chessops';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops';
import { parsePgn, startingPosition, walk, Box } from 'chessops/pgn';
import type { PgnNodeData } from 'chessops/pgn';
import type { Position } from 'chessops';
import { lockMove, positionKey, createOpening, switchOpening } from './repertoire';
import { pushKeyLayer, popKeyLayer } from './keyboard';

interface OpeningEntry {
  eco: string;
  name: string;
  pgn: string;
  fen: string;
}

interface MoveStep {
  san: string;
  fen: string;
}

interface Category {
  label: string;
  filter: (o: OpeningEntry) => boolean;
}

const allOpenings: OpeningEntry[] = openings as OpeningEntry[];

const CATEGORIES: Category[] = [
  { label: '1. e4',  filter: o => o.pgn.startsWith('1. e4') },
  { label: '1. d4',  filter: o => o.pgn.startsWith('1. d4') },
  { label: '1. c4',  filter: o => o.pgn.startsWith('1. c4') },
  { label: '1. Nf3', filter: o => o.pgn.startsWith('1. Nf3') },
  { label: 'Other',  filter: o => !o.pgn.startsWith('1. e4') && !o.pgn.startsWith('1. d4') && !o.pgn.startsWith('1. c4') && !o.pgn.startsWith('1. Nf3') },
];

let initialized = false;
let onImportCb: (() => void) | null = null;
let searchQuery = '';
let activeCategory: Category | null = null;
let displayedCount = 0;

// Detail panel state
let detailOpening: OpeningEntry | null = null;
let detailMoves: MoveStep[] = [];
let detailViewIndex = 0;
let detailCg: Api | null = null;

// Save scroll position when entering detail
let savedScrollTop = 0;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const RESULTS_PAGE = 50;

function countMoves(pgn: string): number {
  return pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/).filter(t => t && t !== '*').length;
}

export function initLibraryModal(onImport: () => void): void {
  if (initialized) return;
  initialized = true;
  onImportCb = onImport;

  document.getElementById('library-close')!.addEventListener('click', closeLibraryModal);
  document.getElementById('library-overlay')!.addEventListener('click', closeLibraryModal);

  const searchInput = document.getElementById('library-search') as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    displayedCount = 0;
    closeDetail();
    renderListArea();
  });

}

function handleLibraryKeydown(e: KeyboardEvent): boolean {
  const modal = document.getElementById('library-modal')!;
  if (modal.classList.contains('hidden')) return false;

  if (e.key === 'Escape') {
    if (detailOpening) {
      closeDetail();
    } else {
      closeLibraryModal();
    }
    e.preventDefault();
    return true;
  }

  if (detailOpening) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateDetail(-1);
      return true;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateDetail(1);
      return true;
    }
  }
  return false;
}

export function openLibraryModal(): void {
  searchQuery = '';
  activeCategory = null;
  detailOpening = null;
  displayedCount = 0;

  const overlay = document.getElementById('library-overlay')!;
  const modal = document.getElementById('library-modal')!;
  const searchInput = document.getElementById('library-search') as HTMLInputElement;

  searchInput.value = '';
  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');

  document.getElementById('library-detail')!.classList.add('hidden');
  document.getElementById('library-list-area')!.classList.remove('hidden');

  pushKeyLayer('library', handleLibraryKeydown);
  renderListArea();
  requestAnimationFrame(() => searchInput.focus());
}

export function closeLibraryModal(): void {
  popKeyLayer('library');
  const overlay = document.getElementById('library-overlay')!;
  const modal = document.getElementById('library-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
  closeDetail();
}

function filterOpenings(): OpeningEntry[] {
  const query = searchQuery.toLowerCase().trim();
  let results = allOpenings;

  if (activeCategory) {
    results = results.filter(activeCategory.filter);
  }

  if (query) {
    results = results.filter(o =>
      o.name.toLowerCase().includes(query) || o.pgn.toLowerCase().includes(query)
    );
  }

  return results;
}

// ── Static Mini Board ──

const PIECE_MAP: Record<string, { role: string; color: string }> = {
  P: { role: 'pawn', color: 'white' },
  N: { role: 'knight', color: 'white' },
  B: { role: 'bishop', color: 'white' },
  R: { role: 'rook', color: 'white' },
  Q: { role: 'queen', color: 'white' },
  K: { role: 'king', color: 'white' },
  p: { role: 'pawn', color: 'black' },
  n: { role: 'knight', color: 'black' },
  b: { role: 'bishop', color: 'black' },
  r: { role: 'rook', color: 'black' },
  q: { role: 'queen', color: 'black' },
  k: { role: 'king', color: 'black' },
};

function renderStaticBoard(fen: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cg-wrap library-static-board';

  const board = document.createElement('cg-board');
  wrap.append(board);

  const placement = fen.split(' ')[0];
  const rows = placement.split('/');

  for (let rank = 0; rank < 8; rank++) {
    const row = rows[rank];
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        const info = PIECE_MAP[ch];
        if (info) {
          const piece = document.createElement('piece');
          piece.className = `${info.role} ${info.color}`;
          const left = (file / 8) * 100;
          const top = (rank / 8) * 100;
          piece.style.cssText = `position:absolute;width:12.5%;height:12.5%;left:${left}%;top:${top}%`;
          board.append(piece);
        }
        file++;
      }
    }
  }

  return wrap;
}

// ── List Rendering ──

function renderListArea(): void {
  const resultsEl = document.getElementById('library-results')!;
  const statusEl = document.getElementById('library-status')!;
  const listArea = document.getElementById('library-list-area')!;
  const query = searchQuery.trim();

  // Remove back button if present
  const existingBack = listArea.querySelector('.library-back-btn');
  if (existingBack) existingBack.remove();

  // Update search placeholder
  const searchInput = document.getElementById('library-search') as HTMLInputElement;
  searchInput.placeholder = activeCategory
    ? `Search in ${activeCategory.label}...`
    : 'Search openings...';

  // Empty state: show categories
  if (!query && !activeCategory) {
    statusEl.textContent = '';
    renderCategories(resultsEl);
    return;
  }

  const filtered = filterOpenings();

  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div class="library-empty">No openings found</div>';
    statusEl.textContent = '';
    return;
  }

  displayedCount = Math.min(RESULTS_PAGE, filtered.length);
  renderOpeningList(resultsEl, statusEl, filtered, displayedCount);
}

function renderCategories(el: HTMLElement): void {
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'library-categories';

  for (const cat of CATEGORIES) {
    const count = allOpenings.filter(cat.filter).length;
    const btn = document.createElement('button');
    btn.className = 'library-category';
    btn.innerHTML = `<span class="library-category-label">${cat.label}</span><span class="library-category-count">${count} openings</span>`;
    btn.addEventListener('click', () => {
      activeCategory = cat;
      displayedCount = 0;
      renderListArea();
    });
    grid.append(btn);
  }

  el.append(grid);
}

function renderOpeningList(
  resultsEl: HTMLElement,
  statusEl: HTMLElement,
  filtered: OpeningEntry[],
  count: number,
): void {
  const visible = filtered.slice(0, count);

  // Status text
  if (activeCategory && !searchQuery.trim()) {
    statusEl.textContent = `${filtered.length} opening${filtered.length !== 1 ? 's' : ''} in ${activeCategory.label}`;
  } else if (filtered.length > count) {
    statusEl.textContent = `Showing ${count} of ${filtered.length} results`;
  } else {
    statusEl.textContent = `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;
  }

  resultsEl.innerHTML = '';

  // Back to categories button when in a category (outside scroll area)
  const listArea = document.getElementById('library-list-area')!;
  if (activeCategory) {
    const back = document.createElement('button');
    back.className = 'btn ghost';
    back.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg> All categories';
    back.addEventListener('click', () => {
      activeCategory = null;
      searchQuery = '';
      const searchEl = document.getElementById('library-search') as HTMLInputElement;
      searchEl.value = '';
      displayedCount = 0;
      renderListArea();
    });
    listArea.insertBefore(back, resultsEl);
  }

  for (const opening of visible) {
    resultsEl.append(createListItem(opening));
  }

  // "Show more" button
  if (filtered.length > count) {
    const more = document.createElement('button');
    more.className = 'library-show-more';
    more.textContent = `Show more (${filtered.length - count} remaining)`;
    more.addEventListener('click', () => {
      displayedCount = Math.min(displayedCount + RESULTS_PAGE, filtered.length);
      renderOpeningList(resultsEl, statusEl, filtered, displayedCount);
    });
    resultsEl.append(more);
  }
}

function createListItem(opening: OpeningEntry): HTMLElement {
  const item = document.createElement('div');
  item.className = 'library-item';

  const boardWrap = renderStaticBoard(opening.fen);
  boardWrap.classList.add('library-mini-board');

  const info = document.createElement('div');
  info.className = 'library-item-info';

  const name = document.createElement('div');
  name.className = 'library-name';
  name.textContent = opening.name;

  const meta = document.createElement('div');
  meta.className = 'library-meta';
  const moveCount = countMoves(opening.pgn);
  meta.textContent = `${moveCount} move${moveCount !== 1 ? 's' : ''}`;

  info.append(name, meta);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn sm';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    importOpening(opening);
    addBtn.textContent = 'Added';
    addBtn.classList.add('added');
    setTimeout(() => {
      addBtn.textContent = 'Add';
      addBtn.classList.remove('added');
    }, 2000);
  });

  item.addEventListener('click', () => openDetail(opening));

  item.append(boardWrap, info, addBtn);
  return item;
}

// ── Detail Panel ──

function computeMoves(pgn: string): MoveStep[] {
  const chess = Chess.default();
  const tokens = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/);
  const steps: MoveStep[] = [];

  for (const san of tokens) {
    if (!san || san === '*') continue;
    const move = parseSan(chess, san);
    if (!move) break;
    chess.play(move);
    steps.push({ san, fen: makeFen(chess.toSetup()) });
  }

  return steps;
}

function openDetail(opening: OpeningEntry): void {
  detailOpening = opening;
  detailMoves = computeMoves(opening.pgn);
  detailViewIndex = detailMoves.length;

  const listArea = document.getElementById('library-list-area')!;
  const resultsEl = document.getElementById('library-results')!;
  savedScrollTop = resultsEl.scrollTop;

  const detail = document.getElementById('library-detail')!;
  listArea.classList.add('hidden');
  detail.classList.remove('hidden');

  document.getElementById('library-detail-name')!.textContent = opening.name;

  const boardEl = document.getElementById('library-detail-board')!;
  boardEl.innerHTML = '';
  if (detailCg) {
    detailCg.destroy();
    detailCg = null;
  }

  detailCg = Chessground(boardEl, {
    fen: opening.fen,
    viewOnly: true,
    coordinates: true,
    animation: { enabled: true, duration: 150 },
    drawable: { enabled: false },
  });

  updateDetailNav();

  document.getElementById('library-detail-back')!.onclick = () => closeDetail();
  document.getElementById('library-detail-prev')!.onclick = () => navigateDetail(-1);
  document.getElementById('library-detail-next')!.onclick = () => navigateDetail(1);
  document.getElementById('library-detail-start')!.onclick = () => {
    detailViewIndex = 0;
    syncDetailBoard();
    updateDetailNav();
  };
  document.getElementById('library-detail-end')!.onclick = () => {
    detailViewIndex = detailMoves.length;
    syncDetailBoard();
    updateDetailNav();
  };

  const addBtn = document.getElementById('library-detail-add') as HTMLButtonElement;
  addBtn.textContent = 'Add to repertoire';
  addBtn.classList.remove('added');
  addBtn.onclick = () => {
    importOpening(opening);
    addBtn.textContent = 'Added';
    addBtn.classList.add('added');
    setTimeout(() => {
      addBtn.textContent = 'Add to repertoire';
      addBtn.classList.remove('added');
    }, 2000);
  };
}

function closeDetail(): void {
  detailOpening = null;
  if (detailCg) {
    detailCg.destroy();
    detailCg = null;
  }

  const listArea = document.getElementById('library-list-area')!;
  const detail = document.getElementById('library-detail')!;
  detail.classList.add('hidden');
  listArea.classList.remove('hidden');

  // Restore scroll position
  requestAnimationFrame(() => {
    document.getElementById('library-results')!.scrollTop = savedScrollTop;
  });
}

function navigateDetail(dir: number): void {
  const newIndex = detailViewIndex + dir;
  if (newIndex < 0 || newIndex > detailMoves.length) return;
  detailViewIndex = newIndex;
  syncDetailBoard();
  updateDetailNav();
}

function syncDetailBoard(): void {
  if (!detailCg) return;
  const fen = detailViewIndex === 0 ? STARTING_FEN : detailMoves[detailViewIndex - 1].fen;
  detailCg.set({ fen, lastMove: undefined });
}

function updateDetailNav(): void {
  const counter = document.getElementById('library-detail-counter')!;
  counter.textContent = `${detailViewIndex} / ${detailMoves.length}`;

  const prevBtn = document.getElementById('library-detail-prev') as HTMLButtonElement;
  const nextBtn = document.getElementById('library-detail-next') as HTMLButtonElement;
  const startBtn = document.getElementById('library-detail-start') as HTMLButtonElement;
  const endBtn = document.getElementById('library-detail-end') as HTMLButtonElement;
  prevBtn.disabled = detailViewIndex <= 0;
  startBtn.disabled = detailViewIndex <= 0;
  nextBtn.disabled = detailViewIndex >= detailMoves.length;
  endBtn.disabled = detailViewIndex >= detailMoves.length;
}

// ── Import ──

function importOpening(opening: OpeningEntry): void {
  const openingName = createOpening(opening.name);

  const games = parsePgn(opening.pgn);
  if (games.length === 0) return;

  const game = games[0];
  const posResult = startingPosition(game.headers);
  if (!posResult.isOk) return;

  const seen = new Set<string>();
  walk(game.moves, new Box(posResult.value), (ctx, node: PgnNodeData) => {
    const pos: Position = ctx.value;
    const move = parseSan(pos, node.san);
    if (!move) return;

    const fen = makeFen(pos.toSetup());
    const uci = makeUci(move);
    const key = `${positionKey(fen)}|${uci}`;
    if (!seen.has(key)) {
      seen.add(key);
      lockMove(fen, uci);
    }

    pos.play(move);
  });

  switchOpening(openingName);
  onImportCb?.();
}
