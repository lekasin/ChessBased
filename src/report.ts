import { sortTimeClasses } from './personal-explorer';
import type { GameMeta } from './personal-explorer';
import type { ExplorerMove, ExplorerResponse } from './types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';
import { findOpeningByFen } from './opening-index';

// ── Types ──

export interface WDL {
  wins: number;
  draws: number;
  losses: number;
  total: number;
}

export type LineAggregationMode = 'line' | 'position';

export interface OpeningLine {
  label: string;
  displayLabel: string;
  moves: string[];   // SAN
  ucis: string[];    // UCI
  wdl: WDL;
  edgeWdl: WDL;
  positionWdl: WDL;
  transpositionLabels: string[];
  winRate: number;
  endFen: string;
  color: 'white' | 'black';
  openingName: string | null;
  eco: string | null;
  rawScorePct: number;
  adjustedScorePct: number;
  scoreCiPct: number;
  confidence: 'high' | 'medium' | 'low';
  deltaVsExpectedPct: number | null;
  impact: number;
  exampleLinks: {
    wins: string[];
    losses: string[];
    draws: string[];
    all: string[];
  };
}

export interface OpeningFamily {
  key: string;
  color: 'white' | 'black';
  eco: string | null;
  rootName: string;
  displayLabel: string;
  baseLine: OpeningLine;
  wdl: WDL;
  winRate: number;
  rawScorePct: number;
  adjustedScorePct: number;
  scoreCiPct: number;
  confidence: 'high' | 'medium' | 'low';
  deltaVsExpectedPct: number | null;
  impact: number;
  continuationSpreadPct: number;
  continuations: OpeningLine[];
  topWeakContinuations: OpeningLine[];
  topStrongContinuation: OpeningLine | null;
}

export interface SideFamilyReport {
  color: 'white' | 'black';
  families: OpeningFamily[];
  weakFamilies: OpeningFamily[];
  bestFamilies: OpeningFamily[];
}

export interface MonthlyRating {
  month: string;
  avgRating: number;
  gameCount: number;
}

export interface TimeControlStats {
  timeClass: string;
  wdl: WDL;
  winRate: number;
}

export interface ReportData {
  totalGames: number;
  overall: WDL;
  overallWinRate: number;
  asWhite: WDL;
  asBlack: WDL;
  byTimeControl: TimeControlStats[];
  ratingTrend: MonthlyRating[];
  whiteFamilyReport: SideFamilyReport | null;
  blackFamilyReport: SideFamilyReport | null;
  whiteOpenings: OpeningLine[];
  blackOpenings: OpeningLine[];
  weaknessQueue: OpeningLine[];
  bestScoreOpenings: OpeningLine[];
  bestOpenings: OpeningLine[];
  worstOpenings: OpeningLine[];
}

// ── Helpers ──

function emptyWDL(): WDL {
  return { wins: 0, draws: 0, losses: 0, total: 0 };
}

function copyWDL(wdl: WDL): WDL {
  return { wins: wdl.wins, draws: wdl.draws, losses: wdl.losses, total: wdl.total };
}

function userResult(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  if (game.re === 'w') return game.uw ? 'win' : 'loss';
  return game.uw ? 'loss' : 'win';
}

function addResult(wdl: WDL, result: 'win' | 'draw' | 'loss'): void {
  if (result === 'win') wdl.wins++;
  else if (result === 'draw') wdl.draws++;
  else wdl.losses++;
  wdl.total++;
}

export function buildRatingTrends(games: readonly GameMeta[]): Map<string, MonthlyRating[]> {
  const tcMonthMap = new Map<string, Map<string, { totalRating: number; count: number }>>();
  for (const game of games) {
    if (game.ur <= 0) continue;
    let monthMap = tcMonthMap.get(game.tc);
    if (!monthMap) { monthMap = new Map(); tcMonthMap.set(game.tc, monthMap); }
    const existing = monthMap.get(game.mo);
    if (existing) { existing.totalRating += game.ur; existing.count++; }
    else monthMap.set(game.mo, { totalRating: game.ur, count: 1 });
  }
  const result = new Map<string, MonthlyRating[]>();
  const tcKeys = sortTimeClasses([...tcMonthMap.keys()]);
  for (const tc of tcKeys) {
    const monthMap = tcMonthMap.get(tc)!;
    const trend: MonthlyRating[] = [];
    for (const [month, data] of monthMap) {
      trend.push({ month, avgRating: Math.round(data.totalRating / data.count), gameCount: data.count });
    }
    trend.sort((a, b) => a.month.localeCompare(b.month));
    if (trend.length >= 2) result.set(tc, trend);
  }
  return result;
}

