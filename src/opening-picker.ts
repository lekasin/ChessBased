import {
  getOpeningNames, getActiveOpening, switchOpening, createOpening,
  deleteOpening, renameOpening, mergeMultiple,
  FREE_PLAY_NAME, FULL_REPERTOIRE_NAME,
} from './repertoire';
import { confirmModal, type ConfirmButton } from './confirm';

const SVG_GLOBE = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const SVG_LAYERS = '<svg viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>';
const SVG_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const SVG_EDIT = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const SVG_MERGE = '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

type IconType = 'free-play' | 'full-rep' | 'custom';

function makeCardIcon(type: IconType): HTMLElement {
  const icon = document.createElement('div');
  icon.className = `system-card-icon ${type}`;
  const svgMap = { 'free-play': SVG_GLOBE, 'full-rep': SVG_LAYERS, 'custom': SVG_BOOK };
  const tooltipMap = { 'free-play': 'Free Play', 'full-rep': 'Full Repertoire', 'custom': 'Custom opening' };
  icon.innerHTML = svgMap[type];
  icon.setAttribute('data-tooltip', tooltipMap[type]);
  icon.classList.add('tooltip-below');
  icon.querySelector('svg')!.setAttribute('width', '16');
  icon.querySelector('svg')!.setAttribute('height', '16');
  icon.querySelector('svg')!.style.fill = 'currentColor';
  return icon;
}

export interface OpeningPickerConfig {
  mode: 'explore' | 'play';
  getContainer: () => HTMLElement | null;
  onChange: () => void;
  onAddNew?: () => void;
}

