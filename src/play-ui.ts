import { getOpeningNames, getActiveOpening, FREE_PLAY_NAME, getLockedMoves } from './repertoire';
import { loadConfig, saveConfig } from './config';
import { createOpeningPicker } from './opening-picker';
import { createRangeBar } from './range-bar';
import { switchMode } from './mode';
import { setOrientation, getMoveHistory, getViewIndex, navigateTo, isCheckmate, getTurn } from './board';
import { getExplorerData } from './game';
import type { BotWeighting, GamePhase, PlayMode } from './types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type PlayStartCallback = (opening: string, side: 'white' | 'black') => void;
type PlayQuitCallback = () => void;

let onPlayStart: PlayStartCallback | null = null;
let onPlayQuit: PlayQuitCallback | null = null;
let onPlayRestart: PlayStartCallback | null = null;
let onContinueVsEngine: (() => void) | null = null;
let onResumeFromPosition: ((side: 'white' | 'black') => void) | null = null;
let onHint: (() => void) | null = null;
let playing = false;
let lastOpeningName: string = '';
let lastSide: 'white' | 'black' = 'white';
let strictMissInfo: string[] | null = null; // correct SANs when strict miss occurs

export function setPlayStartCallback(cb: PlayStartCallback): void {
  onPlayStart = cb;
}

export function setPlayQuitCallback(cb: PlayQuitCallback): void {
  onPlayQuit = cb;
}

export function setPlayRestartCallback(cb: PlayStartCallback): void {
  onPlayRestart = cb;
}

export function setContinueVsEngineCallback(cb: () => void): void {
  onContinueVsEngine = cb;
}

export function setResumeFromPositionCallback(cb: (side: 'white' | 'black') => void): void {
  onResumeFromPosition = cb;
}

export function setHintCallback(cb: () => void): void {
  onHint = cb;
}

export function setPlayingState(isPlaying: boolean): void {
  playing = isPlaying;
  const setup = document.getElementById('play-setup');
  const settings = document.getElementById('play-settings');
  if (setup) setup.classList.toggle('hidden', isPlaying);
  if (settings) settings.classList.toggle('hidden', !isPlaying);
}

export function isPlaying(): boolean {
  return playing;
}

export function restartPlay(): void {
  if (lastOpeningName && onPlayRestart) {
    onPlayRestart(lastOpeningName, lastSide);
  }
}

const playPicker = createOpeningPicker({
  mode: 'play',
  getContainer: () => document.getElementById('play-opening-picker'),
  onChange: () => {
    updatePlayState();
  },
  onAddNew: () => {
    switchMode('explore');
  },
});

export function renderPlayPanel(): void {
  renderSetup();
}

export function refreshPlayPicker(): void {
  renderSetup();
}

