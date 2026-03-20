export type AppMode = 'play' | 'explore' | 'report';

type ModeChangeListener = (mode: AppMode) => void;

let currentMode: AppMode = 'play';
const listeners: ModeChangeListener[] = [];

export function getCurrentMode(): AppMode {
  return currentMode;
}

export function applyModeClass(mode: AppMode): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('mode-play', 'mode-explore', 'mode-report');
  app.classList.add(`mode-${mode}`);
}

export function switchMode(mode: AppMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  const hashMap: Record<AppMode, string> = { play: '', explore: '#explore', report: '#report' };
  history.pushState(null, '', hashMap[mode] || window.location.pathname);
  for (const cb of listeners) cb(mode);
}

export function onModeChange(cb: ModeChangeListener): void {
  listeners.push(cb);
}

function modeFromHash(): AppMode {
  const h = window.location.hash;
  if (h === '#report') return 'report';
  if (h === '#explore') return 'explore';
  return 'play';
}

export function initModeRouting(): void {
  currentMode = modeFromHash();

  applyModeClass(currentMode);

  window.addEventListener('popstate', () => {
    const mode = modeFromHash();
    if (mode === currentMode) return;
    currentMode = mode;
    for (const cb of listeners) cb(mode);
  });
}
