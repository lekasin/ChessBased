import { parsePgn, startingPosition, walk } from 'chessops/pgn';
import type { PgnNodeData, Game } from 'chessops/pgn';
import type { Position } from 'chessops';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops';
import { lockMove, positionKey, createOpening, switchOpening } from './repertoire';

class PosBox {
  constructor(public value: Position) {}
  clone() { return new PosBox(this.value.clone()); }
}

/** Extract study ID from a Lichess study URL */
function parseStudyId(url: string): string | null {
  const match = url.match(/lichess\.org\/study\/([a-zA-Z0-9]{8})(?:\/|$)/);
  return match ? match[1] : null;
}

/** Fetch PGN for a Lichess study by URL */
export async function fetchStudyPgn(url: string): Promise<string> {
  const studyId = parseStudyId(url.trim());
  if (!studyId) throw new Error('Invalid Lichess study URL');

  const resp = await fetch(`https://lichess.org/api/study/${studyId}.pgn`);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error('Study not found — is it public?');
    throw new Error(`Lichess API error (${resp.status})`);
  }
  return resp.text();
}

export interface ImportResult {
  positions: number;
  moves: number;
  errors: string[];
  openingNames: string[];
}

function eventName(game: Game<PgnNodeData>): string | undefined {
  const event = game.headers.get('Event');
  if (event && event !== '?' && !event.startsWith('Rated') && !event.startsWith('Casual')) {
    return event.trim();
  }
  const opening = game.headers.get('Opening');
  if (opening && opening !== '?') return opening.trim();
  return undefined;
}

function importGames(games: Game<PgnNodeData>[], seen: Set<string>): { moves: number; positions: number; errors: string[] } {
  let moveCount = 0;
  const errors: string[] = [];

  for (let gi = 0; gi < games.length; gi++) {
    const game = games[gi];
    const posResult = startingPosition(game.headers);
    if (!posResult.isOk) {
      errors.push(`Game ${gi + 1}: invalid starting position`);
      continue;
    }

    walk(game.moves, new PosBox(posResult.value), (ctx, node: PgnNodeData) => {
      const pos: Position = ctx.value;
      const move = parseSan(pos, node.san);
      if (!move) {
        errors.push(`Game ${gi + 1}: illegal move "${node.san}"`);
        return;
      }

      const fen = makeFen(pos.toSetup());
      const uci = makeUci(move);
      const key = `${positionKey(fen)}|${uci}`;
      if (!seen.has(key)) {
        seen.add(key);
        lockMove(fen, uci);
        moveCount++;
      }

      pos.play(move);
    });
  }

  return {
    moves: moveCount,
    positions: new Set([...seen].map(k => k.split('|')[0])).size,
    errors,
  };
}

export function importPgn(pgn: string): ImportResult {
  const allGames = parsePgn(pgn);
  if (allGames.length === 0) {
    return { positions: 0, moves: 0, errors: ['No games found in PGN'], openingNames: [] };
  }

  // Group games by Event header to detect multi-opening exports
  const groups = new Map<string, Game<PgnNodeData>[]>();
  for (const game of allGames) {
    const name = eventName(game) ?? '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(game);
  }

  // If all games share the same event (or none), treat as one opening
  const distinctNames = [...groups.keys()];
  const isSingleOpening = distinctNames.length === 1;

  let totalMoves = 0;
  let totalPositions = 0;
  const allErrors: string[] = [];
  const openingNames: string[] = [];

  if (isSingleOpening) {
    const name = distinctNames[0] || undefined;
    const openingName = createOpening(name);
    openingNames.push(openingName);
    const result = importGames(allGames, new Set());
    totalMoves = result.moves;
    totalPositions = result.positions;
    allErrors.push(...result.errors);
  } else {
    // Multiple distinct events → create one opening per event
    for (const [name, games] of groups) {
      const openingName = createOpening(name || undefined);
      openingNames.push(openingName);
      const result = importGames(games, new Set());
      totalMoves += result.moves;
      totalPositions += result.positions;
      allErrors.push(...result.errors);
    }
  }

  // Switch to the last created opening
  if (openingNames.length > 0) {
    switchOpening(openingNames[openingNames.length - 1]);
  }

  return {
    positions: totalPositions,
    moves: totalMoves,
    errors: allErrors,
    openingNames,
  };
}