function updatePlayState(): void {
  const btn = document.getElementById('play-start-btn') as HTMLButtonElement | null;
  if (btn) {
    const names = getOpeningNames().filter(n => n !== FREE_PLAY_NAME);
    btn.disabled = names.length === 0;
  }
  const modeRow = document.getElementById('play-mode-row');
  if (modeRow) {
    modeRow.classList.toggle('hidden', getActiveOpening() === FREE_PLAY_NAME);
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function infoBtn(tooltip: string): HTMLElement {
  const btn = document.createElement('div');
  btn.className = 'play-info-btn';
  btn.setAttribute('data-tooltip', tooltip);
  btn.classList.add('tooltip-wide');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  return btn;
}

// ── Play status + move list (shown during game) ──

export function updatePlayStatus(phase: GamePhase, openingName?: string): void {
  if (!playing) return;
  const container = document.getElementById('play-settings');
  if (!container) return;

  // Update status section
  const statusEl = container.querySelector('.play-status');
  if (statusEl) {
    statusEl.innerHTML = buildStatusHtml(phase, openingName);
  }

  // Update move list
  const movesEl = container.querySelector('.play-moves');
  if (movesEl) {
    renderPlayMoves(movesEl as HTMLElement);
  }

  // Show overlay for game-ending phases
  if (phase === 'GAME_OVER' && !strictMissInfo) {
    if (isCheckmate()) {
      const loser = getTurn();
      const playerWon = loser !== lastSide;
      showEndOverlay(
        playerWon ? '♚' : '✗',
        playerWon ? 'Checkmate!' : 'Checkmate',
        playerWon ? 'You win!' : 'You lost',
        playerWon ? 'success' : 'danger',
      );
    } else {
      showEndOverlay('½', 'Draw', 'Game drawn', 'neutral');
    }
  } else if (phase === 'OUT_OF_BOOK') {
    const playMode = loadConfig().playMode;
    if (playMode === 'drill') {
      showEndOverlay('✓', 'Repertoire complete!', 'You played all the right moves', 'success');
    } else {
      showEndOverlay('📖', 'Out of book', 'No more moves in the database', 'neutral', true);
    }
  }
}

export function showEndOverlaySuccess(): void {
  showEndOverlay('✓', 'Repertoire complete!', 'You played all the right moves', 'success');
}

export function showStrictMiss(correctSans: string[]): void {
  strictMissInfo = correctSans;
  const correctText = correctSans.length === 1
    ? correctSans[0]
    : correctSans.slice(0, 3).join(', ');
  showEndOverlay('✗', 'Wrong move', `Correct was <strong>${correctText}</strong>`, 'danger');
}

function showEndOverlay(icon: string, title: string, detail: string, tone: 'success' | 'danger' | 'neutral', showContinue = false): void {
  const overlay = document.getElementById('board-overlay');
  if (!overlay) return;

  let actionsHtml = '';
  actionsHtml += `<button class="btn btn-primary board-overlay-btn" data-action="restart">Play again</button>`;
  if (showContinue) {
    actionsHtml += `<button class="btn board-overlay-btn" data-action="continue">Continue vs Stockfish</button>`;
  }
  actionsHtml += `<button class="btn board-overlay-btn" data-action="explore">Explore</button>`;
  actionsHtml += `<button class="btn ghost board-overlay-btn" data-action="quit">Back</button>`;

  overlay.innerHTML =
    `<div class="board-overlay-card ${tone}">` +
    `<div class="board-overlay-icon">${icon}</div>` +
    `<div class="board-overlay-title">${title}</div>` +
    `<div class="board-overlay-detail">${detail}</div>` +
    `<div class="board-overlay-actions">${actionsHtml}</div>` +
    `</div>`;

  overlay.classList.remove('hidden');

  overlay.querySelector('[data-action="explore"]')?.addEventListener('click', goToExplore);
  overlay.querySelector('[data-action="continue"]')?.addEventListener('click', () => {
    hideBoardOverlay();
    onContinueVsEngine?.();
  });
  overlay.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
    hideBoardOverlay();

    onPlayRestart?.(lastOpeningName, lastSide);
  });
  overlay.querySelector('[data-action="quit"]')?.addEventListener('click', () => {
    hideBoardOverlay();

    setPlayingState(false);
    onPlayQuit?.();
  });
}

function goToExplore(): void {
  // Navigate to end of history so no moves are truncated on mode switch
  const history = getMoveHistory();
  navigateTo(history.length);
  hideBoardOverlay();
  setPlayingState(false);
  onPlayQuit?.();
  switchMode('explore');
}


