// uno-server/src/index.ts
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { createGameServer } from '@kwizar/shared';

import { Lobby, GameOptions } from './types';
import {
    STARTING_HAND, UNO_PENALTY,
    createDeck, canPlay, nextPlayerIndex,
    drawCards, assignTeams, checkTeamWinner, computeFinalScores,
} from './game';
import { emitGameState, emitFinalState, emitLobbyState, buildSpectatorState } from './state';
import { clearInactivityTimer, startInactivityTimer, timerCallbacks } from './timer';
import { chooseBotColor, botChooseCard } from './bot';
import { lobbies, resetLobby } from './rooms';
import { saveUnoAttempts } from './api';
import { pushLog } from '@kwizar/shared';
import type { Card } from './types';

const COLOR_FR: Record<string, string> = { red: 'Rouge', green: 'Vert', blue: 'Bleu', yellow: 'Jaune', wild: 'Joker' };
const VALUE_FR: Record<string, string> = { skip: 'Passe', reverse: 'Inversion', draw2: '+2', wild: 'Joker', wild4: '+4' };
function cardLabel(card: Card, color?: string | null): string {
    if (card.value === 'wild' || card.value === 'wild4') {
        const c = color && COLOR_FR[color] ? ` (${COLOR_FR[color]})` : '';
        return `${VALUE_FR[card.value]}${c}`;
    }
    const v = VALUE_FR[card.value] ?? card.value;
    return `${COLOR_FR[card.color] ?? card.color} ${v}`;
}
function uname(lobby: Lobby, userId: string): string {
    return lobby.players.find(p => p.userId === userId)?.username ?? '?';
}

// ── Server setup ───────────────────────────────────────────────────────────────


const { io, lobbySocket, listen } = createGameServer({ serviceName: 'uno-server', gameType: 'uno', defaultPort: 10001 });

// ── Wire up timer callbacks ────────────────────────────────────────────────────

timerCallbacks.getLobby = (lobbyId) => lobbies.get(lobbyId);
timerCallbacks.handleLeave = (lobbyId, userId, isKick) => handleLeave(lobbyId, userId, isKick);

// ── Game flow ──────────────────────────────────────────────────────────────────

function finishGame(lobbyId: string, lobby: Lobby, winnerId: string): void {
    clearInactivityTimer(lobby);
    const winner = lobby.players.find(p => p.userId === winnerId)
        ?? lobby.kickedPlayers?.find(p => p.userId === winnerId);
    lobby.status = 'FINISHED';
    lobby.winner = { userId: winnerId, username: winner?.username ?? '?' };
    pushLog(lobby, 'coup', `${lobby.winner.username} gagne la partie !`);
    lobby.finalScores = computeFinalScores(lobby, winnerId);
    emitLobbyState(io, lobbyId, lobby);
    emitFinalState(io, lobbyId, lobby);
    io.to(`uno:${lobbyId}`).emit('uno:finished', {
        winnerId: lobby.winner?.userId,
        winnerUsername: lobby.winner?.username,
    });
    saveUnoAttempts(io, `uno:${lobbyId}`, lobby.currentGameId ?? lobbyId, lobby.finalScores);
}

function checkWinner(lobbyId: string, lobby: Lobby): boolean {
    if (lobby.options.teamMode === '2v2' && lobby.teams) {
        const winnerId = checkTeamWinner(lobby);
        if (winnerId) { finishGame(lobbyId, lobby, winnerId); return true; }
        return false;
    }
    for (const [userId, hand] of lobby.hands) {
        if (hand.length === 0) { finishGame(lobbyId, lobby, userId); return true; }
    }
    return false;
}

