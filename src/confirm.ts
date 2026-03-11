import { pushKeyLayer, popKeyLayer } from './keyboard';

export interface ConfirmButton {
  label: string;
  value: string;
  style?: 'primary' | 'danger';
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  buttons: ConfirmButton[];
  cancelLabel?: string;
  danger?: boolean;
  anchor?: HTMLElement | DOMRect;
  layout?: 'horizontal' | 'vertical';
}

export function confirmModal(options: ConfirmOptions): Promise<string | null> {
  return new Promise((resolve) => {
    // Remove any existing confirm overlay
    document.getElementById('confirm-overlay')?.remove();

    const anchored = !!options.anchor;

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay' + (anchored ? ' anchored' : '');
    overlay.id = 'confirm-overlay';

    const modal = document.createElement('div');
    modal.className = 'confirm-modal';

    const title = document.createElement('div');
    title.className = 'confirm-title' + (options.danger ? ' danger' : '');
    title.textContent = options.title;
    modal.append(title);

    if (options.message) {
      const msg = document.createElement('div');
      msg.className = 'confirm-message';
      msg.textContent = options.message;
      modal.append(msg);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions' + (options.layout === 'vertical' ? ' vertical' : '');

    const isVertical = options.layout === 'vertical';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn' + (isVertical ? ' btn-cancel-vertical' : '');
    cancelBtn.textContent = options.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => cleanup(null));

    if (!isVertical) {
      actions.append(cancelBtn);
    }

    for (const btn of options.buttons) {
      const el = document.createElement('button');
      const styleClass = btn.style === 'danger' ? ' btn-danger' : btn.style === 'primary' ? ' btn-primary' : '';
      el.className = 'btn' + styleClass;
      el.textContent = btn.label;
      el.addEventListener('click', () => cleanup(btn.value));
      actions.append(el);
    }

    if (isVertical) {
      actions.append(cancelBtn);
    }

    modal.append(actions);
    overlay.append(modal);

    if (anchored) {
      const rect = options.anchor instanceof DOMRect
        ? options.anchor
        : options.anchor!.getBoundingClientRect();
      positionAnchored(modal, rect);
    }

    function cleanup(value: string | null) {
      popKeyLayer('confirm');
      overlay.remove();
      resolve(value);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    pushKeyLayer('confirm', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
        return true;
      }
      return false;
    });
    document.body.append(overlay);
  });
}

function positionAnchored(modal: HTMLElement, rect: DOMRect) {
  const gap = 6;

  modal.style.position = 'fixed';
  modal.style.right = (window.innerWidth - rect.right) + 'px';

  // Initially place below anchor
  modal.style.top = (rect.bottom + gap) + 'px';

  // After layout, check if it overflows the viewport bottom
  requestAnimationFrame(() => {
    const modalRect = modal.getBoundingClientRect();
    if (modalRect.bottom > window.innerHeight - 8) {
      // Flip above anchor
      modal.style.top = '';
      modal.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
    }
  });
}
