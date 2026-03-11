export type AppMode = 'trainer' | 'report';

type ModeChangeListener = (mode: AppMode) => void;

let currentMode: AppMode = 'trainer';
const listeners: ModeChangeListener[] = [];

export function getCurrentMode(): AppMode {
  return currentMode;
}

export function applyModeClass(mode: AppMode): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('mode-trainer', 'mode-report');
  app.classList.add(`mode-${mode}`);
}

export function switchMode(mode: AppMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  const hash = mode === 'report' ? '#report' : '';
  history.pushState(null, '', hash || window.location.pathname);
  // Don't apply mode class here — listeners orchestrate the animated sequence
  for (const cb of listeners) cb(mode);
}

export function onModeChange(cb: ModeChangeListener): void {
  listeners.push(cb);
}

function modeFromHash(): AppMode {
  return window.location.hash === '#report' ? 'report' : 'trainer';
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