export function buildTimeControlStats(games: readonly GameMeta[]): TimeControlStats[] {
  const tcMap = new Map<string, WDL>();
  for (const game of games) {
    let wdl = tcMap.get(game.tc);
    if (!wdl) { wdl = emptyWDL(); tcMap.set(game.tc, wdl); }
    addResult(wdl, userResult(game));
  }
  const stats: TimeControlStats[] = [];
  for (const [tc, wdl] of tcMap) stats.push({ timeClass: tc, wdl, winRate: winRate(wdl) });
  const tcOrder = Object.fromEntries(sortTimeClasses([...tcMap.keys()]).map((k, i) => [k, i]));
  stats.sort((a, b) => (tcOrder[a.timeClass] ?? 99) - (tcOrder[b.timeClass] ?? 99));
  return stats;
}

function winRate(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return Math.round((wdl.wins / wdl.total) * 100);
}

function scoreRate(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return (wdl.wins + wdl.draws * 0.5) / wdl.total;
}

function scorePct(wdl: WDL): number {
  return Math.round(scoreRate(wdl) * 100);
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function transpositionIndexKey(
  color: 'white' | 'black',
  ply: number,
  fen: string,
): string {
  return `${color}|${ply}|${positionKey(fen)}`;
}

// ── Opening Tree Walk ──

type QueryFn = (fen: string) => ExplorerResponse | null;
type MoveGameIndicesFn = (fen: string, uci: string) => number[];
type GameByIndexFn = (idx: number) => GameMeta | undefined;

const MIN_GAMES_FOR_LINE = 5;
const MIN_GAMES_FOR_FAMILY = 10;
const MIN_DEPTH = 4; // at least 2 moves per side
const BASE_MAX_PLY = 8;
const ADAPTIVE_MAX_PLY = 10;
const ADAPTIVE_MIN_NODE_GAMES = 20;
const PRIOR_WEIGHT = 12;
const MAX_WEAK_FAMILIES = 5;
const MAX_BEST_FAMILIES = 3;
const MAX_WEAK_CONTINUATION_SNIPPETS = 2;
const CRITICAL_CONTINUATION_MIN_GAMES = 12;
const CRITICAL_CONTINUATION_GAP_DELTA_PTS = 12;
const CRITICAL_CONTINUATION_MIN_IMPACT_RATIO = 0.75;

function walkOpenings(
  isWhite: boolean,
  queryFn: QueryFn,
  aggregationMode: LineAggregationMode,
): OpeningLine[] {
  const lines: OpeningLine[] = [];
  const visited = new Set<string>(); // dedup transpositions

  function collectLine(moves: string[], ucis: string[], endFen: string): void {
    if (ucis.length === 0) return;
    const label = moves.join(' ');
    if (lines.some(l => l.label === label)) return;

    const line = makeOpeningLine(isWhite, moves, ucis, endFen, queryFn, aggregationMode);
    lines.push(line);
  }

  function walk(
    chess: Chess,
    moves: string[],
    ucis: string[],
    depth: number,
  ): void {
    const fen = makeFen(chess.toSetup());
    const key = positionKey(fen);

    // Skip positions already explored via a different move order (transpositions)
    if (visited.has(key)) return;
    visited.add(key);

    const data = queryFn(fen);
    if (!data || data.moves.length === 0) {
      if (depth >= MIN_DEPTH) {
        collectLine(moves, ucis, fen);
      }
      return;
    }

    const nodeGames = data.moves.reduce((sum, move) => sum + moveTotal(move), 0);
    const maxPly = depth < BASE_MAX_PLY
      ? BASE_MAX_PLY
      : nodeGames >= ADAPTIVE_MIN_NODE_GAMES
        ? ADAPTIVE_MAX_PLY
        : BASE_MAX_PLY;
    if (depth >= maxPly) {
      if (depth >= MIN_DEPTH) {
        collectLine(moves, ucis, fen);
      }
      return;
    }

    // Follow all moves (both user and opponent) with enough games.
    let anyFollowed = false;
    for (const m of data.moves) {
      const total = m.white + m.draws + m.black;
      if (total < MIN_GAMES_FOR_LINE) continue;

      const move = parseUci(m.uci);
      if (!move) continue;
      let san: string;
      try { san = makeSan(chess, move); } catch { continue; }

      anyFollowed = true;

      const next = chess.clone();
      next.play(move);
      walk(next, [...moves, san], [...ucis, m.uci], depth + 1);
    }

    if (!anyFollowed && depth >= MIN_DEPTH) {
      collectLine(moves, ucis, fen);
    }
  }

  const chess = Chess.default();
  walk(chess, [], [], 0);

  // Sort by game count descending
  lines.sort((a, b) => b.wdl.total - a.wdl.total);
  return lines;
}

function computeEdgeWdl(
  ucis: string[],
  isWhite: boolean,
  queryFn: QueryFn,
): WDL {
  const wdl = emptyWDL();
  if (ucis.length > 0) {
    const parentChess = Chess.default();
    for (let i = 0; i < ucis.length - 1; i++) {
      const m = parseUci(ucis[i]);
      if (m) parentChess.play(m);
    }
    const parentFen = makeFen(parentChess.toSetup());
    const parentData = queryFn(parentFen);
    if (parentData) {
      const lastUci = ucis[ucis.length - 1];
      const moveData = parentData.moves.find(m => m.uci === lastUci);
      if (moveData) {
        wdl.total = moveData.white + moveData.draws + moveData.black;
        if (isWhite) {
          wdl.wins = moveData.white;
          wdl.draws = moveData.draws;
          wdl.losses = moveData.black;
        } else {
          wdl.wins = moveData.black;
          wdl.draws = moveData.draws;
          wdl.losses = moveData.white;
        }
      }
    }
  }

  return wdl;
}

function computePositionWdl(
  endFen: string,
  isWhite: boolean,
  queryFn: QueryFn,
): WDL {
  const wdl = emptyWDL();
  const data = queryFn(endFen);
  if (data) {
    for (const m of data.moves) {
      wdl.total += m.white + m.draws + m.black;
      if (isWhite) {
        wdl.wins += m.white;
        wdl.draws += m.draws;
        wdl.losses += m.black;
      } else {
        wdl.wins += m.black;
        wdl.draws += m.draws;
        wdl.losses += m.white;
      }
    }
  }
  return wdl;
}

function computeLineWdl(
  ucis: string[],
  isWhite: boolean,
  queryFn: QueryFn,
  endFen: string,
  aggregationMode: LineAggregationMode,
): { wdl: WDL; edgeWdl: WDL; positionWdl: WDL } {
  const edgeWdl = computeEdgeWdl(ucis, isWhite, queryFn);
  const positionWdl = computePositionWdl(endFen, isWhite, queryFn);
  const wdl = aggregationMode === 'position'
    ? (positionWdl.total > 0 ? copyWDL(positionWdl) : copyWDL(edgeWdl))
    : (edgeWdl.total > 0 ? copyWDL(edgeWdl) : copyWDL(positionWdl));
  return { wdl, edgeWdl, positionWdl };
}

function makeOpeningLine(
  isWhite: boolean,
  moves: string[],
  ucis: string[],
  endFen: string,
  queryFn: QueryFn,
  aggregationMode: LineAggregationMode,
): OpeningLine {
  const { wdl, edgeWdl, positionWdl } = computeLineWdl(ucis, isWhite, queryFn, endFen, aggregationMode);
  const label = moves.join(' ');
  const openingInfo = findOpeningForLine(endFen, ucis);
  const displayLabel = openingInfo ? openingInfo.name : label;

  return {
    label,
    displayLabel,
    moves,
    ucis,
    wdl,
    edgeWdl,
    positionWdl,
    transpositionLabels: [],
    winRate: winRate(wdl),
    endFen,
    color: isWhite ? 'white' : 'black',
    openingName: openingInfo?.name ?? null,
    eco: openingInfo?.eco ?? null,
    rawScorePct: scorePct(wdl),
    adjustedScorePct: scorePct(wdl),
    scoreCiPct: 0,
    confidence: 'low',
    deltaVsExpectedPct: null,
    impact: 0,
    exampleLinks: { wins: [], losses: [], draws: [], all: [] },
  };
}

function normalizeAndDedupeOpenings(
  lines: OpeningLine[],
  queryFn: QueryFn,
  aggregationMode: LineAggregationMode,
): OpeningLine[] {
  const dedup = new Map<string, OpeningLine>();

  for (const line of lines) {
    if (line.ucis.length === 0) continue;

    let ucis = line.ucis;
    let moves = line.moves;
    const lastIdx = ucis.length - 1;
    if (lastIdx >= 0 && !isUserMoveIndex(line.color, lastIdx)) {
      ucis = ucis.slice(0, -1);
      moves = moves.slice(0, -1);
    }
    if (ucis.length === 0) continue;

    const fens = buildLineFens(ucis);
    if (!fens) continue;
    const endFen = fens[fens.length - 1];
    const normalized = makeOpeningLine(line.color === 'white', moves, ucis, endFen, queryFn, aggregationMode);
    const key = `${normalized.color}|${positionKey(normalized.endFen)}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, normalized);
      continue;
    }

    if (normalized.wdl.total > existing.wdl.total) {
      dedup.set(key, normalized);
      continue;
    }
    if (normalized.wdl.total === existing.wdl.total) {
      if (normalized.ucis.length > existing.ucis.length) {
        dedup.set(key, normalized);
        continue;
      }
      if (normalized.ucis.length === existing.ucis.length && normalized.label.localeCompare(existing.label) < 0) {
        dedup.set(key, normalized);
      }
    }
  }

  const out = [...dedup.values()];
  out.sort((a, b) => b.wdl.total - a.wdl.total || b.ucis.length - a.ucis.length || a.label.localeCompare(b.label));
  return out;
}

function findOpeningForLine(endFen: string, ucis: string[]): { name: string; eco: string } | null {
  // Prefer the deepest known opening name reached along the line.
  const chess = Chess.default();
  let best: { name: string; eco: string } | null = null;

  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move) break;
    chess.play(move);
    const hit = findOpeningByFen(makeFen(chess.toSetup()));
    if (hit) best = hit;
  }

  if (best) return best;
  const endHit = findOpeningByFen(endFen);
  return endHit ? { name: endHit.name, eco: endHit.eco } : null;
}

function confidenceFromGames(total: number): 'high' | 'medium' | 'low' {
  if (total >= 40) return 'high';
  if (total >= 15) return 'medium';
  return 'low';
}

function expectedScore(userRating: number, oppRating: number): number | null {
  if (userRating <= 0 || oppRating <= 0) return null;
  return 1 / (1 + Math.pow(10, (oppRating - userRating) / 400));
}

function moveTotal(move: ExplorerMove): number {
  return move.white + move.draws + move.black;
}

function moveScoreRate(move: ExplorerMove, isWhite: boolean): number {
  const total = moveTotal(move);
  if (total === 0) return 0;
  const wins = isWhite ? move.white : move.black;
  return (wins + move.draws * 0.5) / total;
}

function aggregateScoreRate(data: ExplorerResponse, isWhite: boolean): number | null {
  let points = 0;
  let total = 0;

  for (const move of data.moves) {
    const games = moveTotal(move);
    if (games === 0) continue;
    const wins = isWhite ? move.white : move.black;
    points += wins + move.draws * 0.5;
    total += games;
  }

  if (total === 0) return null;
  return points / total;
}

function isUserMoveIndex(color: 'white' | 'black', moveIdx: number): boolean {
  return color === 'white' ? moveIdx % 2 === 0 : moveIdx % 2 === 1;
}

function buildLineFens(ucis: string[]): string[] | null {
  const chess = Chess.default();
  const fens = [makeFen(chess.toSetup())];

  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move) return null;
    chess.play(move);
    fens.push(makeFen(chess.toSetup()));
  }

  return fens;
}

function getParentFenAndLastUci(ucis: string[]): { fen: string; uci: string } | null {
  if (ucis.length === 0) return null;
  const chess = Chess.default();
  for (let i = 0; i < ucis.length - 1; i++) {
    const move = parseUci(ucis[i]);
    if (!move) return null;
    chess.play(move);
  }
  return {
    fen: makeFen(chess.toSetup()),
    uci: ucis[ucis.length - 1],
  };
}

function buildLineExamples(
  indices: number[],
  getGameByIndex: GameByIndexFn,
): { wins: string[]; losses: string[]; draws: string[]; all: string[] } {
  const rows: { href: string; result: 'win' | 'draw' | 'loss'; date: string; idx: number }[] = [];

  for (const idx of indices) {
    const g = getGameByIndex(idx);
    if (!g?.gl) continue;
    const date = g.da && g.da !== 'unknown'
      ? g.da
      : (g.mo && g.mo !== 'unknown' ? `${g.mo}-01` : '');
    rows.push({
      href: g.gl,
      result: userResult(g),
      date,
      idx,
    });
  }

  // Most recent first (date desc, then index desc as stable fallback)
  rows.sort((a, b) => {
    const am = a.date && a.date !== 'unknown' ? a.date : '';
    const bm = b.date && b.date !== 'unknown' ? b.date : '';
    if (am !== bm) return bm.localeCompare(am);
    return b.idx - a.idx;
  });

  const all = rows.map(r => r.href);
  const wins = rows.filter(r => r.result === 'win').map(r => r.href);
  const losses = rows.filter(r => r.result === 'loss').map(r => r.href);
  const draws = rows.filter(r => r.result === 'draw').map(r => r.href);

  return { wins, losses, draws, all };
}

type TranspositionLabelIndex = Map<string, Map<string, number>>;

function buildTranspositionLabelIndex(
  games: readonly GameMeta[],
  maxPly: number,
): TranspositionLabelIndex {
  const index: TranspositionLabelIndex = new Map();

  for (const game of games) {
    if (!game.mv) continue;
    const ucis = game.mv.split(/\s+/).filter(Boolean);
    if (ucis.length === 0) continue;

    const color: 'white' | 'black' = game.uw ? 'white' : 'black';
    const chess = Chess.default();
    const sans: string[] = [];
    const limit = Math.min(ucis.length, maxPly);

    for (let i = 0; i < limit; i++) {
      const move = parseUci(ucis[i]);
      if (!move) break;
      let san: string;
      try {
        san = makeSan(chess, move);
      } catch {
        break;
      }
      chess.play(move);
      sans.push(san);

      const key = transpositionIndexKey(color, i + 1, makeFen(chess.toSetup()));
      let labelCounts = index.get(key);
      if (!labelCounts) {
        labelCounts = new Map();
        index.set(key, labelCounts);
      }
      const label = sans.join(' ');
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  return index;
}

function attachTranspositionLabels(
  lines: OpeningLine[],
  index: TranspositionLabelIndex,
): void {
  for (const line of lines) {
    const key = transpositionIndexKey(line.color, line.ucis.length, line.endFen);
    const labelCounts = index.get(key);
    if (!labelCounts) {
      line.transpositionLabels = [];
      continue;
    }
    const labels = [...labelCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label]) => label)
      .filter(label => label !== line.label);
    line.transpositionLabels = labels;
  }
}

function adjustedScore(raw: number, total: number, globalScore: number): number {
  return total > 0
    ? ((raw * total) + (globalScore * PRIOR_WEIGHT)) / (total + PRIOR_WEIGHT)
    : globalScore;
}

function lineStrength(line: OpeningLine, globalScore: number): number {
  const adj = adjustedScore(scoreRate(line.wdl), line.wdl.total, globalScore);
  return Math.max(0, adj - globalScore) * line.wdl.total;
}

function familyRootName(line: OpeningLine): string {
  const fromName = line.openingName?.split(':')[0]?.trim();
  if (fromName) return fromName;
  const fromSan = line.moves.slice(0, 4).join(' ').trim();
  if (fromSan) return fromSan;
  return 'Unclassified';
}

function familyWeakSort(a: OpeningLine, b: OpeningLine): number {
  return b.impact - a.impact
    || a.adjustedScorePct - b.adjustedScorePct
    || b.wdl.total - a.wdl.total
    || a.label.localeCompare(b.label);
}

function familyStrongSort(a: OpeningLine, b: OpeningLine, globalScore: number): number {
  return lineStrength(b, globalScore) - lineStrength(a, globalScore)
    || b.adjustedScorePct - a.adjustedScorePct
    || b.wdl.total - a.wdl.total
    || a.label.localeCompare(b.label);
}

function lineStartsWith(line: OpeningLine, prefix: OpeningLine): boolean {
  if (line.ucis.length <= prefix.ucis.length) return false;
  for (let i = 0; i < prefix.ucis.length; i++) {
    if (line.ucis[i] !== prefix.ucis[i]) return false;
  }
  return true;
}

function impactGapPoints(line: OpeningLine): number {
  if (line.wdl.total <= 0) return 0;
  return (line.impact / line.wdl.total) * 100;
}

function aggregateFamilies(
  lines: OpeningLine[],
  color: 'white' | 'black',
  globalScore: number,
): SideFamilyReport | null {
  if (lines.length === 0) return null;

  const grouped = new Map<string, OpeningLine[]>();
  for (const line of lines) {
    const rootName = familyRootName(line);
    // Group by side + opening family name so nearby ECO subcodes (e.g. C33/C34)
    // collapse into one family with deeper branches as continuations.
    const key = `${line.color}|${rootName.toLowerCase()}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(line);
    else grouped.set(key, [line]);
  }

  const families: OpeningFamily[] = [];
  for (const [key, groupedLines] of grouped) {
    const totalGames = Math.max(...groupedLines.map(l => l.wdl.total));
    if (totalGames < MIN_GAMES_FOR_FAMILY) continue;

    const weakBaseCandidates = groupedLines.filter(line => line.impact > 0);
    const basePool = weakBaseCandidates.length > 0 ? weakBaseCandidates : groupedLines;
    const structuralBase = [...basePool].sort((a, b) =>
      a.ucis.length - b.ucis.length
        || b.impact - a.impact
        || b.wdl.total - a.wdl.total
        || a.label.localeCompare(b.label)
    )[0];
    let baseLine = structuralBase;

    // If a deeper continuation is dramatically weaker with enough sample size,
    // let that line drive the family card instead of always preferring shortest.
    if (weakBaseCandidates.length > 1) {
      const catastrophic = [...weakBaseCandidates].sort((a, b) =>
        impactGapPoints(b) - impactGapPoints(a)
          || b.impact - a.impact
          || b.wdl.total - a.wdl.total
          || b.ucis.length - a.ucis.length
          || a.label.localeCompare(b.label)
      )[0];

      const structuralGap = impactGapPoints(structuralBase);
      const catastrophicGap = impactGapPoints(catastrophic);
      const significantGap = catastrophicGap - structuralGap >= CRITICAL_CONTINUATION_GAP_DELTA_PTS;
      const enoughGames = catastrophic.wdl.total >= CRITICAL_CONTINUATION_MIN_GAMES;
      const enoughImpact = catastrophic.impact >= structuralBase.impact * CRITICAL_CONTINUATION_MIN_IMPACT_RATIO;
      const deeperLine = catastrophic.ucis.length > structuralBase.ucis.length;
      if (deeperLine && enoughGames && significantGap && enoughImpact) {
        baseLine = catastrophic;
      }
    }

    const continuationLines = groupedLines.filter(line => lineStartsWith(line, baseLine));
    const sortedWeak = [...continuationLines].sort(familyWeakSort);
    const sortedStrong = [...continuationLines].sort((a, b) => familyStrongSort(a, b, globalScore));

    // Use base-line totals for family-level score/priority so counts are not
    // double-counted across overlapping deeper continuations.
    const wdl: WDL = {
      wins: baseLine.wdl.wins,
      draws: baseLine.wdl.draws,
      losses: baseLine.wdl.losses,
      total: baseLine.wdl.total,
    };

    const raw = scoreRate(wdl);
    const adj = adjustedScore(raw, wdl.total, globalScore);
    const ci = wdl.total > 0 ? 1.96 * Math.sqrt((adj * (1 - adj)) / wdl.total) : 0;
    const rootName = familyRootName(groupedLines[0]);
    const eco = baseLine.eco ?? groupedLines.find(l => l.eco)?.eco ?? null;
    const spread = continuationLines.length > 1
      ? Math.max(...continuationLines.map(l => l.adjustedScorePct)) - Math.min(...continuationLines.map(l => l.adjustedScorePct))
      : 0;

    const topStrong = sortedStrong.find(line => lineStrength(line, globalScore) > 0) ?? null;
    const displayLabel = baseLine.openingName ?? rootName;
    const family: OpeningFamily = {
      key,
      color,
      eco,
      rootName,
      displayLabel,
      baseLine,
      wdl,
      winRate: winRate(wdl),
      rawScorePct: Math.round(raw * 100),
      adjustedScorePct: Math.round(adj * 100),
      scoreCiPct: Math.round(ci * 1000) / 10,
      confidence: confidenceFromGames(wdl.total),
      deltaVsExpectedPct: baseLine.deltaVsExpectedPct,
      impact: Math.round(Math.max(0, globalScore - adj) * wdl.total * 100) / 100,
      continuationSpreadPct: spread,
      continuations: sortedWeak,
      topWeakContinuations: sortedWeak.slice(0, MAX_WEAK_CONTINUATION_SNIPPETS),
      topStrongContinuation: topStrong,
    };

    families.push(family);
  }

  families.sort((a, b) =>
    b.impact - a.impact
    || a.adjustedScorePct - b.adjustedScorePct
    || b.wdl.total - a.wdl.total
    || a.displayLabel.localeCompare(b.displayLabel)
  );

  const weakFamilies = families
    .filter(f => f.impact > 0)
    .slice(0, MAX_WEAK_FAMILIES);

  const weakKeys = new Set(weakFamilies.map(f => f.key));
  const bestFamilies = [...families]
    .filter(f => !weakKeys.has(f.key))
    .sort((a, b) => {
      const aStrength = Math.max(0, (a.adjustedScorePct / 100) - globalScore) * a.wdl.total;
      const bStrength = Math.max(0, (b.adjustedScorePct / 100) - globalScore) * b.wdl.total;
      return bStrength - aStrength
        || b.adjustedScorePct - a.adjustedScorePct
        || b.wdl.total - a.wdl.total
        || a.displayLabel.localeCompare(b.displayLabel);
    })
    .slice(0, MAX_BEST_FAMILIES);

  return {
    color,
    families,
    weakFamilies,
    bestFamilies,
  };
}

function lineKey(line: OpeningLine): string {
  return `${line.color}|${line.label}`;
}

function pickTopLines(
  sorted: OpeningLine[],
  count: number,
  avoid: Set<string> = new Set(),
): OpeningLine[] {
  const out: OpeningLine[] = [];
  const used = new Set<string>();

  for (const line of sorted) {
    const key = lineKey(line);
    if (avoid.has(key) || used.has(key)) continue;
    out.push(line);
    used.add(key);
    if (out.length >= count) break;
  }

  // Backfill in case avoid-filter removed too many.
  if (out.length < count) {
    for (const line of sorted) {
      const key = lineKey(line);
      if (used.has(key)) continue;
      out.push(line);
      used.add(key);
      if (out.length >= count) break;
    }
  }

  return out;
}

function thirdStickout(
  sorted: OpeningLine[],
  valueOf: (line: OpeningLine) => number,
): number {
  if (sorted.length < 3) return Number.NEGATIVE_INFINITY;
  if (sorted.length === 3) return Number.POSITIVE_INFINITY;
  return valueOf(sorted[2]) - valueOf(sorted[3]);
}

function enrichOpeningLines(
  lines: OpeningLine[],
  globalScore: number,
  queryFn: QueryFn,
  moveGameIndicesFn?: MoveGameIndicesFn,
  gameByIndexFn?: GameByIndexFn,
): void {
  for (const line of lines) {
    const total = line.wdl.total;
    const raw = scoreRate(line.wdl);
    const adj = adjustedScore(raw, total, globalScore);
    const ci = total > 0 ? 1.96 * Math.sqrt((adj * (1 - adj)) / total) : 0;

    line.rawScorePct = Math.round(raw * 100);
    line.adjustedScorePct = Math.round(adj * 100);
    line.scoreCiPct = Math.round(ci * 1000) / 10;
    line.confidence = confidenceFromGames(total);
    line.impact = Math.round(Math.max(0, globalScore - adj) * total * 100) / 100;

    if (!moveGameIndicesFn || !gameByIndexFn || line.ucis.length === 0) continue;
    const parent = getParentFenAndLastUci(line.ucis);
    if (!parent) continue;
    const indices = moveGameIndicesFn(parent.fen, parent.uci);
    if (indices.length === 0) continue;

    const expected: number[] = [];
    for (const idx of indices) {
      const g = gameByIndexFn(idx);
      if (!g) continue;
      const e = expectedScore(g.ur, g.or);
      if (e == null) continue;
      expected.push(e);
    }
    if (expected.length > 0) {
      const expectedAvg = expected.reduce((a, b) => a + b, 0) / expected.length;
      line.deltaVsExpectedPct = Math.round((raw - expectedAvg) * 100);
    }

    line.exampleLinks = buildLineExamples(indices, gameByIndexFn);
  }
}

// ── Main Report Generation ──

export function generateReport(
  games: readonly GameMeta[],
  queryFn: QueryFn,
  syncColorFilter?: (color: 'white' | 'black' | null) => void,
  moveGameIndicesFn?: MoveGameIndicesFn,
  gameByIndexFn?: GameByIndexFn,
  sideFilter?: 'white' | 'black',
  aggregationMode: LineAggregationMode = 'position',
): ReportData {
  const overall = emptyWDL();
  const asWhite = emptyWDL();
  const asBlack = emptyWDL();
  const tcMap = new Map<string, WDL>();
  const monthMap = new Map<string, { totalRating: number; count: number }>();

  // Single pass through games
  for (const game of games) {
    const result = userResult(game);
    addResult(overall, result);

    if (game.uw) {
      addResult(asWhite, result);
    } else {
      addResult(asBlack, result);
    }

    // By time control
    let tcWdl = tcMap.get(game.tc);
    if (!tcWdl) {
      tcWdl = emptyWDL();
      tcMap.set(game.tc, tcWdl);
    }
    addResult(tcWdl, result);

    // Monthly rating
    if (game.ur > 0) {
      const existing = monthMap.get(game.mo);
      if (existing) {
        existing.totalRating += game.ur;
        existing.count++;
      } else {
        monthMap.set(game.mo, { totalRating: game.ur, count: 1 });
      }
    }
  }

  // Time control stats
  const byTimeControl: TimeControlStats[] = [];
  for (const [tc, wdl] of tcMap) {
    byTimeControl.push({ timeClass: tc, wdl, winRate: winRate(wdl) });
  }
  const tcOrder = Object.fromEntries(sortTimeClasses([...tcMap.keys()]).map((k, i) => [k, i]));
  byTimeControl.sort((a, b) => (tcOrder[a.timeClass] ?? 99) - (tcOrder[b.timeClass] ?? 99));

  // Rating trend
  const ratingTrend: MonthlyRating[] = [];
  for (const [month, data] of monthMap) {
    ratingTrend.push({
      month,
      avgRating: Math.round(data.totalRating / data.count),
      gameCount: data.count,
    });
  }
  ratingTrend.sort((a, b) => a.month.localeCompare(b.month));

  // Opening trees — filter by color so we only see games where the user played that side.
  const globalScore = scoreRate(overall);
  const whiteBaselineScore = asWhite.total > 0 ? scoreRate(asWhite) : globalScore;
  const blackBaselineScore = asBlack.total > 0 ? scoreRate(asBlack) : globalScore;
  const transpositionIndex = buildTranspositionLabelIndex(games, ADAPTIVE_MAX_PLY);
  let whiteOpenings: OpeningLine[] = [];
  let blackOpenings: OpeningLine[] = [];

  if (sideFilter !== 'black') {
    syncColorFilter?.('white');
    const rawWhite = walkOpenings(true, queryFn, aggregationMode);
    whiteOpenings = normalizeAndDedupeOpenings(rawWhite, queryFn, aggregationMode);
    attachTranspositionLabels(whiteOpenings, transpositionIndex);
    enrichOpeningLines(whiteOpenings, whiteBaselineScore, queryFn, moveGameIndicesFn, gameByIndexFn);
  }

  if (sideFilter !== 'white') {
    syncColorFilter?.('black');
    const rawBlack = walkOpenings(false, queryFn, aggregationMode);
    blackOpenings = normalizeAndDedupeOpenings(rawBlack, queryFn, aggregationMode);
    attachTranspositionLabels(blackOpenings, transpositionIndex);
    enrichOpeningLines(blackOpenings, blackBaselineScore, queryFn, moveGameIndicesFn, gameByIndexFn);
  }

  syncColorFilter?.(null);
  const whiteFamilyReport = sideFilter === 'black'
    ? null
    : aggregateFamilies(whiteOpenings, 'white', whiteBaselineScore);
  const blackFamilyReport = sideFilter === 'white'
    ? null
    : aggregateFamilies(blackOpenings, 'black', blackBaselineScore);

  // Legacy line-based key findings kept for compatibility while UI migrates.
  const MIN_GAMES_FOR_FINDING = 10;
  const allLines = [
    ...whiteOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
    ...blackOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
  ];

  // Positive training value for "what works":
  // How far above baseline this line is, scaled by how often it occurs.
  const highlightStrength = (line: OpeningLine): number => {
    const raw = scoreRate(line.wdl);
    const adj = adjustedScore(raw, line.wdl.total, globalScore);
    return Math.max(0, adj - globalScore) * line.wdl.total;
  };

  const scoreSorted = [...allLines]
    .sort((a, b) =>
      b.adjustedScorePct - a.adjustedScorePct ||
      b.rawScorePct - a.rawScorePct ||
      b.wdl.total - a.wdl.total
    );

  const weightedSorted = [...allLines]
    .sort((a, b) =>
      highlightStrength(b) - highlightStrength(a) ||
      b.adjustedScorePct - a.adjustedScorePct ||
      b.rawScorePct - a.rawScorePct ||
      b.wdl.total - a.wdl.total
    );

  const scoreStickout = thirdStickout(scoreSorted, l => l.adjustedScorePct);
  const weightedStickout = thirdStickout(weightedSorted, l => highlightStrength(l));

  const scoreTarget = weightedStickout > scoreStickout ? 2 : 3;
  const weightedTarget = weightedStickout > scoreStickout ? 3 : 2;

  let bestScoreOpenings: OpeningLine[];
  let bestOpenings: OpeningLine[];

  if (scoreTarget >= weightedTarget) {
    bestScoreOpenings = pickTopLines(scoreSorted, scoreTarget);
    bestOpenings = pickTopLines(
      weightedSorted,
      weightedTarget,
      new Set(bestScoreOpenings.map(lineKey)),
    );
  } else {
    bestOpenings = pickTopLines(weightedSorted, weightedTarget);
    bestScoreOpenings = pickTopLines(
      scoreSorted,
      scoreTarget,
      new Set(bestOpenings.map(lineKey)),
    );
  }

  const worstOpenings = [...allLines]
    .filter(l => l.impact > 0)
    .sort((a, b) =>
      b.impact - a.impact ||
      a.adjustedScorePct - b.adjustedScorePct ||
      b.wdl.total - a.wdl.total
    )
    .slice(0, 3);

  const weaknessQueue = [...whiteOpenings, ...blackOpenings]
    .filter(l => l.wdl.total >= 8 && l.impact > 0)
    .sort((a, b) =>
      b.impact - a.impact ||
      a.adjustedScorePct - b.adjustedScorePct ||
      b.wdl.total - a.wdl.total
    )
    .slice(0, 5);

  return {
    totalGames: games.length,
    overall,
    overallWinRate: winRate(overall),
    asWhite,
    asBlack,
    byTimeControl,
    ratingTrend,
    whiteFamilyReport,
    blackFamilyReport,
    whiteOpenings,
    blackOpenings,
    weaknessQueue,
    bestScoreOpenings,
    bestOpenings,
    worstOpenings,
  };
}