export function showPlayToast(message: string): void {
  const board = document.getElementById('board');
  if (!board) return;
  // Remove existing toast
  board.querySelector('.play-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'play-toast';
  toast.textContent = message;
  board.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function hideBoardOverlay(): void {
  const overlay = document.getElementById('board-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

export function updatePlayMoveList(): void {
  if (!playing) return;
  const container = document.getElementById('play-settings');
  if (!container) return;
  const movesEl = container.querySelector('.play-moves');
  if (movesEl) {
    renderPlayMoves(movesEl as HTMLElement);
  }
}

function buildStatusHtml(phase: GamePhase, openingName?: string): string {
  const history = getMoveHistory();
  const moveNum = Math.floor(history.length / 2) + 1;
  const moveLabel = history.length > 0 ? `Move ${moveNum}` : '';

  let html = `<div class="opening-name">${openingName || 'Starting position'}</div>`;
  html += '<div class="status-row">';
  switch (phase) {
    case 'USER_TURN':
      html += '<span class="turn-indicator">Your turn</span>';
      break;
    case 'BOT_THINKING':
      html += '<span class="turn-indicator thinking">Thinking...</span>';
      break;
    case 'OUT_OF_BOOK':
      html += '<span class="turn-indicator out-of-book" data-tooltip="Position left the opening database">Out of book</span>';
      break;
    case 'GAME_OVER':
      html += '<span class="turn-indicator game-over">Game over</span>';
      break;
  }
  if (moveLabel) {
    html += `<span class="move-counter">${moveLabel}</span>`;
  }
  const { data: explorerData } = getExplorerData();
  if (explorerData) {
    const totalGames = explorerData.moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
    if (totalGames > 0) {
      const label = totalGames >= 1000 ? `${(totalGames / 1000).toFixed(1)}k` : String(totalGames);
      html += `<span class="move-counter" data-tooltip="Games in database at this position">${label} games</span>`;
    }
  }
  html += '</div>';

  // Repertoire depth
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
  html += `<div class="rep-depth" data-tooltip="Consecutive moves matching your repertoire"><span class="rep-depth-bar" style="width:${pct}%"></span><span class="rep-depth-label">${depthLabel}</span></div>`;

  return html;
}

function repClass(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const locked = getLockedMoves(fenBefore);
  if (locked.length === 0) return '';
  return locked.includes(history[moveIndex].uci) ? ' rep-hit' : ' rep-miss';
}

function renderPlayMoves(container: HTMLElement): void {
  const history = getMoveHistory();

  if (history.length === 0) {
    container.innerHTML = '<div class="move-list-empty">No moves yet</div>';
    return;
  }

  const vi = getViewIndex();

  let html = '<div class="move-table">';
  for (let i = 0; i < history.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const white = history[i];
    const black = history[i + 1];
    const whiteActive = (i + 1) === vi ? ' active' : '';
    const blackActive = black && (i + 2) === vi ? ' active' : '';
    const whiteRepClass = repClass(i, history);
    const blackRepClass = black ? repClass(i + 1, history) : '';
    html += `<div class="move-num">${moveNum}.</div>
      <div class="move-san clickable${whiteActive}${whiteRepClass}" data-vi="${i + 1}">${white.san}</div>
      <div class="move-san${black ? ` clickable${blackActive}${blackRepClass}` : ''}"${black ? ` data-vi="${i + 2}"` : ''}>${black ? black.san : ''}</div>`;
  }
  html += '</div>';

  container.innerHTML = html;

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Wire click handlers
  container.querySelectorAll('.move-san.clickable').forEach((td) => {
    td.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const idx = parseInt(target.dataset.vi!);
      navigateTo(idx);
    });
  });
}

export function renderPlayingView(phase: GamePhase, openingName?: string): void {
  strictMissInfo = null;
  hideBoardOverlay();
  const container = document.getElementById('play-settings');
  if (!container) return;
  container.innerHTML = '';

  // Status
  const status = el('div', 'play-status');
  status.innerHTML = buildStatusHtml(phase, openingName);
  container.append(status);

  // Move list
  const moves = el('div', 'play-moves');
  renderPlayMoves(moves);
  container.append(moves);

  // Sidebar actions — full width
  const actions = el('div', 'play-actions');

  const restartBtn = document.createElement('button');
  restartBtn.className = 'btn play-action-full';
  restartBtn.textContent = 'Play again';
  restartBtn.addEventListener('click', () => {
    onPlayRestart?.(lastOpeningName, lastSide);
  });

  const quitBtn = document.createElement('button');
  quitBtn.className = 'btn play-action-full';
  quitBtn.textContent = 'Back';
  quitBtn.addEventListener('click', () => {
    setPlayingState(false);
    onPlayQuit?.();
  });

  actions.append(restartBtn, quitBtn);
  container.append(actions);

  const secondaryActions = el('div', 'play-actions');

  const hintBtn = document.createElement('button');
  hintBtn.className = 'btn play-action-full';
  hintBtn.setAttribute('data-tooltip', 'Show hint (Space)');
  hintBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg> Hint';
  hintBtn.addEventListener('click', () => onHint?.());

  const exploreBtn = document.createElement('button');
  exploreBtn.className = 'btn play-action-full';
  exploreBtn.textContent = 'Open in explorer';
  exploreBtn.addEventListener('click', goToExplore);

  secondaryActions.append(hintBtn, exploreBtn);
  container.append(secondaryActions);

  setPlayingState(true);
}

// ── Setup form ──

function renderSetup(): void {
  const container = document.getElementById('play-setup');
  if (!container) return;
  container.innerHTML = '';

  const config = loadConfig();

  // Opening picker
  const openingSection = el('div', 'play-section');
  const openingLabel = el('div', 'play-label');
  openingLabel.textContent = 'Opening';
  openingSection.append(openingLabel);

  const pickerContainer = el('div', 'play-opening-picker');
  pickerContainer.id = 'play-opening-picker';
  openingSection.append(pickerContainer);
  container.append(openingSection);

  playPicker.render();

  // Side picker
  const sideSection = el('div', 'play-section');
  const sideLabel = el('div', 'play-label');
  sideLabel.textContent = 'Side';
  sideSection.append(sideLabel);

  // Default to white if coming from explore mode ('both')
  const activeSide: 'white' | 'black' = config.playerColor === 'black' ? 'black' : 'white';
  if (config.playerColor !== activeSide) {
    config.playerColor = activeSide;
    saveConfig(config);
    setOrientation(activeSide);
  }

  const sidePicker = el('div', 'segment-picker');
  const sides: { label: string; value: 'white' | 'black' }[] = [
    { label: 'White', value: 'white' },
    { label: 'Black', value: 'black' },
  ];
  for (const s of sides) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segment-btn';
    btn.textContent = s.label;
    if (activeSide === s.value) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      sidePicker.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      config.playerColor = s.value;
      saveConfig(config);
      setOrientation(s.value);
    });
    sidePicker.append(btn);
  }
  sideSection.append(sidePicker);
  container.append(sideSection);

  // Rating range bar
  const ratingSection = el('div', 'play-section');
  const ratingLabel = el('div', 'play-label');
  ratingLabel.textContent = 'Rating';
  ratingSection.append(ratingLabel);
  ratingSection.append(createRangeBar({
    options: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map(r => ({ value: r, label: String(r) })),
    initial: config.ratings,
    onChange: (ratings) => { config.ratings = ratings; saveConfig(config); },
  }));
  container.append(ratingSection);

  // Mode (strict/relaxed) — hidden for Free Play
  const modeGroup = el('div', 'play-section');
  modeGroup.id = 'play-mode-row';
  if (getActiveOpening() === FREE_PLAY_NAME) modeGroup.classList.add('hidden');
  const modeHeader = el('div', 'play-label-row');
  const modeLabel = el('div', 'play-label');
  modeLabel.textContent = 'Mode';
  const modeInfo = infoBtn('Drill: ends when you complete your repertoire. Strict: game over on wrong moves, free play after repertoire ends. Relaxed: any move allowed, deviations highlighted.');
  modeHeader.append(modeLabel, modeInfo);
  modeGroup.append(modeHeader);
  const modePicker = el('div', 'segment-picker segment-sm');
  const modes: { label: string; value: PlayMode }[] = [
    { label: 'Drill', value: 'drill' },
    { label: 'Strict', value: 'strict' },
    { label: 'Relaxed', value: 'relaxed' },
  ];
  const currentPlayMode = config.playMode;
  for (const m of modes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segment-btn';
    btn.textContent = m.label;
    if (currentPlayMode === m.value) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      modePicker.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      config.playMode = m.value;
      saveConfig(config);
    });
    modePicker.append(btn);
  }
  modeGroup.append(modePicker);
  container.append(modeGroup);

  // Play button
  const playBtn = document.createElement('button');
  playBtn.id = 'play-start-btn';
  playBtn.className = 'btn-primary btn play-btn';
  playBtn.textContent = 'Play';
  const names = getOpeningNames().filter(n => n !== FREE_PLAY_NAME);
  playBtn.disabled = names.length === 0;
  playBtn.addEventListener('click', () => {
    const opening = getActiveOpening();
    const side = config.playerColor === 'black' ? 'black' : 'white';
    lastOpeningName = opening;
    lastSide = side;
    onPlayStart?.(opening, side);
  });
  container.append(playBtn);

  // Continue from current position
  const history = getMoveHistory();
  if (history.length > 0) {
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'btn play-btn play-resume-btn';
    resumeBtn.textContent = 'Continue from here';
    resumeBtn.addEventListener('click', () => {
      const side = config.playerColor === 'black' ? 'black' : 'white';
      const opening = getActiveOpening();
      lastOpeningName = opening;
      lastSide = side;
      onResumeFromPosition?.(side);
    });
    container.append(resumeBtn);
  }

  // More settings (collapsible)
  const moreToggle = document.createElement('button');
  moreToggle.className = 'btn sm ghost play-more-toggle';
  moreToggle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z"/></svg> More settings';
  const morePanel = el('div', 'play-more-settings hidden');

  moreToggle.addEventListener('click', () => {
    morePanel.classList.toggle('hidden');
    moreToggle.classList.toggle('expanded');
  });

  // Move pool slider
  const topGroup = el('div', 'play-setting-row');
  const topHeader = el('div', 'play-label-row');
  const topLabel = el('div', 'play-label');
  topLabel.textContent = `Move pool: Top ${config.topMoves}`;
  const topInfo = infoBtn('How many of the most popular moves the bot can pick from at each position.');
  topHeader.append(topLabel, topInfo);
  topGroup.append(topHeader);
  const topSlider = document.createElement('input');
  topSlider.type = 'range';
  topSlider.className = 'play-slider';
  topSlider.min = '1';
  topSlider.max = '10';
  topSlider.value = String(config.topMoves);
  topSlider.addEventListener('input', () => {
    config.topMoves = parseInt(topSlider.value);
    topLabel.textContent = `Move pool: Top ${config.topMoves}`;
    saveConfig(config);
  });
  topGroup.append(topSlider);
  morePanel.append(topGroup);

  // Min play rate slider
  const playRateGroup = el('div', 'play-setting-row');
  const playRateHeader = el('div', 'play-label-row');
  const playRateLabel = el('div', 'play-label');
  playRateLabel.textContent = `Min play rate: ${config.botMinPlayRatePct}%`;
  const playRateInfo = infoBtn('Moves played less than this percentage in the database are excluded.');
  playRateHeader.append(playRateLabel, playRateInfo);
  playRateGroup.append(playRateHeader);
  const playRateSlider = document.createElement('input');
  playRateSlider.type = 'range';
  playRateSlider.className = 'play-slider';
  playRateSlider.min = '0';
  playRateSlider.max = '20';
  playRateSlider.value = String(config.botMinPlayRatePct);
  playRateSlider.addEventListener('input', () => {
    config.botMinPlayRatePct = parseInt(playRateSlider.value);
    playRateLabel.textContent = `Min play rate: ${config.botMinPlayRatePct}%`;
    saveConfig(config);
  });
  playRateGroup.append(playRateSlider);
  morePanel.append(playRateGroup);

  // Bot weighting
  const weightGroup = el('div', 'play-setting-row');
  const weightHeader = el('div', 'play-label-row');
  const weightLabel = el('div', 'play-label');
  weightLabel.textContent = 'Weighting';
  const weightInfo = infoBtn('Weighted: bot picks moves proportional to how often they\'re played. Equal: all moves in the pool are equally likely.');
  weightHeader.append(weightLabel, weightInfo);
  weightGroup.append(weightHeader);
  const weightPicker = el('div', 'segment-picker segment-sm');
  const weights: { label: string; value: BotWeighting }[] = [
    { label: 'Weighted', value: 'weighted' },
    { label: 'Equal', value: 'equal' },
  ];
  for (const w of weights) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segment-btn';
    btn.textContent = w.label;
    if (config.botWeighting === w.value) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      weightPicker.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      config.botWeighting = w.value;
      saveConfig(config);
    });
    weightPicker.append(btn);
  }
  weightGroup.append(weightPicker);
  morePanel.append(weightGroup);

  container.append(moreToggle);
  container.append(morePanel);
}
