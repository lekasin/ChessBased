import { buildRepertoireTree, type TreeNode } from './tree';
import { getActiveOpening, FREE_PLAY_NAME } from './repertoire';
import { hierarchy, tree as d3Tree } from 'd3-hierarchy';
import type { LineEntry } from './history-tree';
import { pushKeyLayer, popKeyLayer } from './keyboard';

type NavigateCallback = (fen: string, line: LineEntry[]) => void;

interface SubwayNode {
  id: string;
  san: string;
  uci: string;
  fen: string;
  ply: number;
  moveNumber: number;
  isBlack: boolean;
  children: SubwayNode[];
}

interface SvgCoord {
  x: number;
  y: number;
}

let navigateCb: NavigateCallback | null = null;
let selectedFen: string | null = null;
let subwayNodesById = new Map<string, SubwayNode>();
let subwayParentById = new Map<string, string>();

export function setTreeNavigateCallback(cb: NavigateCallback): void {
  navigateCb = cb;
}

export function showTreeModal(): void {
  if (getActiveOpening() === FREE_PLAY_NAME) return;
  const roots = buildRepertoireTree();
  if (roots.length === 0) return;
  const subwayRoots = buildSubwayNodes(roots);
  openTreeModal(subwayRoots, 'Opening lines');
}

