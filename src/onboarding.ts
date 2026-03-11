import { pushKeyLayer, popKeyLayer } from './keyboard';

const STORAGE_KEY = 'chessbased-onboarding-complete';

const LOCK_OPEN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>';
const LOCK_CLOSED_SVG = '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>';

export function hasCompletedOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

interface Step {
  title: string;
  body: string;
  visual: () => HTMLElement;
}

const steps: Step[] = [
  {
    title: 'Master Your Openings',
    body: 'Practice your repertoire against a bot that plays what real opponents actually play — every response drawn from millions of real games.',
    visual: buildWelcomeVisual,
  },
  {
    title: 'You Move, They Respond',
    body: 'Make your move and the bot answers with what real players actually play at your rating — weighted by popularity from millions of games.',
    visual: buildBoardVisual,
  },
  {
    title: 'See What Works',
    body: 'The explorer shows the most popular moves at your level with real win rates. Find the lines that give you the best chances.',
    visual: buildExplorerVisual,
  },
  {
    title: 'Build Your Playbook',
    body: 'Lock the moves you want to master. Build named openings, browse 1,500+ common lines from the library, or import a PGN — the bot plays into your repertoire every game.',
    visual: buildRepertoireVisual,
  },
  {
    title: 'Play Against Your History',
    body: 'Connect your Lichess or Chess.com account to practice against moves you\'ve actually faced. Get a games report that identifies your weakest openings so you know exactly what to work on.',
    visual: buildGamesVisual,
  },
];

function knightSvg(): string {
  return `<svg viewBox="0 0 45 45" class="onboarding-knight" xmlns="http://www.w3.org/2000/svg">
    <g fill="none" fill-rule="evenodd" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" fill="currentColor" opacity="0.15"/>
      <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" fill="currentColor" opacity="0.15"/>
      <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"/>
      <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"/>
      <circle cx="12" cy="17" r="1.5" fill="currentColor" opacity="0.6"/>
    </g>
  </svg>`;
}

function explorerRowHtml(san: string, pct: number, games: string, wPct: number, dPct: number, bPct: number, extra = ''): string {
  return `<div class="explorer-move${extra}" style="pointer-events:none">
    <span class="explorer-san">${san}</span>
    <span class="explorer-badge-col"></span>
    <span class="explorer-pct"><span class="pct-fill" style="width:${pct}%"></span><span class="pct-label">${pct}%</span></span>
    <span class="explorer-games">${games}</span>
    <span class="explorer-bar">
      <span class="bar-white onboarding-bar-anim" style="--target-width:${wPct}%">${wPct}%</span>
      <span class="bar-draw-neutral onboarding-bar-anim" style="--target-width:${dPct}%">${dPct}%</span>
      <span class="bar-black onboarding-bar-anim" style="--target-width:${bPct}%">${bPct}%</span>
    </span>
    <span></span>
  </div>`;
}

function buildBoardVisual(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'onboarding-visual onboarding-visual-board';

  // 4 cols (c-f) × 4 rows (ranks 5 down to 2)
  // White e2→e4 (2 up), black starts on c5 (top) and moves 1 down
  let squaresHtml = '';
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const file = col + 3; // c=3, d=4, e=5, f=6
      const rank = 5 - row;  // top row = rank 5
      const isLight = (file + rank) % 2 === 0;
      squaresHtml += `<div class="ob-sq${isLight ? ' ob-light' : ' ob-dark'}"></div>`;
    }
  }

  el.innerHTML = `
    <div class="ob-board">
      ${squaresHtml}
      <div class="ob-piece ob-white-pawn"></div>
      <div class="ob-piece ob-black-pawn"></div>
    </div>
  `;

  return el;
}

function buildWelcomeVisual(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'onboarding-visual onboarding-visual-welcome';
  el.innerHTML = `
    <div class="onboarding-knight-glow"></div>
    ${knightSvg()}
  `;
  return el;
}

function buildExplorerVisual(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'onboarding-visual onboarding-visual-explorer';

  el.innerHTML = `
    <div class="explorer-list onboarding-explorer-list">
      ${explorerRowHtml('e4', 45, '2.1M', 38, 28, 34)}
      ${explorerRowHtml('d4', 35, '1.6M', 36, 32, 32)}
      ${explorerRowHtml('Nf3', 12, '548K', 34, 34, 32)}
    </div>
  `;

  return el;
}