export function createOpeningPicker(config: OpeningPickerConfig) {
  let dropdownOpen = false;
  let pickerMode: 'normal' | 'rename' | 'merge-select' = 'normal';
  let mergeSelected = new Set<string>();
  let outsideClickCleanup: (() => void) | null = null;

  function render(): void {
    const container = config.getContainer();
    if (!container) return;
    container.innerHTML = '';

    outsideClickCleanup?.();
    outsideClickCleanup = null;

    if (pickerMode !== 'merge-select' && pickerMode !== 'rename') {
      pickerMode = 'normal';
    }

    const active = getActiveOpening();
    const names = getOpeningNames();
    const customRepertoires = names.filter(n => n !== FREE_PLAY_NAME);
    const isFreePlayActive = active === FREE_PLAY_NAME;
    const isFullRepActive = active === FULL_REPERTOIRE_NAME;
    const isCustomActive = !isFreePlayActive && !isFullRepActive;

    const wrapper = document.createElement('div');
    wrapper.className = 'system-dropdown-anchor';

    const card = document.createElement('div');
    card.className = 'system-card active';

    const activeIconType: IconType = isFreePlayActive ? 'free-play' : isFullRepActive ? 'full-rep' : 'custom';
    card.append(makeCardIcon(activeIconType));

    // Rename input (explore mode only)
    const isRenaming = config.mode === 'explore' && pickerMode === 'rename' && isCustomActive;

    if (isRenaming) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'system-card-rename-input';
      input.value = active;
      input.placeholder = 'Opening name...';

      function saveRename(): void {
        const newName = input.value.trim();
        if (newName && newName !== active) {
          renameOpening(active, newName);
          config.onChange();
        }
        pickerMode = 'normal';
        render();
      }

      function cancelRename(): void {
        pickerMode = 'normal';
        render();
      }

      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') saveRename();
        if (e.key === 'Escape') cancelRename();
      });
      input.addEventListener('blur', saveRename);

      card.append(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const nameEl = document.createElement('div');
      nameEl.className = 'system-card-name';
      nameEl.textContent = active;
      card.append(nameEl);
    }

    // Card actions (explore mode, custom openings only)
    if (config.mode === 'explore' && isCustomActive) {
      const actions = document.createElement('div');
      actions.className = 'system-card-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'system-card-action-btn';
      renameBtn.setAttribute('data-tooltip', 'Rename');
      renameBtn.innerHTML = SVG_EDIT;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownOpen = false;
        pickerMode = 'rename';
        render();
      });

      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'system-card-action-btn';
      mergeBtn.setAttribute('data-tooltip', 'Merge openings');
      mergeBtn.innerHTML = SVG_MERGE;
      if (customRepertoires.length < 2) mergeBtn.style.display = 'none';
      mergeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        mergeSelected = new Set([active]);
        pickerMode = 'merge-select';
        dropdownOpen = true;
        render();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'system-card-action-btn danger';
      deleteBtn.setAttribute('data-tooltip', 'Delete opening');
      deleteBtn.innerHTML = SVG_TRASH;
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const anchorRect = deleteBtn.getBoundingClientRect();
        dropdownOpen = false;
        render();
        const result = await confirmModal({
          title: `Delete "${active}"?`,
          message: 'This will permanently remove this opening and all its locked moves.',
          buttons: [{ label: 'Delete', value: 'delete', style: 'danger' }],
          danger: true,
          anchor: anchorRect,
        });
        if (result === 'delete') {
          deleteOpening(active);
          pickerMode = 'normal';
          config.onChange();
          render();
        }
      });

      actions.append(renameBtn, mergeBtn, deleteBtn);
      card.append(actions);
    }

    // Chevron
    const chevron = document.createElement('div');
    chevron.className = `system-dropdown-chevron${dropdownOpen ? ' open' : ''}`;
    chevron.innerHTML = SVG_CHEVRON;
    card.append(chevron);

    card.addEventListener('click', () => {
      dropdownOpen = !dropdownOpen;
      if (pickerMode === 'merge-select') pickerMode = 'normal';
      render();
    });

    wrapper.append(card);

    // Dropdown list
    if (dropdownOpen) {
      requestAnimationFrame(() => {
        const onClickOutside = (e: MouseEvent) => {
          if (!wrapper.contains(e.target as Node)) {
            dropdownOpen = false;
            if (pickerMode === 'merge-select') pickerMode = 'normal';
            cleanup();
            render();
          }
        };
        function cleanup() {
          document.removeEventListener('click', onClickOutside, true);
          outsideClickCleanup = null;
        }
        document.addEventListener('click', onClickOutside, true);
        outsideClickCleanup = cleanup;
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'system-dropdown';

      if (config.mode === 'explore' && pickerMode === 'merge-select') {
        renderMergeSelect(dropdown, customRepertoires);
      } else {
        renderNormalDropdown(dropdown, active, customRepertoires, isFreePlayActive, isFullRepActive, isCustomActive);
      }

      wrapper.append(dropdown);
    }

    container.append(wrapper);
  }

  function renderMergeSelect(dropdown: HTMLElement, customRepertoires: string[]): void {
    const header = document.createElement('div');
    header.className = 'system-dropdown-header';
    header.textContent = 'Select openings to merge';
    dropdown.append(header);

    for (const name of customRepertoires) {
      const checked = mergeSelected.has(name);
      const item = document.createElement('div');
      item.className = 'system-dropdown-item';

      const check = document.createElement('div');
      check.className = 'system-card-check';
      if (checked) check.classList.add('checked');
      check.innerHTML = SVG_CHECK;
      check.querySelector('svg')!.setAttribute('width', '10');
      check.querySelector('svg')!.setAttribute('height', '10');
      check.querySelector('svg')!.style.fill = '#fff';
      check.querySelector('svg')!.style.opacity = checked ? '1' : '0';
      item.append(check);

      const itemName = document.createElement('div');
      itemName.className = 'system-card-name';
      itemName.textContent = name;
      item.append(itemName);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mergeSelected.has(name)) mergeSelected.delete(name);
        else mergeSelected.add(name);
        const isNowChecked = mergeSelected.has(name);
        check.classList.toggle('checked', isNowChecked);
        check.querySelector('svg')!.style.opacity = isNowChecked ? '1' : '0';
        updateMergeAction();
      });
      dropdown.append(item);
    }

    const mergeAction = document.createElement('div');
    mergeAction.className = 'system-dropdown-item system-dropdown-add';
    mergeAction.innerHTML = `${SVG_MERGE} <span class="system-card-name">Merge ${mergeSelected.size} openings</span>`;
    mergeAction.querySelector('svg')!.setAttribute('width', '14');
    mergeAction.querySelector('svg')!.setAttribute('height', '14');
    mergeAction.querySelector('svg')!.style.fill = 'currentColor';

    function updateMergeAction() {
      const count = mergeSelected.size;
      mergeAction.querySelector('.system-card-name')!.textContent = `Merge ${count} openings`;
      mergeAction.style.opacity = count < 2 ? '0.4' : '';
      mergeAction.style.pointerEvents = count < 2 ? 'none' : '';
    }
    updateMergeAction();

    mergeAction.addEventListener('click', async () => {
      const selectedNames = [...mergeSelected];
      dropdownOpen = false;
      pickerMode = 'normal';
      render();

      const buttons: ConfirmButton[] = selectedNames.map(n => ({ label: n, value: n }));
      buttons.push({ label: 'New opening', value: '__new__', style: 'primary' });

      const result = await confirmModal({
        title: 'Merge into\u2026',
        message: 'Choose which name to keep. All locked moves will be combined and the rest deleted.',
        buttons,
        layout: 'vertical',
      });
      if (result) {
        mergeMultiple(selectedNames, result === '__new__' ? null : result);
        config.onChange();
        render();
      }
    });
    dropdown.append(mergeAction);

    const cancelItem = document.createElement('div');
    cancelItem.className = 'system-dropdown-item system-dropdown-cancel';
    cancelItem.innerHTML = `${SVG_CLOSE} <span class="system-card-name">Cancel</span>`;
    cancelItem.querySelector('svg')!.setAttribute('width', '14');
    cancelItem.querySelector('svg')!.setAttribute('height', '14');
    cancelItem.querySelector('svg')!.style.fill = 'currentColor';
    cancelItem.addEventListener('click', () => {
      dropdownOpen = false;
      pickerMode = 'normal';
      render();
    });
    dropdown.append(cancelItem);
  }

  function renderNormalDropdown(
    dropdown: HTMLElement,
    active: string,
    customRepertoires: string[],
    isFreePlayActive: boolean,
    isFullRepActive: boolean,
    isCustomActive: boolean,
  ): void {
    // "New opening" item
    const addItem = document.createElement('div');
    addItem.className = 'system-dropdown-item system-dropdown-add';
    addItem.innerHTML = `${SVG_PLUS} <span class="system-card-name">New opening</span>`;
    addItem.querySelector('svg')!.setAttribute('width', '16');
    addItem.querySelector('svg')!.setAttribute('height', '16');
    addItem.querySelector('svg')!.style.fill = 'currentColor';

    if (config.mode === 'explore') {
      addItem.addEventListener('click', () => {
        dropdownOpen = false;
        createOpening();
        config.onChange();
        pickerMode = 'rename';
        render();
      });
    } else {
      addItem.addEventListener('click', () => {
        dropdownOpen = false;
        render();
        config.onAddNew?.();
      });
    }
    dropdown.append(addItem);

    const divider1 = document.createElement('div');
    divider1.className = 'system-dropdown-divider';
    dropdown.append(divider1);

    // Free Play
    if (!isFreePlayActive) {
      const fpItem = document.createElement('div');
      fpItem.className = 'system-dropdown-item';
      fpItem.append(makeCardIcon('free-play'));
      const fpName = document.createElement('div');
      fpName.className = 'system-card-name';
      fpName.textContent = FREE_PLAY_NAME;
      fpItem.append(fpName);
      fpItem.addEventListener('click', () => {
        dropdownOpen = false;
        switchOpening(FREE_PLAY_NAME);
        config.onChange();
        render();
      });
      dropdown.append(fpItem);
    }

    // Full Repertoire (when 2+ custom openings)
    if (customRepertoires.length > 1 && !isFullRepActive) {
      const frItem = document.createElement('div');
      frItem.className = 'system-dropdown-item';
      frItem.append(makeCardIcon('full-rep'));
      const frName = document.createElement('div');
      frName.className = 'system-card-name';
      frName.textContent = FULL_REPERTOIRE_NAME;
      frItem.append(frName);
      frItem.addEventListener('click', () => {
        dropdownOpen = false;
        switchOpening(FULL_REPERTOIRE_NAME);
        config.onChange();
        render();
      });
      dropdown.append(frItem);
    }

    // Divider before custom openings
    if (customRepertoires.length > 0) {
      const divider2 = document.createElement('div');
      divider2.className = 'system-dropdown-divider';
      dropdown.append(divider2);
    }

    // Custom openings
    for (const name of customRepertoires) {
      if (name === active && (config.mode === 'explore' ? isCustomActive : true)) continue;
      const item = document.createElement('div');
      item.className = 'system-dropdown-item';
      item.append(makeCardIcon('custom'));

      const itemName = document.createElement('div');
      itemName.className = 'system-card-name';
      itemName.textContent = name;
      item.append(itemName);

      item.addEventListener('click', () => {
        dropdownOpen = false;
        switchOpening(name);
        config.onChange();
        render();
      });
      dropdown.append(item);
    }
  }

  function close(): void {
    if (dropdownOpen) {
      dropdownOpen = false;
      if (pickerMode === 'merge-select') pickerMode = 'normal';
      outsideClickCleanup?.();
      outsideClickCleanup = null;
      render();
    }
  }

  return { render, close };
}
