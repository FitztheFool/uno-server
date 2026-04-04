// uno-server/src/index.ts
import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { jwtVerify } from 'jose';

import { Lobby, GameOptions } from './types';
import {
    STARTING_HAND, UNO_PENALTY,
    createDeck, shuffle, canPlay, nextPlayerIndex,
    drawCards, assignTeams, checkTeamWinner, computeFinalScores,
} from './game';
import { emitGameState, emitFinalState, emitLobbyState, buildSpectatorState } from './state';
import { clearInactivityTimer, startInactivityTimer, timerCallbacks } from './timer';
import { chooseBotColor, botChooseCard } from './bot';
import { lobbies, resetLobby } from './rooms';
import { saveUnoAttempts } from './api';

// ── Server setup ───────────────────────────────────────────────────────────────

const app = express();
app.get('/health', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

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
    lobby.finalScores = computeFinalScores(lobby, winnerId);
    emitLobbyState(io, lobbyId, lobby);
    emitFinalState(io, lobbyId, lobby);
    io.to(`uno:${lobbyId}`).emit('uno:finished', {
        winnerId: lobby.winner?.userId,
        winnerUsername: lobby.winner?.username,
    });
    saveUnoAttempts(lobby.currentGameId ?? lobbyId, lobby.finalScores);
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
            drawCards(lobby, botId, lobby.drawStack);
            lobby.drawStack = 0;
        } else {
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

    if (checkWinner(lobbyId, lobby)) return;

    const curIdx = lobby.currentPlayerIndex;

    if (card.value === 'skip') {
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction, true);
    } else if (card.value === 'reverse') {
        lobby.direction *= -1;
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
    } else if (card.value === 'draw2') {
        if (lobby.options.stackable) {
            lobby.drawStack += 2;
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else {
            const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
            drawCards(lobby, lobby.players[nextIdx].userId, 2);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
        }
    } else if (card.value === 'wild4') {
        if (lobby.options.stackable) {
            lobby.drawStack += 4;
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else {
            const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
            drawCards(lobby, lobby.players[nextIdx].userId, 4);
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
        }
    } else {
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
    }

    startInactivityTimer(io, lobbyId, lobby);
    emitGameState(io, lobbyId, lobby);
    triggerBotIfNeeded(lobbyId, lobby);
}

// ── Auth middleware ────────────────────────────────────────────────────────────

const SOCKET_SECRET = new TextEncoder().encode(process.env.INTERNAL_API_KEY!);

io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('auth_required'));
    try {
        const { payload } = await jwtVerify(token, SOCKET_SECRET);
        socket.data.userId = payload.sub as string;
        socket.data.username = payload.username as string;
        next();
    } catch {
        next(new Error('invalid_token'));
    }
});

// ── Socket events ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('nouvelle connexion uno', socket.id);

    socket.on('uno:configure', ({ lobbyId, options, expectedCount, preAssignedTeams, botCount }, ack) => {
        if (!lobbyId) return;
        let lobby = lobbies.get(lobbyId);

        const defaultOptions: GameOptions = {
            stackable: false,
            jumpIn: false,
            teamMode: 'none',
            teamWinMode: 'one',
        };
        const mergedOptions: GameOptions = { ...defaultOptions, ...(options ?? {}) };
        const numBots = Number(botCount ?? 0);

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
            };
            lobbies.set(lobbyId, lobby);
        } else {
            if (lobby.status === 'FINISHED' || lobby.status === 'PLAYING') {
                resetLobby(lobby, mergedOptions);
            } else {
                lobby.options = mergedOptions;
            }
            if (expectedCount) lobby.expectedCount = expectedCount;
            if (teamsMap) lobby.preAssignedTeams = teamsMap;
            lobby.botCount = numBots;
        }

        // Pré-ajouter les bots comme joueurs
        const existingBots = lobby.players.filter(p => p.userId.startsWith('bot-'));
        if (existingBots.length === 0 && numBots > 0) {
            for (let i = 0; i < numBots; i++) {
                lobby.players.push({
                    userId: `bot-uno-${randomUUID()}`,
                    username: numBots === 1 ? '🤖 Bot 1' : `🤖 Bot ${i + 1}`,
                });
            }
        }

        io.to(`uno:${lobbyId}`).emit('uno:ready', { lobbyId });

        // Tenter de démarrer si des joueurs sont déjà arrivés avant configure
        if (lobby.status === 'WAITING' && lobby.players.length > 0) {
            const humanCount = lobby.players.filter(p => !p.userId.startsWith('bot-')).length;
            const required = mergedOptions.teamMode === '2v2' ? 4 : (expectedCount ?? 2);
            if (humanCount >= required) {
                startGame(lobbyId, lobby);
            }
        }
        if (typeof ack === 'function') ack();
    });

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
                if (pendingTimer) { clearTimeout(pendingTimer); lobby.disconnectTimers.delete(userId); }
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
            const requiredPlayers = lobby.options.teamMode === '2v2' ? 4 : lobby.expectedCount;
            if (humanCount >= requiredPlayers) {
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

        if (checkWinner(lobbyId, lobby)) return;

        if (isJumpIn) {
            lobby.currentPlayerIndex = lobby.players.findIndex(p => p.userId === userId);
        }

        const curIdx = lobby.currentPlayerIndex;

        if (card.value === 'skip') {
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction, true);
        } else if (card.value === 'reverse') {
            lobby.direction *= -1;
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else if (card.value === 'draw2') {
            if (lobby.options.stackable) {
                lobby.drawStack += 2;
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
            } else {
                const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
                drawCards(lobby, lobby.players[nextIdx].userId, 2);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
            }
        } else if (card.value === 'wild4') {
            if (lobby.options.stackable) {
                lobby.drawStack += 4;
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
            } else {
                const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
                drawCards(lobby, lobby.players[nextIdx].userId, 4);
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
            drawCards(lobby, userId, lobby.drawStack);
            lobby.drawStack = 0;
        } else {
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
        const timer = setTimeout(() => {
            lobby.disconnectTimers.delete(userId);
            handleLeave(lobbyId, userId);
        }, 10000);
        lobby.disconnectTimers.set(userId, timer);
    });
});

// ── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 10001;
server.listen(PORT, () => console.log('[UNO] realtime listening on', PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