function buildRepertoireVisual(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'onboarding-visual onboarding-visual-repertoire';

  container.innerHTML = `
    <div class="explorer-list onboarding-explorer-list">
      <div class="explorer-move" style="pointer-events:none">
        <span class="explorer-san">e4</span>
        <span class="explorer-badge-col"></span>
        <span class="explorer-pct"><span class="pct-fill" style="width:45%"></span><span class="pct-label">45%</span></span>
        <span class="explorer-games">2.1M</span>
        <span class="explorer-bar">
          <span class="bar-white" style="width:38%">38%</span>
          <span class="bar-draw-neutral" style="width:28%">28%</span>
          <span class="bar-black" style="width:34%">34%</span>
        </span>
        <button class="lock-btn" style="pointer-events:none">${LOCK_OPEN_SVG}</button>
      </div>
      <div class="explorer-move onboarding-lock-target" style="pointer-events:none">
        <span class="explorer-san">d4</span>
        <span class="explorer-badge-col"></span>
        <span class="explorer-pct"><span class="pct-fill" style="width:35%"></span><span class="pct-label">35%</span></span>
        <span class="explorer-games">1.6M</span>
        <span class="explorer-bar">
          <span class="bar-white" style="width:36%">36%</span>
          <span class="bar-draw-neutral" style="width:32%">32%</span>
          <span class="bar-black" style="width:32%">32%</span>
        </span>
        <button class="lock-btn onboarding-lock-btn" style="pointer-events:none">
          <span class="onboarding-lock-open">${LOCK_OPEN_SVG}</span>
          <span class="onboarding-lock-closed">${LOCK_CLOSED_SVG}</span>
        </button>
      </div>
    </div>
  `;

  setTimeout(() => {
    const row = container.querySelector('.onboarding-lock-target');
    const btn = container.querySelector('.onboarding-lock-btn');
    if (row && btn) {
      row.classList.add('locked');
      btn.classList.add('locked');
    }
  }, 800);

  return container;
}

function buildGamesVisual(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'onboarding-visual onboarding-visual-games';

  el.innerHTML = `
    <div class="onboarding-games-section">
      <div class="report-section-title">Priority Weaknesses</div>
      <div class="report-weakness-list">
        <div class="report-weakness-card severity-high side-black" style="pointer-events:none">
          <div class="report-weakness-top">
            <div class="report-line-title-row">
              <div class="report-weakness-label">Sicilian Defense</div>
              <span class="report-line-games-badge">84 games</span>
            </div>
            <div class="report-weakness-subline">1. e4 c5</div>
            <div class="report-weakness-stats">
              <span class="stat bad">Win 38%</span>
              <span class="stat bad">~Elo Δ-47</span>
              <span class="stat bad">Priority 4.2</span>
            </div>
          </div>
        </div>
        <div class="report-weakness-card severity-mid side-white" style="pointer-events:none">
          <div class="report-weakness-top">
            <div class="report-line-title-row">
              <div class="report-weakness-label">King's Indian</div>
              <span class="report-line-games-badge">47 games</span>
            </div>
            <div class="report-weakness-subline">1. d4 Nf6 2. c4 g6</div>
            <div class="report-weakness-stats">
              <span class="stat warn">Win 44%</span>
              <span class="stat bad">~Elo Δ-23</span>
              <span class="stat warn">Priority 1.8</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  return el;
}

export function showOnboarding(): void {
  let currentStep = 0;

  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.className = 'onboarding-overlay';

  const container = document.createElement('div');
  container.className = 'onboarding-container';

  const content = document.createElement('div');
  content.className = 'onboarding-content';

  const footer = document.createElement('div');
  footer.className = 'onboarding-footer';

  const skipBtn = document.createElement('button');
  skipBtn.className = 'onboarding-skip';
  skipBtn.textContent = 'Skip';

  const dots = document.createElement('div');
  dots.className = 'onboarding-dots';
  for (let i = 0; i < steps.length; i++) {
    const dot = document.createElement('div');
    dot.className = 'onboarding-dot' + (i === 0 ? ' active' : '');
    dot.addEventListener('click', () => goTo(i));
    dots.append(dot);
  }

  const nextBtn = document.createElement('button');
  nextBtn.className = 'onboarding-next';
  nextBtn.innerHTML = '<span class="onboarding-next-label">Next</span><span class="onboarding-next-label final-label">Get Started</span>';

  footer.append(skipBtn, dots, nextBtn);
  container.append(content, footer);
  overlay.append(container);

  function renderStep(index: number) {
    const step = steps[index];
    content.innerHTML = '';

    const visual = step.visual();
    const textBlock = document.createElement('div');
    textBlock.className = 'onboarding-text';

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.textContent = step.title;

    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = step.body;

    textBlock.append(title, body);
    content.append(visual, textBlock);

    dots.querySelectorAll('.onboarding-dot').forEach((d, i) => {
      d.classList.toggle('active', i === index);
    });

    nextBtn.classList.toggle('final', index === steps.length - 1);
  }

  function goTo(target: number) {
    if (target === currentStep) return;
    const forward = target > currentStep;

    content.classList.add(forward ? 'onboarding-slide-out' : 'onboarding-slide-out-right');
    setTimeout(() => {
      currentStep = target;
      renderStep(currentStep);
      content.classList.remove('onboarding-slide-out', 'onboarding-slide-out-right');
      const enterCls = forward ? 'onboarding-slide-in' : 'onboarding-slide-in-left';
      content.classList.add(enterCls);
      setTimeout(() => content.classList.remove(enterCls), 400);
    }, 300);
  }

  function goNext() {
    if (currentStep >= steps.length - 1) {
      dismiss();
      return;
    }
    goTo(currentStep + 1);
  }

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    overlay.classList.add('onboarding-fade-out');
    popKeyLayer('onboarding');
    setTimeout(() => overlay.remove(), 400);
  }

  skipBtn.addEventListener('click', dismiss);
  nextBtn.addEventListener('click', goNext);
  pushKeyLayer('onboarding', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      goNext();
      return true;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (currentStep > 0) goTo(currentStep - 1);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
      return true;
    }
    return false;
  });

  renderStep(0);
  document.body.append(overlay);
}
