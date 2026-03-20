export type PlayerColor = 'white' | 'black' | 'both';

export type GamePhase =
  | 'USER_TURN'
  | 'BOT_THINKING'
  | 'OUT_OF_BOOK'
  | 'GAME_OVER';

export interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number;
}

export interface ExplorerResponse {
  opening?: { eco: string; name: string } | null;
  moves: ExplorerMove[];
}

export interface OpeningEntry {
  lockedMoves: string[]; // UCI strings
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  spreadThreshold: 12,
  comfortThreshold: 55,
  blunderDeficit: 10,
  popularThresholdPct: 15,
  minGames: 50,
};

export type BotWeighting = 'weighted' | 'equal';
export type PlayMode = 'strict' | 'relaxed' | 'drill';

export type AlertType = 'danger' | 'opportunity' | 'trap';
export const ALL_ALERT_TYPES: AlertType[] = ['danger', 'opportunity', 'trap'];

export interface AppConfig {
  ratings: number[];
  speeds: string[];
  topMoves: number;
  playerColor: PlayerColor;
  botWeighting: BotWeighting;
  botMinPlayRatePct: number;
  enabledAlerts: AlertType[];
  engineLineCount: number;
  lichessToken: string;
  playMode: PlayMode;
}

export const DEFAULT_CONFIG: AppConfig = {
  ratings: [1600, 1800, 2000, 2200, 2500],
  speeds: ['blitz', 'rapid', 'classical'],
  topMoves: 5,
  playerColor: 'white',
  botWeighting: 'weighted',
  botMinPlayRatePct: 5,
  enabledAlerts: ['danger', 'opportunity', 'trap'],
  engineLineCount: 1,
  lichessToken: '',
  playMode: 'relaxed',
};

export const RATING_OPTIONS = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
export const SPEED_OPTIONS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

export interface MoveHistoryEntry {
  san: string;
  uci: string;
  fen: string;
}

export type PositionAlert = 'danger' | 'opportunity' | 'trap' | null;
export type MoveBadge = 'best' | 'blunder' | 'trap' | 'book' | null;

export interface PositionAnalysis {
  alert: PositionAlert;
  bestMoveUci: string | null;
  bestWinPct: number;
  moveBadges: Map<string, MoveBadge>;
}

export interface AlertThresholds {
  spreadThreshold: number;
  comfortThreshold: number;
  blunderDeficit: number;
  popularThresholdPct: number;
  minGames: number;
}
