export type KeyHandler = (e: KeyboardEvent) => boolean | void;

const layers: { id: string; handler: KeyHandler }[] = [];

export function pushKeyLayer(id: string, handler: KeyHandler): void {
  layers.push({ id, handler });
}

export function popKeyLayer(id: string): void {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].id === id) {
      layers.splice(i, 1);
      return;
    }
  }
}

function dispatch(e: KeyboardEvent): void {
  for (let i = layers.length - 1; i >= 0; i--) {
    const handled = layers[i].handler(e);
    if (handled) return;
  }
}

document.addEventListener('keydown', dispatch, true);
