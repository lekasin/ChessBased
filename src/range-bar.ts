interface RangeBarOption<T> {
  value: T;
  label: string;
}

interface RangeBarConfig<T> {
  options: RangeBarOption<T>[];
  initial: T[];
  onChange: (selected: T[]) => void;
}

export function createRangeBar<T>({ options, initial, onChange }: RangeBarConfig<T>): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'rating-range-bar';

  const values = options.map(o => o.value);
  let selectedIndices = new Set(initial.map(v => values.indexOf(v)).filter(i => i >= 0));

  let clickAnchor: number | null = null; // index
  let dragAnchor: number | null = null;
  let didDrag = false;
  let dragging = false;

  function setRangeByIndex(loIdx: number, hiIdx: number) {
    selectedIndices = new Set<number>();
    for (let i = loIdx; i <= hiIdx; i++) selectedIndices.add(i);
    onChange(Array.from(selectedIndices).sort((a, b) => a - b).map(i => values[i]));
    updateUI();
  }

  function updateUI() {
    const indices = Array.from(selectedIndices).sort((a, b) => a - b);
    const lo = indices[0] ?? -1;
    const hi = indices[indices.length - 1] ?? -1;
    bar.querySelectorAll('.rating-seg').forEach(seg => {
      const idx = Number((seg as HTMLElement).dataset.idx);
      const inRange = idx >= lo && idx <= hi;
      seg.classList.toggle('in-range', inRange);
      seg.classList.toggle('range-start', idx === lo);
      seg.classList.toggle('range-end', idx === hi);
    });
  }

  for (let i = 0; i < options.length; i++) {
    const seg = document.createElement('button');
    seg.className = 'rating-seg';
    seg.dataset.idx = String(i);
    seg.textContent = options[i].label;

    seg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      didDrag = false;
      dragAnchor = i;
      bar.setPointerCapture(e.pointerId);

      if (clickAnchor === null) {
        clickAnchor = i;
        setRangeByIndex(i, i);
      } else {
        setRangeByIndex(Math.min(clickAnchor, i), Math.max(clickAnchor, i));
      }
    });

    bar.append(seg);
  }

  bar.addEventListener('pointermove', (e) => {
    if (!dragging || dragAnchor === null) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (target && (target as HTMLElement).dataset.idx != null) {
      const idx = Number((target as HTMLElement).dataset.idx);
      if (idx !== dragAnchor) didDrag = true;
      if (didDrag) {
        setRangeByIndex(Math.min(dragAnchor, idx), Math.max(dragAnchor, idx));
      }
    }
  });

  bar.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (didDrag) {
      clickAnchor = null;
    } else if (clickAnchor !== null && clickAnchor !== dragAnchor) {
      clickAnchor = null;
    }
    dragAnchor = null;
  });

  bar.addEventListener('pointercancel', () => {
    dragging = false;
    dragAnchor = null;
    clickAnchor = null;
  });

  updateUI();
  return bar;
}
