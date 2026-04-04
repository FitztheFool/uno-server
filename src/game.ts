import { Card, FinalScore, Lobby, UnoPlayer } from './types';

// ── Constants ──────────────────────────────────────────────────────────────────

export const COLORS = ['red', 'green', 'blue', 'yellow'];
export const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
export const WILD_VALUES = ['wild', 'wild4'];
export const STARTING_HAND = 7;
export const UNO_PENALTY = 2;

// ── Deck helpers ───────────────────────────────────────────────────────────────

export function cardPoints(card: Card): number {
    if (card.value === 'wild' || card.value === 'wild4') return 50;
    if (card.value === 'skip' || card.value === 'reverse' || card.value === 'draw2') return 20;
    return parseInt(card.value, 10) || 0;
}

export function handPoints(hand: Card[]): number {
    return hand.reduce((sum, card) => sum + cardPoints(card), 0);
}

export function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function createDeck(): Card[] {
    const deck: Card[] = [];
    for (const color of COLORS) {
        for (const value of VALUES) {
            deck.push({ color, value, id: `${color}_${value}_1` });
            if (value !== '0') deck.push({ color, value, id: `${color}_${value}_2` });
        }
    }
    for (const value of WILD_VALUES) {
        for (let i = 0; i < 4; i++) {
            deck.push({ color: 'wild', value, id: `${value}_${i}` });
        }
    }
    return shuffle(deck);
}

export function canPlay(card: Card, topCard: Card, currentColor: string): boolean {
    if (card.value === 'wild' || card.value === 'wild4') return true;
    if (card.color === currentColor) return true;
    if (card.value === topCard.value) return true;
    return false;
}

export function nextPlayerIndex(lobby: Lobby, currentIndex: number, direction: number, skip = false): number {
    const n = lobby.players.length;
    const step = skip ? 2 : 1;
    return ((currentIndex + direction * step) % n + n) % n;
}

export function drawCards(lobby: Lobby, userId: string, count: number): Card[] {
    const hand = lobby.hands.get(userId) ?? [];
    for (let i = 0; i < count; i++) {
        if (lobby.deck.length === 0) {
            const top = lobby.discardPile.pop()!;
            lobby.deck = shuffle(lobby.discardPile);
            lobby.discardPile = [top];
        }
        if (lobby.deck.length > 0) hand.push(lobby.deck.pop()!);
    }
    lobby.hands.set(userId, hand);
    return hand;
}

// ── 2v2 helpers ────────────────────────────────────────────────────────────────

export function assignTeams(lobby: Lobby): void {
    const players = shuffle([...lobby.players]);
    lobby.teams = new Map();
    for (let i = 0; i < players.length; i++) {
        lobby.teams.set(players[i].userId, i < 2 ? 0 : 1);
    }
}

export function getTeammate(lobby: Lobby, userId: string): UnoPlayer | null {
    if (!lobby.teams) return null;
    const myTeam = lobby.teams.get(userId);
    if (myTeam === undefined) return null;
    return lobby.players.find(p => p.userId !== userId && lobby.teams!.get(p.userId) === myTeam) ?? null;
}

export function getTeamOf(lobby: Lobby, userId: string): number | null {
    return lobby.teams?.get(userId) ?? null;
}

export function checkTeamWinner(lobby: Lobby): string | null {
    if (!lobby.teams) return null;
    for (const teamIdx of [0, 1]) {
        const teamPlayers = lobby.players.filter(p => lobby.teams!.get(p.userId) === teamIdx);
        if (teamPlayers.length === 0) continue;
        if (lobby.options.teamWinMode === 'one') {
            const winner = teamPlayers.find(p => (lobby.hands.get(p.userId) ?? []).length === 0);
            if (winner) return winner.userId;
        } else {
            const allEmpty = teamPlayers.every(p => (lobby.hands.get(p.userId) ?? []).length === 0);
            if (allEmpty) return teamPlayers[0].userId;
        }
    }
    return null;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

export function computeFinalScores(lobby: Lobby, winnerId: string): FinalScore[] {
    const allEntries: FinalScore[] = [];
    const is2v2 = lobby.options.teamMode === '2v2' && lobby.teams;
    const winnerTeam = is2v2 ? lobby.teams!.get(winnerId) : null;

    for (const player of lobby.players) {
        const hand = lobby.hands.get(player.userId) ?? [];
        const pts = handPoints(hand);
        allEntries.push({
            userId: player.userId,
            username: player.username,
            cardsLeft: hand.length,
            pointsInHand: pts,
            hand,
            score: 0,
            kicked: false,
            team: lobby.teams?.get(player.userId) ?? null,
            rank: 0,
        });
    }

    for (const kicked of (lobby.kickedPlayers ?? [])) {
        allEntries.push({
            userId: kicked.userId,
            username: kicked.username,
            cardsLeft: kicked.cardsLeft,
            pointsInHand: kicked.pointsInHand,
            hand: kicked.hand ?? [],
            score: 0,
            kicked: true,
            abandon: kicked.abandon ?? false,
            afk: kicked.afk ?? false,
            team: lobby.teams?.get(kicked.userId) ?? null,
            rank: 0,
        });
    }

    if (is2v2) {
        const losingTeamPoints = allEntries
            .filter(e => lobby.teams!.get(e.userId) !== winnerTeam)
            .reduce((sum, e) => sum + e.pointsInHand, 0);
        for (const e of allEntries) {
            if (lobby.teams!.get(e.userId) === winnerTeam) e.score = losingTeamPoints;
        }
        allEntries.sort((a, b) => {
            const aWins = lobby.teams!.get(a.userId) === winnerTeam;
            const bWins = lobby.teams!.get(b.userId) === winnerTeam;
            if (aWins !== bWins) return aWins ? -1 : 1;
            if (a.kicked !== b.kicked) return a.kicked ? 1 : -1;
            return a.pointsInHand - b.pointsInHand;
        });
    } else {
        const totalOpponentPoints = allEntries
            .filter(e => e.userId !== winnerId)
            .reduce((sum, e) => sum + e.pointsInHand, 0);
        const winner = allEntries.find(e => e.userId === winnerId);
        if (winner) winner.score = totalOpponentPoints;
        allEntries.sort((a, b) => {
            if (a.userId === winnerId) return -1;
            if (b.userId === winnerId) return 1;
            if (a.kicked !== b.kicked) return a.kicked ? 1 : -1;
            return a.pointsInHand - b.pointsInHand;
        });
    }

    return allEntries.map((e, i) => ({ ...e, rank: i + 1 }));
}
