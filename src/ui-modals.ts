import { renderSystemPicker, updateMoveList, switchSidebarTab, dispatchOpeningChange } from './ui';
import { updateExplorerPanel, formatGames } from './ui-explorer';
import { importPgn, fetchStudyPgn } from './pgn-import';
import {
  getPersonalConfig, importFromLichess, importFromChesscom,
  type LichessFilters, type Platform,
} from './personal-explorer';

// ── PGN Import Modal ──

let pgnModalInitialized = false;

export function initPgnModal(): void {
  if (pgnModalInitialized) return;
  pgnModalInitialized = true;

  document.getElementById('pgn-modal-close')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-modal-overlay')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-cancel-btn')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-import-btn')!.addEventListener('click', doPgnImport);
  document.getElementById('study-fetch-btn')!.addEventListener('click', doStudyFetch);
  document.getElementById('study-url-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doStudyFetch();
  });
}

export function openPgnModal(): void {
  initPgnModal();
  const overlay = document.getElementById('pgn-modal-overlay')!;
  const modal = document.getElementById('pgn-modal')!;
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const result = document.getElementById('pgn-result')!;

  textarea.value = '';
  (document.getElementById('study-url-input') as HTMLInputElement).value = '';
  result.textContent = '';
  result.className = 'pgn-result';

  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');

  requestAnimationFrame(() => textarea.focus());
}

function closePgnModal(): void {
  const overlay = document.getElementById('pgn-modal-overlay')!;
  const modal = document.getElementById('pgn-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}

async function doStudyFetch(): Promise<void> {
  const input = document.getElementById('study-url-input') as HTMLInputElement;
  const resultEl = document.getElementById('pgn-result')!;
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const btn = document.getElementById('study-fetch-btn') as HTMLButtonElement;
  const url = input.value.trim();

  if (!url) {
    resultEl.textContent = 'Please enter a Lichess study URL.';
    resultEl.className = 'pgn-result error';
    return;
  }

  btn.disabled = true;
  input.disabled = true;
  btn.textContent = 'Fetching…';
  resultEl.textContent = '';
  resultEl.className = 'pgn-result';

  try {
    const pgn = await fetchStudyPgn(url);
    textarea.value = pgn;
    resultEl.textContent = 'Study loaded — click Import to create a new opening.';
    resultEl.className = 'pgn-result success';
  } catch (e: unknown) {
    resultEl.textContent = e instanceof Error ? e.message : 'Failed to fetch study';
    resultEl.className = 'pgn-result error';
  } finally {
    btn.disabled = false;
    input.disabled = false;
    btn.textContent = 'Fetch';
  }
}

function doPgnImport(): void {
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const resultEl = document.getElementById('pgn-result')!;
  const pgn = textarea.value.trim();

  if (!pgn) {
    resultEl.textContent = 'Please paste a PGN first.';
    resultEl.className = 'pgn-result error';
    return;
  }

  const result = importPgn(pgn);

  if (result.moves === 0 && result.errors.length > 0) {
    resultEl.textContent = `Import failed: ${result.errors[0]}`;
    resultEl.className = 'pgn-result error';
    return;
  }

  const nameStr = result.openingNames.length === 1
    ? `"${result.openingNames[0]}"`
    : `${result.openingNames.length} openings`;
  let msg = `Created ${nameStr} with ${result.moves} move${result.moves !== 1 ? 's' : ''} across ${result.positions} position${result.positions !== 1 ? 's' : ''}.`;
  if (result.errors.length > 0) {
    msg += ` (${result.errors.length} error${result.errors.length !== 1 ? 's' : ''} skipped)`;
  }
  resultEl.textContent = msg;
  resultEl.className = 'pgn-result success';

  // Refresh UI
  renderSystemPicker();
  updateExplorerPanel();
  updateMoveList();
  dispatchOpeningChange();

  setTimeout(closePgnModal, 1500);
}

// ── Personal Games Import Modal ──

let personalModalInitialized = false;
let importAbortController: AbortController | null = null;
let selectedPlatform: Platform = 'lichess';

export function initPersonalImportModal(): void {
  if (personalModalInitialized) return;
  personalModalInitialized = true;

  document.getElementById('personal-import-close')!.addEventListener('click', closePersonalImportModal);
  document.getElementById('personal-import-overlay')!.addEventListener('click', closePersonalImportModal);

  // Platform toggle
  document.querySelectorAll('#personal-import-modal .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const platform = (btn as HTMLElement).dataset.platform as Platform;
      if (platform === selectedPlatform) return;
      selectedPlatform = platform;
      document.querySelectorAll('#personal-import-modal .segment-btn').forEach(b =>
        b.classList.toggle('selected', (b as HTMLElement).dataset.platform === platform)
      );
      updateImportFiltersVisibility();
    });
  });

  // Speed filter chip toggles
  document.querySelectorAll('#personal-filters .chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });

  // Import range segment picker + custom input
  const rangeMonthsInput = document.getElementById('personal-months-input') as HTMLInputElement;
  document.querySelectorAll('.import-range-picker .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.import-range-picker .segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      rangeMonthsInput.value = '';
    });
  });
  rangeMonthsInput.addEventListener('input', () => {
    if (rangeMonthsInput.value.trim()) {
      document.querySelectorAll('.import-range-picker .segment-btn').forEach(b => b.classList.remove('selected'));
    }
  });

  document.getElementById('personal-import-btn')!.addEventListener('click', doPersonalImport);
  document.getElementById('personal-import-cancel')!.addEventListener('click', () => {
    importAbortController?.abort();
  });

  document.getElementById('personal-username')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPersonalImport();
  });
}