function startGame(lobbyId: string, lobby: Lobby): void {
    if (lobby.status !== 'WAITING') return;
    if (lobby.players.length < 2) return;
    if (lobby.options.teamMode === '2v2' && lobby.players.length !== 4) return;

    lobby.currentGameId = randomUUID();
    lobby.deck = createDeck();
    lobby.hands = new Map();
    lobby.discardPile = [];
    lobby.saidUno = new Set();
    lobby.drawStack = 0;
    lobby.direction = 1;
    const startIdx = Math.floor(Math.random() * lobby.players.length);
    lobby.currentPlayerIndex = startIdx;
    lobby.winner = null;
    lobby.finalScores = null;
    lobby.kickedPlayers = [];
    lobby.status = 'PLAYING';
    lobby.teams = null;

    if (lobby.options.teamMode === '2v2') {
        if (lobby.preAssignedTeams && lobby.preAssignedTeams.size === lobby.players.length) {
            lobby.teams = new Map(lobby.preAssignedTeams);
        } else {
            assignTeams(lobby);
        }
    }

    for (const p of lobby.players) {
        drawCards(lobby, p.userId, STARTING_HAND);
    }

    let firstCard: ReturnType<typeof createDeck>[0];
    do { firstCard = lobby.deck.pop()!; } while (firstCard.color === 'wild');
    lobby.discardPile.push(firstCard);
    lobby.currentColor = firstCard.color;

    if (firstCard.value === 'skip') {
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, startIdx, lobby.direction, true);
    } else if (firstCard.value === 'reverse') {
        lobby.direction = -1;
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, startIdx, lobby.direction);
    } else if (firstCard.value === 'draw2') {
        const nextIdx = nextPlayerIndex(lobby, startIdx, lobby.direction);
        drawCards(lobby, lobby.players[nextIdx].userId, 2);
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
    }

    emitLobbyState(io, lobbyId, lobby);
    emitGameState(io, lobbyId, lobby);
    startInactivityTimer(io, lobbyId, lobby);
    triggerBotIfNeeded(lobbyId, lobby);
}

