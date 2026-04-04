export interface Card {
    color: string;
    value: string;
    id: string;
}

export interface UnoPlayer {
    userId: string;
    username: string;
}

export interface KickedPlayer extends UnoPlayer {
    cardsLeft: number;
    pointsInHand: number;
    hand: Card[];
    socketId: string | null;
    abandon?: boolean;
    afk?: boolean;
}

export interface GameOptions {
    stackable: boolean;
    jumpIn: boolean;
    teamMode: 'none' | '2v2';
    teamWinMode: 'one' | 'both';
}

export interface FinalScore {
    userId: string;
    username: string;
    cardsLeft: number;
    pointsInHand: number;
    hand: Card[];
    score: number;
    kicked: boolean;
    abandon?: boolean;
    afk?: boolean;
    team: number | null;
    rank: number;
}

export interface Lobby {
    hostId: string | null;
    status: 'WAITING' | 'PLAYING' | 'FINISHED';
    players: UnoPlayer[];
    spectators: UnoPlayer[];
    hands: Map<string, Card[]>;
    deck: Card[];
    discardPile: Card[];
    currentColor: string | null;
    currentPlayerIndex: number;
    direction: number;
    drawStack: number;
    saidUno: Set<string>;
    socketMap: Map<string, string>;
    options: GameOptions;
    winner: { userId: string; username: string } | null;
    finalScores: FinalScore[] | null;
    kickedPlayers: KickedPlayer[];
    expectedCount: number | null;
    botCount: number;
    inactivityWarning: ReturnType<typeof setTimeout> | null;
    inactivityKick: ReturnType<typeof setTimeout> | null;
    turnStartedAt: number | null;
    teams: Map<string, number> | null;
    preAssignedTeams: Map<string, number> | null;
    disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    currentGameId?: string;
}