function getSelectedMaxMonths(): number | undefined {
  const customVal = (document.getElementById('personal-months-input') as HTMLInputElement).value.trim();
  if (customVal) {
    const parsed = parseInt(customVal, 10);
    if (parsed > 0) return parsed;
  }
  const selected = document.querySelector('.import-range-picker .segment-btn.selected') as HTMLElement | null;
  const val = selected ? parseInt(selected.dataset.months ?? '0', 10) : 0;
  return val > 0 ? val : undefined;
}

function getSelectedSpeeds(): string[] {
  const chips = document.querySelectorAll('#personal-filters .chip.selected');
  return Array.from(chips).map(c => (c as HTMLElement).dataset.speed!);
}

function updateImportFiltersVisibility(): void {
  const filtersEl = document.getElementById('personal-filters')!;
  // Speed filters only for Lichess; range picker always visible
  filtersEl.classList.toggle('hidden', selectedPlatform !== 'lichess');
}

export function openPersonalImportModal(): void {
  initPersonalImportModal();
  const overlay = document.getElementById('personal-import-overlay')!;
  const modal = document.getElementById('personal-import-modal')!;
  const resultEl = document.getElementById('personal-import-result')!;
  const progressEl = document.getElementById('personal-import-progress')!;

  // Pre-fill from existing config
  const cfg = getPersonalConfig();
  if (cfg) {
    selectedPlatform = cfg.platform;
    (document.getElementById('personal-username') as HTMLInputElement).value = cfg.username;
    document.querySelectorAll('#personal-import-modal .segment-btn').forEach(b =>
      b.classList.toggle('selected', (b as HTMLElement).dataset.platform === cfg.platform)
    );
  }

  resultEl.textContent = '';
  resultEl.className = 'pgn-result';
  progressEl.classList.add('hidden');
  updateImportFiltersVisibility();

  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');

  requestAnimationFrame(() => {
    (document.getElementById('personal-username') as HTMLInputElement).focus();
  });
}

function closePersonalImportModal(): void {
  importAbortController?.abort();
  const overlay = document.getElementById('personal-import-overlay')!;
  const modal = document.getElementById('personal-import-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}

async function doPersonalImport(): Promise<void> {
  const usernameInput = document.getElementById('personal-username') as HTMLInputElement;
  const resultEl = document.getElementById('personal-import-result')!;
  const progressEl = document.getElementById('personal-import-progress')!;
  const progressText = progressEl.querySelector('.personal-progress-text')!;
  const progressFill = progressEl.querySelector('.personal-progress-fill')! as HTMLElement;
  const importBtn = document.getElementById('personal-import-btn') as HTMLButtonElement;

  const username = usernameInput.value.trim();
  if (!username) {
    resultEl.textContent = 'Please enter a username.';
    resultEl.className = 'pgn-result error';
    return;
  }

  importBtn.disabled = true;
  resultEl.textContent = '';
  resultEl.className = 'pgn-result';
  progressEl.classList.remove('hidden');
  progressFill.classList.add('indeterminate');

  importAbortController = new AbortController();

  const onProgress = (msg: string, count: number) => {
    progressText.textContent = `${msg} (${formatGames(count)} games)`;
  };

  try {
    let total: number;
    const maxMonths = getSelectedMaxMonths();
    if (selectedPlatform === 'lichess') {
      const speeds = getSelectedSpeeds();
      const filters: LichessFilters = {};
      if (speeds.length > 0 && speeds.length < 4) {
        filters.perfType = speeds;
      }
      if (maxMonths) {
        const since = new Date();
        since.setMonth(since.getMonth() - maxMonths);
        filters.since = since.getTime();
      }
      total = await importFromLichess(username, onProgress, importAbortController.signal, filters);
    } else {
      total = await importFromChesscom(username, onProgress, importAbortController.signal, maxMonths);
    }

    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '100%';
    resultEl.textContent = `Imported ${formatGames(total)} games from ${selectedPlatform === 'lichess' ? 'Lichess' : 'Chess.com'}.`;
    resultEl.className = 'pgn-result success';

    switchSidebarTab('personal');
    updateExplorerPanel();
    setTimeout(closePersonalImportModal, 1500);
  } catch (e: unknown) {
    progressFill.classList.remove('indeterminate');
    const msg = e instanceof Error ? e.message : 'Import failed';
    if (msg !== 'Import cancelled') {
      resultEl.textContent = msg;
      resultEl.className = 'pgn-result error';
    } else {
      resultEl.textContent = 'Import cancelled.';
      resultEl.className = 'pgn-result';
    }
  } finally {
    importBtn.disabled = false;
    importAbortController = null;
  }
}

// ── Help Modal ──

export function initHelpModal(): void {
  document.getElementById('help-close')!.addEventListener('click', closeHelpModal);
  document.getElementById('help-overlay')!.addEventListener('click', closeHelpModal);
}

export function openHelpModal(): void {
  const overlay = document.getElementById('help-overlay')!;
  const modal = document.getElementById('help-modal')!;
  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');
}

export function closeHelpModal(): void {
  const overlay = document.getElementById('help-overlay')!;
  const modal = document.getElementById('help-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}