function handleLeave(lobbyId: string, userId: string, isKick = false): void {
    if (!lobbyId || !userId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    lobby.socketMap.delete(userId);

    if (lobby.spectators) {
        lobby.spectators = lobby.spectators.filter(s => s.userId !== userId);
    }

    const removedIndex = lobby.players.findIndex(p => p.userId === userId);
    const wasCurrentPlayer = removedIndex === lobby.currentPlayerIndex;  // ← nouveau

    lobby.players = lobby.players.filter(p => p.userId !== userId);
    lobby.hands.delete(userId);

    if (lobby.players.length === 0) {
        clearInactivityTimer(lobby);
        lobbies.delete(lobbyId);
        return;
    }

    if (lobby.hostId === userId) {
        lobby.hostId = lobby.players[0].userId;
    }

    if (lobby.status === 'PLAYING') {
        if (removedIndex !== -1 && removedIndex < lobby.currentPlayerIndex) {
            lobby.currentPlayerIndex -= 1;
        }
        if (lobby.currentPlayerIndex >= lobby.players.length) {
            lobby.currentPlayerIndex = 0;
        }
        if (lobby.players.length === 1) {
            finishGame(lobbyId, lobby, lobby.players[0].userId);
            return;
        }
        if (lobby.players.every(p => p.userId.startsWith('bot-'))) {
            finishGame(lobbyId, lobby, lobby.players[0].userId);
            return;
        }

        // ← Si c'était le tour du joueur exclu, on passe au suivant
        if (wasCurrentPlayer) {
            if (lobby.currentPlayerIndex >= lobby.players.length) {
                lobby.currentPlayerIndex = 0;
            }
            startInactivityTimer(io, lobbyId, lobby);
            emitGameState(io, lobbyId, lobby);
            triggerBotIfNeeded(lobbyId, lobby);  // ← déclenche le bot si nécessaire
            emitLobbyState(io, lobbyId, lobby);
            return;
        }

        startInactivityTimer(io, lobbyId, lobby);
        emitGameState(io, lobbyId, lobby);
    }

    emitLobbyState(io, lobbyId, lobby);
}

// ── Bot AI ─────────────────────────────────────────────────────────────────────

function triggerBotIfNeeded(lobbyId: string, lobby: Lobby): void {
    if (lobby.status !== 'PLAYING') return;
    const nextPlayer = lobby.players[lobby.currentPlayerIndex];
    if (nextPlayer?.userId.startsWith('bot-')) {
        setTimeout(() => botTakeTurn(lobbyId), 900);
    }
}

function botTakeTurn(lobbyId: string): void {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.status !== 'PLAYING') return;

    const currentPlayer = lobby.players[lobby.currentPlayerIndex];
    if (!currentPlayer?.userId.startsWith('bot-')) return;

    const botId = currentPlayer.userId;
    const hand = lobby.hands.get(botId) ?? [];
    const card = botChooseCard(lobby, botId);

    if (!card) {
        if (lobby.drawStack > 0) {
            pushLog(lobby, 'defend', `${uname(lobby, botId)} encaisse et pioche ${lobby.drawStack} cartes`);
            drawCards(lobby, botId, lobby.drawStack);
            lobby.drawStack = 0;
        } else {
            pushLog(lobby, 'move', `${uname(lobby, botId)} pioche une carte`);
            drawCards(lobby, botId, 1);
        }
        lobby.saidUno.delete(botId);
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, lobby.currentPlayerIndex, lobby.direction);
        startInactivityTimer(io, lobbyId, lobby);
        emitGameState(io, lobbyId, lobby);
        triggerBotIfNeeded(lobbyId, lobby);
        return;
    }

    const cardIndex = hand.findIndex(c => c.id === card.id);
    hand.splice(cardIndex, 1);
    lobby.hands.set(botId, hand);
    lobby.discardPile.push(card);

    if (hand.length === 1) lobby.saidUno.add(botId);
    else lobby.saidUno.delete(botId);

    const chosenColor = card.color === 'wild'
        ? chooseBotColor(hand.length > 0 ? hand : lobby.hands.get(botId) ?? [])
        : card.color;
    lobby.currentColor = chosenColor;
    pushLog(lobby, 'move', `${uname(lobby, botId)} joue ${cardLabel(card, lobby.currentColor)}`);

    if (checkWinner(lobbyId, lobby)) return;

    const curIdx = lobby.currentPlayerIndex;

    if (card.value === 'skip') {
        const skipped = lobby.players[nextPlayerIndex(lobby, curIdx, lobby.direction)];
        pushLog(lobby, 'attack', `${skipped?.username ?? '?'} passe son tour`);
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction, true);
    } else if (card.value === 'reverse') {
        lobby.direction *= -1;
        pushLog(lobby, 'system', 'Sens de jeu inversé');
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
    } else if (card.value === 'draw2') {
        if (lobby.options.stackable) {
            lobby.drawStack += 2;
            pushLog(lobby, 'attack', `Pioche cumulée : +${lobby.drawStack}`);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else {
            const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
            drawCards(lobby, lobby.players[nextIdx].userId, 2);
            pushLog(lobby, 'attack', `${lobby.players[nextIdx]?.username ?? '?'} pioche 2 cartes`);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
        }
    } else if (card.value === 'wild4') {
        if (lobby.options.stackable) {
            lobby.drawStack += 4;
            pushLog(lobby, 'attack', `Pioche cumulée : +${lobby.drawStack}`);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else {
            const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
            drawCards(lobby, lobby.players[nextIdx].userId, 4);
            pushLog(lobby, 'attack', `${lobby.players[nextIdx]?.username ?? '?'} pioche 4 cartes`);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
        }
    } else {
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
    }

    startInactivityTimer(io, lobbyId, lobby);
    emitGameState(io, lobbyId, lobby);
    triggerBotIfNeeded(lobbyId, lobby);
}



lobbySocket.on('uno:configure', ({ lobbyId, options, expectedCount, preAssignedTeams, botCount, bots, fresh, turnSeconds }: any, ack?: () => void) => {
    if (!lobbyId) return;
    let lobby = lobbies.get(lobbyId);

    const defaultOptions: GameOptions = {
        stackable: false,
        jumpIn: false,
        teamMode: 'none',
        teamWinMode: 'one',
    };
    const mergedOptions: GameOptions = { ...defaultOptions, ...(options ?? {}) };
    const botList: Array<{ userId: string; username: string }> = Array.isArray(bots) ? bots : [];
    const numBots = botList.length || Number(botCount ?? 0);

    const teamsMap = preAssignedTeams
        ? new Map(Object.entries(preAssignedTeams).map(([k, v]) => [k, Number(v)]))
        : null;

    if (!lobby) {
        lobby = {
            hostId: null,
            status: 'WAITING',
            players: [],
            spectators: [],
            hands: new Map(),
            deck: [],
            discardPile: [],
            currentColor: null,
            currentPlayerIndex: 0,
            direction: 1,
            drawStack: 0,
            saidUno: new Set(),
            socketMap: new Map(),
            options: mergedOptions,
            winner: null,
            finalScores: null,
            kickedPlayers: [],
            expectedCount: expectedCount ?? null,
            botCount: numBots,
            inactivityWarning: null,
            inactivityKick: null,
            turnStartedAt: null,
            teams: null,
            preAssignedTeams: teamsMap,
            disconnectTimers: new Map(),
            log: [],
            logSeq: 0,
        };
        lobbies.set(lobbyId, lobby);
    } else {
        if (fresh || lobby.status === 'FINISHED' || lobby.status === 'PLAYING') {
            resetLobby(lobby, mergedOptions);
        } else {
            lobby.options = mergedOptions;
        }
        if (expectedCount) lobby.expectedCount = expectedCount;
        if (teamsMap) lobby.preAssignedTeams = teamsMap;
        lobby.botCount = numBots;
    }
    if (turnSeconds !== undefined) lobby.turnSeconds = turnSeconds;

    // Pré-ajouter les bots comme joueurs
    const existingBots = lobby.players.filter(p => p.userId.startsWith('bot-'));
    if (existingBots.length === 0 && numBots > 0) {
        if (botList.length > 0) {
            for (const b of botList) lobby.players.push({ userId: b.userId, username: b.username });
        } else {
            for (let i = 0; i < numBots; i++) {
                lobby.players.push({
                    userId: `bot-uno-${randomUUID()}`,
                    username: numBots === 1 ? '🤖 Bot 1' : `🤖 Bot ${i + 1}`,
                });
            }
        }
    }

    io.to(`uno:${lobbyId}`).emit('uno:ready', { lobbyId });

    // Tenter de démarrer si des joueurs sont déjà arrivés avant configure
    if (lobby.status === 'WAITING' && lobby.players.length > 0) {
        const humanCount = lobby.players.filter(p => !p.userId.startsWith('bot-')).length;
        const required = expectedCount ?? 2;
        if (humanCount >= required) {
            startGame(lobbyId, lobby);
        }
    }
    if (typeof ack === 'function') ack();
});

// ── Socket events ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('[UNO] connexion', socket.id);

    socket.on('uno:join', ({ lobbyId }) => {
        const { userId, username } = socket.data;
        if (!lobbyId || !userId) return;
        socket.data.lobbyId = lobbyId;
        socket.join(`uno:${lobbyId}`);

        const lobby = lobbies.get(lobbyId);
        if (!lobby) { socket.emit('notFound'); return; }

        if (!lobby.spectators) lobby.spectators = [];
        lobby.socketMap.set(userId, socket.id);
        if (!lobby.hostId) lobby.hostId = userId;

        if (lobby.status === 'FINISHED') {
            if (!lobby.spectators.find(s => s.userId === userId)) {
                lobby.spectators.push({ userId, username });
            }
            socket.emit('uno:state', buildSpectatorState(lobby));
            emitLobbyState(io, lobbyId, lobby);
            return;
        }

        if (lobby.status === 'PLAYING') {
            const isExpectedPlayer = lobby.players.find(p => p.userId === userId);
            if (isExpectedPlayer) {
                const pendingTimer = lobby.disconnectTimers?.get(userId);
                if (pendingTimer) {
                    clearTimeout(pendingTimer);
                    lobby.disconnectTimers.delete(userId);
                    io.to(`uno:${lobbyId}`).emit('uno:playerReconnected', { userId });
                }
                emitGameState(io, lobbyId, lobby);
                emitLobbyState(io, lobbyId, lobby);
                return;
            }
            if (!lobby.spectators.find(s => s.userId === userId)) {
                lobby.spectators.push({ userId, username });
            }
            socket.emit('uno:state', buildSpectatorState(lobby));
            emitLobbyState(io, lobbyId, lobby);
            return;
        }

        // Status WAITING
        if (!lobby.players.find(p => p.userId === userId)) {
            lobby.players.push({ userId, username });
        }
        emitLobbyState(io, lobbyId, lobby);

        if (lobby.expectedCount !== null) {
            const humanCount = lobby.players.filter(p => !p.userId.startsWith('bot-')).length;
            if (humanCount >= lobby.expectedCount) {
                startGame(lobbyId, lobby);
            }
        }
    });

    socket.on('uno:playCard', ({ cardId, chosenColor, sayUno }) => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== 'PLAYING') return;
        if (lobby.spectators?.find(s => s.userId === userId)) return;

        const currentPlayer = lobby.players[lobby.currentPlayerIndex];
        const isJumpIn = lobby.options.jumpIn && currentPlayer.userId !== userId;
        if (!isJumpIn && currentPlayer.userId !== userId) return;

        const hand = lobby.hands.get(userId) ?? [];
        const cardIndex = hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;
        const card = hand[cardIndex];
        const topCard = lobby.discardPile[lobby.discardPile.length - 1];

        if (!isJumpIn) {
            if (lobby.drawStack > 0 && !lobby.options.stackable) {
                const canStack = (card.value === 'draw2' && topCard.value === 'draw2') || card.value === 'wild4';
                if (!canStack) return;
            }
            if (lobby.drawStack > 0 && lobby.options.stackable) {
                const canStack = card.value === 'draw2' || card.value === 'wild4';
                if (!canStack && !canPlay(card, topCard, lobby.currentColor!)) return;
            }
            if (lobby.drawStack === 0 && !canPlay(card, topCard, lobby.currentColor!)) return;
        } else {
            if (card.color !== topCard.color || card.value !== topCard.value) return;
        }

        hand.splice(cardIndex, 1);
        lobby.hands.set(userId, hand);
        lobby.discardPile.push(card);

        if (sayUno && hand.length === 1) lobby.saidUno.add(userId);
        else lobby.saidUno.delete(userId);

        lobby.currentColor = card.color === 'wild' ? (chosenColor ?? 'red') : card.color;
        pushLog(lobby, 'move', `${uname(lobby, userId)} joue ${cardLabel(card, lobby.currentColor)}`);

        if (checkWinner(lobbyId, lobby)) return;

        if (isJumpIn) {
            lobby.currentPlayerIndex = lobby.players.findIndex(p => p.userId === userId);
        }

        const curIdx = lobby.currentPlayerIndex;

        if (card.value === 'skip') {
            const skipped = lobby.players[nextPlayerIndex(lobby, curIdx, lobby.direction)];
            pushLog(lobby, 'attack', `${skipped?.username ?? '?'} passe son tour`);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction, true);
        } else if (card.value === 'reverse') {
            lobby.direction *= -1;
            pushLog(lobby, 'system', 'Sens de jeu inversé');
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else if (card.value === 'draw2') {
            if (lobby.options.stackable) {
                lobby.drawStack += 2;
                pushLog(lobby, 'attack', `Pioche cumulée : +${lobby.drawStack}`);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
            } else {
                const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
                drawCards(lobby, lobby.players[nextIdx].userId, 2);
                pushLog(lobby, 'attack', `${lobby.players[nextIdx]?.username ?? '?'} pioche 2 cartes`);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
            }
        } else if (card.value === 'wild4') {
            if (lobby.options.stackable) {
                lobby.drawStack += 4;
                pushLog(lobby, 'attack', `Pioche cumulée : +${lobby.drawStack}`);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
            } else {
                const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
                drawCards(lobby, lobby.players[nextIdx].userId, 4);
                pushLog(lobby, 'attack', `${lobby.players[nextIdx]?.username ?? '?'} pioche 4 cartes`);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
            }
        } else {
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        }

        // Pénalité auto si le joueur passe à 1 carte sans avoir dit UNO
        if (hand.length === 1 && !lobby.saidUno.has(userId)) {
            drawCards(lobby, userId, UNO_PENALTY);
            io.to(`uno:${lobbyId}`).emit('uno:penaltyApplied', { targetId: userId, reason: 'forgot_uno', cards: UNO_PENALTY });
        }

        startInactivityTimer(io, lobbyId, lobby);
        emitGameState(io, lobbyId, lobby);
        triggerBotIfNeeded(lobbyId, lobby);
    });

    socket.on('uno:drawCard', () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== 'PLAYING') return;
        if (lobby.spectators?.find(s => s.userId === userId)) return;

        const currentPlayer = lobby.players[lobby.currentPlayerIndex];
        if (currentPlayer.userId !== userId) return;

        if (lobby.drawStack > 0) {
            pushLog(lobby, 'defend', `${uname(lobby, userId)} encaisse et pioche ${lobby.drawStack} cartes`);
            drawCards(lobby, userId, lobby.drawStack);
            lobby.drawStack = 0;
        } else {
            pushLog(lobby, 'move', `${uname(lobby, userId)} pioche une carte`);
            drawCards(lobby, userId, 1);
        }

        lobby.saidUno.delete(userId);
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, lobby.currentPlayerIndex, lobby.direction);
        startInactivityTimer(io, lobbyId, lobby);
        emitGameState(io, lobbyId, lobby);
        triggerBotIfNeeded(lobbyId, lobby);
    });

    socket.on('uno:sayUno', () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (lobby.spectators?.find(s => s.userId === userId)) return;
        lobby.saidUno.add(userId);
        emitGameState(io, lobbyId, lobby);
    });

    socket.on('uno:callUno', ({ targetId }) => {
        const { lobbyId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        const targetHand = lobby.hands.get(targetId) ?? [];
        if (targetHand.length === 1 && !lobby.saidUno.has(targetId)) {
            drawCards(lobby, targetId, UNO_PENALTY);
            io.to(`uno:${lobbyId}`).emit('uno:penaltyApplied', { targetId, reason: 'forgot_uno', cards: UNO_PENALTY });
            emitGameState(io, lobbyId, lobby);
        }
    });

    socket.on('uno:restart', () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        clearInactivityTimer(lobby);
        lobby.status = 'WAITING';
        lobby.winner = null;
        lobby.finalScores = null;
        lobby.kickedPlayers = [];
        lobby.spectators = [];
        lobby.hands = new Map();
        lobby.deck = [];
        lobby.discardPile = [];
        lobby.saidUno = new Set();
        lobby.drawStack = 0;
        lobby.teams = null;
        lobby.log = [];
        lobby.logSeq = 0;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('uno:surrender', () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (lobby && lobby.status === 'PLAYING' && userId) {
            const player = lobby.players.find(p => p.userId === userId);
            if (player) {
                const hand = lobby.hands.get(userId) ?? [];
                if (!lobby.kickedPlayers) lobby.kickedPlayers = [];
                lobby.kickedPlayers.push({
                    userId: player.userId,
                    username: player.username,
                    cardsLeft: hand.length,
                    pointsInHand: hand.reduce((s, c) => {
                        if (c.value === 'wild' || c.value === 'wild4') return s + 50;
                        if (['skip', 'reverse', 'draw2'].includes(c.value)) return s + 20;
                        return s + (parseInt(c.value, 10) || 0);
                    }, 0),
                    hand,
                    socketId: socket.id,
                    abandon: true,
                });
                pushLog(lobby, 'system', `${player.username} abandonne la partie`);
            }
        }
        handleLeave(lobbyId, userId);
    });

    socket.on('uno:leave', () => {
        const { lobbyId, userId } = socket.data || {};
        handleLeave(lobbyId, userId);
    });

    socket.on('disconnect', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== 'PLAYING') {
            handleLeave(lobbyId, userId);
            return;
        }
        if (!lobby.disconnectTimers) lobby.disconnectTimers = new Map();
        const existing = lobby.disconnectTimers.get(userId);
        if (existing) clearTimeout(existing);
        const player = lobby.players.find(p => p.userId === userId);
        if (player) {
            io.to(`uno:${lobbyId}`).emit('uno:inactivityWarning', { userId, username: player.username, secondsLeft: 60 });
        }
        const timer = setTimeout(() => {
            lobby.disconnectTimers.delete(userId);
            const lob = lobbies.get(lobbyId);
            if (lob && lob.status === 'PLAYING') {
                const p = lob.players.find(p => p.userId === userId);
                if (p) {
                    const hand = lob.hands.get(userId) ?? [];
                    if (!lob.kickedPlayers) lob.kickedPlayers = [];
                    lob.kickedPlayers.push({
                        userId: p.userId,
                        username: p.username,
                        cardsLeft: hand.length,
                        pointsInHand: hand.reduce((s, c) => {
                            if (c.value === 'wild' || c.value === 'wild4') return s + 50;
                            if (['skip', 'reverse', 'draw2'].includes(c.value)) return s + 20;
                            return s + (parseInt(c.value, 10) || 0);
                        }, 0),
                        hand,
                        socketId: null,
                        afk: true,
                    });
                }
            }
            handleLeave(lobbyId, userId);
        }, 60_000);
        lobby.disconnectTimers.set(userId, timer);
    });
});

// ── Start ──────────────────────────────────────────────────────────────────────

listen();