function openTreeModal(roots: SubwayNode[], title: string): void {
  // Remove existing modal if any
  document.getElementById('tree-modal-overlay')?.remove();

  const { html } = renderSubwayHtml(roots, title, selectedFen);

  const overlay = document.createElement('div');
  overlay.id = 'tree-modal-overlay';
  overlay.className = 'tree-modal-overlay';

  overlay.innerHTML = `
    <div class="tree-modal">
      <div class="tree-modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="btn icon ghost">&times;</button>
      </div>
      <div class="tree-modal-body">${html}</div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = (): void => {
    popKeyLayer('tree-modal');
    overlay.remove();
  };

  overlay.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('.tree-modal-close') || target === overlay) {
      close();
      return;
    }

    const hit = target.closest('[data-fen]') as HTMLElement | null;
    if (!hit) return;
    const fen = hit.dataset.fen;
    if (!fen) return;
    selectedFen = fen;
    navigateCb?.(fen, buildLineForFen(fen));
    // Re-render both modal and source
    const body = overlay.querySelector('.tree-modal-body');
    if (body) {
      const { html: updated } = renderSubwayHtml(roots, title, selectedFen);
      body.innerHTML = updated;
    }
  });

  pushKeyLayer('tree-modal', (e) => {
    if (e.key === 'Escape') {
      close();
      return true;
    }
    return false;
  });
}

function buildLineForFen(fen: string): LineEntry[] {
  // Find a node matching the FEN and walk up to root
  for (const node of subwayNodesById.values()) {
    if (node.fen === fen) {
      const entries: LineEntry[] = [];
      let cur: SubwayNode | undefined = node;
      while (cur) {
        entries.unshift({ san: cur.san, uci: cur.uci, fen: cur.fen });
        const pid = subwayParentById.get(cur.id);
        cur = pid ? subwayNodesById.get(pid) : undefined;
      }
      return entries;
    }
  }
  return [];
}

function buildSubwayNodes(roots: TreeNode[]): SubwayNode[] {
  let idCounter = 1;

  const walk = (nodes: TreeNode[], ply: number): SubwayNode[] => {
    return nodes.map((node) => {
      const id = `rep-node-${idCounter++}`;
      const built: SubwayNode = {
        id,
        san: node.san,
        uci: node.uci,
        fen: node.fen,
        ply,
        moveNumber: node.moveNumber,
        isBlack: node.isBlack,
        children: [],
      };
      built.children = walk(node.children, ply + 1);
      return built;
    });
  };

  return walk(roots, 1);
}

function flattenNodes(roots: SubwayNode[]): SubwayNode[] {
  const all: SubwayNode[] = [];
  const visit = (node: SubwayNode): void => {
    all.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return all;
}

function renderSubwayHtml(roots: SubwayNode[], title: string, selectedFenValue: string | null): { html: string; width: number; height: number } {
  const nodesById = new Map<string, SubwayNode>();
  const parentById = new Map<string, string>();
  const edges: Array<{ from: string; to: string }> = [];

  const register = (node: SubwayNode): void => {
    nodesById.set(node.id, node);
    for (const child of node.children) {
      edges.push({ from: node.id, to: child.id });
      parentById.set(child.id, node.id);
      register(child);
    }
  };
  roots.forEach(register);

  // Merge true transpositions (same ply + position key)
  const groupByKey = new Map<string, SubwayNode[]>();
  for (const node of nodesById.values()) {
    const key = `${node.ply}|${positionKey(node.fen)}`;
    const list = groupByKey.get(key);
    if (list) list.push(node);
    else groupByKey.set(key, [node]);
  }

  const nodeToRenderId = new Map<string, string>();
  const renderMeta = new Map<string, {
    san: string;
    moveNumber: number;
    isBlack: boolean;
    nodeIds: string[];
    fens: string[];
    children: string[];
  }>();

  for (const nodes of groupByKey.values()) {
    const representative = nodes[0];
    const renderId = representative.id;
    renderMeta.set(renderId, {
      san: representative.san,
      moveNumber: representative.moveNumber,
      isBlack: representative.isBlack,
      nodeIds: nodes.map((n) => n.id),
      fens: nodes.map((n) => n.fen),
      children: [],
    });
    for (const node of nodes) nodeToRenderId.set(node.id, renderId);
  }

  // Build merged edge set and children adjacency
  const renderEdges: Array<{ from: string; to: string }> = [];
  const edgeSet = new Set<string>();
  for (const edge of edges) {
    const from = nodeToRenderId.get(edge.from);
    const to = nodeToRenderId.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      renderEdges.push({ from, to });
      renderMeta.get(from)?.children.push(to);
    }
  }

  // Build d3-hierarchy tree
  interface D3Node { id: string; children: D3Node[] }
  const hasParent = new Set<string>();
  for (const e of renderEdges) hasParent.add(e.to);
  const renderRoots = Array.from(renderMeta.keys()).filter((id) => !hasParent.has(id));

  const buildD3 = (id: string): D3Node => ({
    id,
    children: (renderMeta.get(id)?.children ?? []).map(buildD3),
  });

  let d3Root: D3Node;
  if (renderRoots.length === 1) {
    d3Root = buildD3(renderRoots[0]);
  } else {
    d3Root = { id: '__vroot__', children: renderRoots.map(buildD3) };
  }

  const root = hierarchy(d3Root);
  const treeLayout = d3Tree<D3Node>().nodeSize([24, 26]);
  treeLayout(root);

  // d3: x = cross-axis, y = depth-axis → vertical: cross→x, depth→y
  const positions = new Map<string, SvgCoord>();
  for (const d of root.descendants()) {
    if (d.data.id !== '__vroot__') {
      positions.set(d.data.id, { x: d.x!, y: d.y! });
    }
  }

  // Shift so all coords have positive margin
  const allPts = Array.from(positions.values());
  if (allPts.length === 0) return { html: '', width: 0, height: 0 };
  const margin = 40;
  const minX = Math.min(...allPts.map((p) => p.x));
  const minY = Math.min(...allPts.map((p) => p.y));
  const shiftX = margin - minX;
  const shiftY = margin - minY;
  for (const [id, pt] of positions) {
    positions.set(id, { x: pt.x + shiftX, y: pt.y + shiftY });
  }

  const maxX = Math.max(...Array.from(positions.values()).map((p) => p.x));
  const maxY = Math.max(...Array.from(positions.values()).map((p) => p.y));
  const width = Math.ceil(maxX + margin + 40);
  const height = Math.ceil(maxY + margin);

  // Active trail
  const allNodes = flattenNodes(roots);
  const selectedIds = new Set(allNodes.filter((n) => n.fen === selectedFenValue).map((n) => n.id));
  const activeIds = new Set<string>();
  const activeRawEdges = new Set<string>();
  for (const sid of selectedIds) {
    activeIds.add(sid);
    let cur = sid;
    while (true) {
      const p = parentById.get(cur);
      if (!p) break;
      activeIds.add(p);
      activeRawEdges.add(`${p}->${cur}`);
      cur = p;
    }
  }

  // Compute active edges in merged space
  const activeEdgeKeys = new Set<string>();
  for (const edge of edges) {
    if (activeRawEdges.has(`${edge.from}->${edge.to}`)) {
      const from = nodeToRenderId.get(edge.from);
      const to = nodeToRenderId.get(edge.to);
      if (from && to && from !== to) activeEdgeKeys.add(`${from}->${to}`);
    }
  }

  const paddingX = 5;
  const boxHeight = 14;
  const labelForMeta = (meta: { san: string; nodeIds: string[] }): string =>
    meta.nodeIds.length > 1 ? `${meta.san} ×${meta.nodeIds.length}` : meta.san;
  const boxWidthForLabel = (label: string): number => Math.max(18, Math.ceil(label.length * 7.1)) + paddingX * 2;

  const edgeSvg = renderEdges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const active = activeEdgeKeys.has(`${edge.from}->${edge.to}`);
      const midY = (from.y + to.y) / 2;
      return `<path d="M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}" class="line-lab-subway-edge${active ? ' active' : ''}" />`;
    })
    .join('');

  const nodeSvg = Array.from(positions.entries())
    .map(([renderId, point]) => {
      const meta = renderMeta.get(renderId);
      if (!meta) return '';
      const label = labelForMeta(meta);
      const boxWidth = boxWidthForLabel(label);
      const boxX = point.x - boxWidth / 2;
      const boxY = point.y - boxHeight / 2;
      const textY = boxY + boxHeight / 2 + 0.4;
      const titleText = escapeHtml(meta.isBlack ? `${meta.moveNumber}... ${meta.san}` : `${meta.moveNumber}. ${meta.san}`);
      const isSelected = selectedFenValue ? meta.fens.includes(selectedFenValue) : false;
      const isActive = meta.nodeIds.some((id) => activeIds.has(id));
      const labelClass = isSelected ? ' selected' : isActive ? ' active' : '';
      const hasMergedSources = meta.nodeIds.length > 1;
      const clickFen: string = isSelected
        ? (selectedFenValue ?? '')
        : (meta.fens[0] ?? '');

      return `
        <g class="line-lab-subway-stop${hasMergedSources ? ' merged' : ''}">
          <rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="${boxHeight}" rx="4" class="line-lab-subway-label-bg${labelClass}" data-fen="${escapeAttr(clickFen)}" />
          <text x="${point.x}" y="${textY}" text-anchor="middle" dominant-baseline="central" class="line-lab-subway-label${labelClass}" data-fen="${escapeAttr(clickFen)}">${escapeHtml(label)}</text>
          <title>${titleText}</title>
        </g>
      `;
    })
    .join('');

  return {
    html: `
      <div class="line-lab-subway-wrap repertoire-subway-wrap">
        <div class="line-lab-subway-caption repertoire-subway-caption">${escapeHtml(title)}</div>
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="line-lab-subway-svg line-lab-subway-svg-vertical repertoire-subway-svg" role="img" aria-label="Opening lines map">
          ${edgeSvg}
          ${nodeSvg}
        </svg>
      </div>
    `,
    width,
    height,
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}
