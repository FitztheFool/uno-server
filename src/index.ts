// uno-server/src/index.ts
import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

const COLORS = ["red", "green", "blue", "yellow"];
const VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
const WILD_VALUES = ["wild", "wild4"];
const STARTING_HAND = 7;
const UNO_PENALTY = 2;
const INACTIVITY_WARNING_MS = 30_000;
const INACTIVITY_KICK_MS = 60_000;

const lobbies = new Map();

function cardPoints(card) {
    if (card.value === "wild" || card.value === "wild4") return 50;
    if (card.value === "skip" || card.value === "reverse" || card.value === "draw2") return 20;
    return parseInt(card.value, 10) || 0;
}

function handPoints(hand) {
    return hand.reduce((sum, card) => sum + cardPoints(card), 0);
}

function createDeck() {
    const deck = [];
    for (const color of COLORS) {
        for (const value of VALUES) {
            deck.push({ color, value, id: `${color}_${value}_1` });
            if (value !== "0") deck.push({ color, value, id: `${color}_${value}_2` });
        }
    }
    for (const value of WILD_VALUES) {
        for (let i = 0; i < 4; i++) {
            deck.push({ color: "wild", value, id: `${value}_${i}` });
        }
    }
    return shuffle(deck);
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function canPlay(card, topCard, currentColor) {
    if (card.value === "wild" || card.value === "wild4") return true;
    if (card.color === currentColor) return true;
    if (card.value === topCard.value) return true;
    return false;
}

function nextPlayerIndex(lobby, currentIndex, direction, skip = false) {
    const n = lobby.players.length;
    const step = skip ? 2 : 1;
    return ((currentIndex + direction * step) % n + n) % n;
}

// ── 2v2 helpers ───────────────────────────────────────────────────────────────

/**
 * Assigne aléatoirement les équipes : team 0 et team 1 (2 joueurs chacune).
 * Stocké dans lobby.teams : Map<userId, 0|1>
 */
function assignTeams(lobby) {
    const players = shuffle([...lobby.players]);
    lobby.teams = new Map();
    for (let i = 0; i < players.length; i++) {
        lobby.teams.set(players[i].userId, i < 2 ? 0 : 1);
    }
}

function getTeammate(lobby, userId) {
    if (!lobby.teams) return null;
    const myTeam = lobby.teams.get(userId);
    if (myTeam === undefined) return null;
    return lobby.players.find(p => p.userId !== userId && lobby.teams.get(p.userId) === myTeam) ?? null;
}

function getTeamOf(lobby, userId) {
    return lobby.teams?.get(userId) ?? null;
}

/**
 * Vérifie si une équipe a gagné selon le mode de victoire.
 * teamWinMode: "one" (un joueur vide) | "both" (les deux vident)
 */
function checkTeamWinner(lobby) {
    if (!lobby.teams) return null;

    for (const teamIdx of [0, 1]) {
        const teamPlayers = lobby.players.filter(p => lobby.teams.get(p.userId) === teamIdx);
        if (teamPlayers.length === 0) continue;

        if (lobby.options.teamWinMode === "one") {
            // Un seul joueur de l'équipe doit avoir vidé sa main
            const winner = teamPlayers.find(p => (lobby.hands.get(p.userId) ?? []).length === 0);
            if (winner) return winner.userId;
        } else {
            // "both" : tous les joueurs de l'équipe doivent avoir vidé leur main
            const allEmpty = teamPlayers.every(p => (lobby.hands.get(p.userId) ?? []).length === 0);
            if (allEmpty) return teamPlayers[0].userId; // premier joueur comme représentant
        }
    }
    return null;
}

// ── State builders ────────────────────────────────────────────────────────────

function emitGameState(lobbyId, lobby) {
    for (const player of lobby.players) {
        const socketId = lobby.socketMap.get(player.userId);
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit("uno:state", buildStateFor(lobby, player.userId));
    }
    for (const spectator of (lobby.spectators ?? [])) {
        const socketId = lobby.socketMap.get(spectator.userId);
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit("uno:state", buildSpectatorState(lobby));
    }
    io.to(`uno:${lobbyId}`).emit("uno:publicState", buildPublicState(lobby));
}

function emitFinalState(lobbyId, lobby) {
    emitGameState(lobbyId, lobby);
    for (const kicked of (lobby.kickedPlayers ?? [])) {
        const socketId = kicked.socketId;
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit("uno:state", {
            hand: [],
            currentColor: lobby.currentColor,
            topCard: lobby.discardPile[lobby.discardPile.length - 1] ?? null,
            currentPlayerIndex: lobby.currentPlayerIndex,
            players: [],
            direction: lobby.direction,
            drawStack: 0,
            status: "FINISHED",
            winner: lobby.winner ?? null,
            finalScores: lobby.finalScores ?? [],
            options: lobby.options,
            isMyTurn: false,
            spectator: false,
            teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
            teammateHand: null,
        });
    }
}

function buildStateFor(lobby, userId) {
    // En mode 2v2, inclure les cartes du coéquipier
    let teammateHand = null;
    let teammateId = null;
    if (lobby.options.teamMode === "2v2" && lobby.teams) {
        const teammate = getTeammate(lobby, userId);
        if (teammate) {
            teammateId = teammate.userId;
            teammateHand = lobby.hands.get(teammate.userId) ?? [];
        }
    }

    return {
        hand: lobby.hands.get(userId) ?? [],
        currentColor: lobby.currentColor,
        topCard: lobby.discardPile[lobby.discardPile.length - 1] ?? null,
        currentPlayerIndex: lobby.currentPlayerIndex,
        players: lobby.players.map(p => ({
            userId: p.userId,
            username: p.username,
            cardCount: (lobby.hands.get(p.userId) ?? []).length,
            saidUno: lobby.saidUno.has(p.userId),
            team: lobby.teams?.get(p.userId) ?? null,
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        finalScores: lobby.finalScores ?? null,
        options: lobby.options,
        isMyTurn: lobby.players[lobby.currentPlayerIndex]?.userId === userId,
        spectator: false,
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
        teammateHand,
        teammateId,
        myTeam: getTeamOf(lobby, userId),
    };
}

function buildSpectatorState(lobby) {
    return {
        hand: [],
        currentColor: lobby.currentColor,
        topCard: lobby.discardPile[lobby.discardPile.length - 1] ?? null,
        currentPlayerIndex: lobby.currentPlayerIndex,
        players: lobby.players.map(p => ({
            userId: p.userId,
            username: p.username,
            cardCount: (lobby.hands.get(p.userId) ?? []).length,
            saidUno: lobby.saidUno.has(p.userId),
            team: lobby.teams?.get(p.userId) ?? null,
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        finalScores: lobby.finalScores ?? null,
        options: lobby.options,
        isMyTurn: false,
        spectator: true,
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
        teammateHand: null,
        teammateId: null,
        myTeam: null,
    };
}

function buildPublicState(lobby) {
    return {
        currentColor: lobby.currentColor,
        topCard: lobby.discardPile[lobby.discardPile.length - 1] ?? null,
        currentPlayerIndex: lobby.currentPlayerIndex,
        players: lobby.players.map(p => ({
            userId: p.userId,
            username: p.username,
            cardCount: (lobby.hands.get(p.userId) ?? []).length,
            saidUno: lobby.saidUno.has(p.userId),
            team: lobby.teams?.get(p.userId) ?? null,
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        options: lobby.options,
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
    };
}

function emitLobbyState(lobbyId, lobby) {
    io.to(`uno:${lobbyId}`).emit("uno:lobbyState", {
        hostId: lobby.hostId,
        status: lobby.status,
        players: lobby.players,
        options: lobby.options,
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
    });
}

// ── Game logic ────────────────────────────────────────────────────────────────

function drawCards(lobby, userId, count) {
    const hand = lobby.hands.get(userId) ?? [];
    for (let i = 0; i < count; i++) {
        if (lobby.deck.length === 0) {
            const top = lobby.discardPile.pop();
            lobby.deck = shuffle(lobby.discardPile);
            lobby.discardPile = [top];
        }
        if (lobby.deck.length > 0) hand.push(lobby.deck.pop());
    }
    lobby.hands.set(userId, hand);
    return hand;
}

function computeFinalScores(lobby, winnerId) {
    const allEntries = [];
    const is2v2 = lobby.options.teamMode === "2v2" && lobby.teams;
    const winnerTeam = is2v2 ? lobby.teams.get(winnerId) : null;

    for (const player of lobby.players) {
        const hand = lobby.hands.get(player.userId) ?? [];
        const pts = handPoints(hand);
        allEntries.push({
            userId: player.userId,
            username: player.username,
            cardsLeft: hand.length,
            pointsInHand: pts,
            hand: hand,
            score: 0,
            kicked: false,
            team: lobby.teams?.get(player.userId) ?? null,
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
        });
    }

    if (is2v2) {
        // En 2v2 : l'équipe gagnante reçoit la somme des points de l'équipe adverse
        const losingTeamPoints = allEntries
            .filter(e => lobby.teams.get(e.userId) !== winnerTeam)
            .reduce((sum, e) => sum + e.pointsInHand, 0);

        for (const e of allEntries) {
            if (lobby.teams.get(e.userId) === winnerTeam) {
                e.score = losingTeamPoints;
            }
        }

        // Tri : équipe gagnante d'abord, puis par points en main croissants
        allEntries.sort((a, b) => {
            const aWins = lobby.teams.get(a.userId) === winnerTeam;
            const bWins = lobby.teams.get(b.userId) === winnerTeam;
            if (aWins !== bWins) return aWins ? -1 : 1;
            if (a.kicked !== b.kicked) return a.kicked ? 1 : -1;
            return a.pointsInHand - b.pointsInHand;
        });
    } else {
        // Mode classique
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

async function saveAttempts(gameType, gameId, scores) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}

async function saveUnoAttempts(gameId, finalScores) {
    const scores = finalScores
        .filter(e => e.userId && e.userId.length > 8)
        .map(e => ({ userId: e.userId, score: e.score, placement: e.rank, abandon: e.abandon ?? false, afk: e.afk ?? false }));
    if (scores.length === 0) return;
    await saveAttempts("UNO", gameId, scores);
}

function finishGame(lobbyId, lobby, winnerId) {
    clearInactivityTimer(lobby);
    const winner = lobby.players.find(p => p.userId === winnerId)
        ?? lobby.kickedPlayers?.find(p => p.userId === winnerId);
    lobby.status = "FINISHED";
    lobby.winner = { userId: winnerId, username: winner?.username ?? "?" };
    lobby.finalScores = computeFinalScores(lobby, winnerId);
    emitLobbyState(lobbyId, lobby);
    emitFinalState(lobbyId, lobby);
    io.to(`uno:${lobbyId}`).emit('uno:finished', { winnerId: lobby.winner?.userId, winnerUsername: lobby.winner?.username });
    saveUnoAttempts(lobby.currentGameId ?? lobbyId, lobby.finalScores);
}

function checkWinner(lobbyId, lobby) {
    if (lobby.options.teamMode === "2v2" && lobby.teams) {
        const winnerId = checkTeamWinner(lobby);
        if (winnerId) {
            finishGame(lobbyId, lobby, winnerId);
            return true;
        }
        return false;
    }

    // Mode classique
    for (const [userId, hand] of lobby.hands) {
        if (hand.length === 0) {
            finishGame(lobbyId, lobby, userId);
            return true;
        }
    }
    return false;
}

function clearInactivityTimer(lobby) {
    if (lobby.inactivityWarning) { clearTimeout(lobby.inactivityWarning); lobby.inactivityWarning = null; }
    if (lobby.inactivityKick) { clearTimeout(lobby.inactivityKick); lobby.inactivityKick = null; }
}

function startInactivityTimer(lobbyId, lobby) {
    clearInactivityTimer(lobby);
    if (lobby.status !== "PLAYING") return;
    const currentPlayer = lobby.players[lobby.currentPlayerIndex];
    if (!currentPlayer) return;

    lobby.inactivityWarning = setTimeout(() => {
        io.to(`uno:${lobbyId}`).emit("uno:inactivityWarning", {
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            secondsLeft: 30,
        });
    }, INACTIVITY_WARNING_MS);

    lobby.inactivityKick = setTimeout(() => {
        const currentLobby = lobbies.get(lobbyId);
        if (!currentLobby || currentLobby.status !== "PLAYING") return;
        const stillCurrent = currentLobby.players[currentLobby.currentPlayerIndex];
        if (!stillCurrent || stillCurrent.userId !== currentPlayer.userId) return;

        io.to(`uno:${lobbyId}`).emit("uno:playerKicked", {
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            reason: "inactivity",
        });

        const hand = currentLobby.hands.get(currentPlayer.userId) ?? [];
        const socketId = currentLobby.socketMap.get(currentPlayer.userId) ?? null;
        if (!currentLobby.kickedPlayers) currentLobby.kickedPlayers = [];
        currentLobby.kickedPlayers.push({
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            cardsLeft: hand.length,
            pointsInHand: handPoints(hand),
            hand: [...hand],
            socketId,
            afk: true,
        });

        handleLeave(lobbyId, currentPlayer.userId, true);
    }, INACTIVITY_KICK_MS);
}

function resetLobby(lobby, hostId, options) {
    clearInactivityTimer(lobby);
    if (lobby.disconnectTimers) {
        for (const timer of lobby.disconnectTimers.values()) clearTimeout(timer);
        lobby.disconnectTimers.clear();
    }
    lobby.status = "WAITING";
    lobby.hostId = null;
    lobby.players = [];
    lobby.spectators = [];
    lobby.hands = new Map();
    lobby.deck = [];
    lobby.discardPile = [];
    lobby.currentColor = null;
    lobby.currentPlayerIndex = 0;
    lobby.direction = 1;
    lobby.drawStack = 0;
    lobby.saidUno = new Set();
    lobby.winner = null;
    lobby.finalScores = null;
    lobby.kickedPlayers = [];
    lobby.expectedCount = null;
    lobby.teams = null;
    if (options) lobby.options = options;
}

function startGame(lobbyId, lobby) {
    if (lobby.status !== "WAITING") return;
    if (lobby.players.length < 2) return;
    lobby.currentGameId = randomUUID();

    // En mode 2v2, il faut exactement 4 joueurs
    if (lobby.options.teamMode === "2v2" && lobby.players.length !== 4) return;

    lobby.deck = createDeck();
    lobby.hands = new Map();
    lobby.discardPile = [];
    lobby.saidUno = new Set();
    lobby.drawStack = 0;
    lobby.direction = 1;
    lobby.currentPlayerIndex = 0;
    lobby.winner = null;
    lobby.finalScores = null;
    lobby.kickedPlayers = [];
    lobby.status = "PLAYING";
    lobby.teams = null;

    // Assigner les équipes si mode 2v2
    if (lobby.options.teamMode === "2v2") {
        if (lobby.preAssignedTeams && lobby.preAssignedTeams.size === lobby.players.length) {
            lobby.teams = new Map(lobby.preAssignedTeams);
        } else {
            assignTeams(lobby);
        }
    }

    for (const p of lobby.players) {
        drawCards(lobby, p.userId, STARTING_HAND);
    }

    let firstCard;
    do { firstCard = lobby.deck.pop(); } while (firstCard.color === "wild");
    lobby.discardPile.push(firstCard);
    lobby.currentColor = firstCard.color;

    if (firstCard.value === "skip") {
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, 0, lobby.direction, true);
    } else if (firstCard.value === "reverse") {
        lobby.direction = -1;
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, 0, lobby.direction);
    } else if (firstCard.value === "draw2") {
        const nextIdx = nextPlayerIndex(lobby, 0, lobby.direction);
        drawCards(lobby, lobby.players[nextIdx].userId, 2);
        lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
    }

    emitLobbyState(lobbyId, lobby);
    emitGameState(lobbyId, lobby);
    startInactivityTimer(lobbyId, lobby);
}

function handleLeave(lobbyId, userId, isKick = false) {
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

    if (lobby.status === "PLAYING") {
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
        startInactivityTimer(lobbyId, lobby);
        emitGameState(lobbyId, lobby);
    }

    emitLobbyState(lobbyId, lobby);
}

// ── Socket events ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("nouvelle connexion uno", socket.id);

    socket.on("uno:configure", ({ lobbyId, options, expectedCount, preAssignedTeams }, ack) => {
        if (!lobbyId) return;
        let lobby = lobbies.get(lobbyId);

        const defaultOptions = {
            stackable: false,
            jumpIn: false,
            teamMode: "none",
            teamWinMode: "one",
        };
        const mergedOptions = { ...defaultOptions, ...(options ?? {}) };

        const teamsMap = preAssignedTeams
            ? new Map(Object.entries(preAssignedTeams).map(([k, v]) => [k, Number(v)]))
            : null;

        if (!lobby) {
            lobby = {
                hostId: null,
                status: "WAITING",
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
                inactivityWarning: null,
                inactivityKick: null,
                teams: null,
                preAssignedTeams: teamsMap,
                disconnectTimers: new Map(),
            };
            lobbies.set(lobbyId, lobby);
        } else {
            if (lobby.status === "FINISHED" || lobby.status === "PLAYING") {
                resetLobby(lobby, null, mergedOptions);
            } else {
                lobby.options = mergedOptions;
            }
            if (expectedCount) lobby.expectedCount = expectedCount;
            if (teamsMap) lobby.preAssignedTeams = teamsMap;
        }

        io.to(`uno:${lobbyId}`).emit("uno:ready", { lobbyId });

        // Tenter de démarrer si des joueurs sont déjà arrivés avant configure
        if (lobby.status === "WAITING" && lobby.players.length > 0) {
            const required = mergedOptions.teamMode === "2v2" ? 4 : (expectedCount ?? 2);
            if (lobby.players.length >= required) {
                startGame(lobbyId, lobby);
            }
        }
        if (typeof ack === 'function') ack();
    });

    socket.on("uno:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;
        socket.data = { lobbyId, userId, username };
        socket.join(`uno:${lobbyId}`);

        const lobby = lobbies.get(lobbyId);
        if (!lobby) {
            socket.emit('notFound');
            return;
        }

        if (!lobby.spectators) lobby.spectators = [];
        lobby.socketMap.set(userId, socket.id);
        if (!lobby.hostId) lobby.hostId = userId;

        if (lobby.status === "FINISHED") {
            if (!lobby.spectators.find(s => s.userId === userId)) {
                lobby.spectators.push({ userId, username });
            }
            socket.emit("uno:state", buildSpectatorState(lobby));
            emitLobbyState(lobbyId, lobby);
            return;
        }

        if (lobby.status === "PLAYING") {
            const isExpectedPlayer = lobby.players.find(p => p.userId === userId);
            if (isExpectedPlayer) {
                // Annuler le timer de déconnexion si reconnexion
                const pendingTimer = lobby.disconnectTimers?.get(userId);
                if (pendingTimer) {
                    clearTimeout(pendingTimer);
                    lobby.disconnectTimers.delete(userId);
                }
                emitGameState(lobbyId, lobby);
                emitLobbyState(lobbyId, lobby);
                return;
            }
            if (!lobby.spectators.find(s => s.userId === userId)) {
                lobby.spectators.push({ userId, username });
            }
            socket.emit("uno:state", buildSpectatorState(lobby));
            emitLobbyState(lobbyId, lobby);
            return;
        }

        // Status WAITING
        if (!lobby.players.find(p => p.userId === userId)) {
            lobby.players.push({ userId, username });
        }

        emitLobbyState(lobbyId, lobby);

        // Ne démarrer que si expectedCount est connu (uno:configure déjà reçu)
        if (lobby.expectedCount !== null) {
            const requiredPlayers = lobby.options.teamMode === "2v2" ? 4 : lobby.expectedCount;
            if (lobby.players.length >= requiredPlayers) {
                startGame(lobbyId, lobby);
            }
        }
    });

    socket.on("uno:playCard", ({ cardId, chosenColor, sayUno }) => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== "PLAYING") return;

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
                const canStack = (card.value === "draw2" && topCard.value === "draw2") || card.value === "wild4";
                if (!canStack) return;
            }
            if (lobby.drawStack > 0 && lobby.options.stackable) {
                const canStack = card.value === "draw2" || card.value === "wild4";
                if (!canStack && !canPlay(card, topCard, lobby.currentColor)) return;
            }
            if (lobby.drawStack === 0 && !canPlay(card, topCard, lobby.currentColor)) return;
        } else {
            if (card.color !== topCard.color || card.value !== topCard.value) return;
        }

        hand.splice(cardIndex, 1);
        lobby.hands.set(userId, hand);
        lobby.discardPile.push(card);

        if (sayUno && hand.length === 1) lobby.saidUno.add(userId);
        else lobby.saidUno.delete(userId);

        lobby.currentColor = card.color === "wild" ? (chosenColor ?? "red") : card.color;

        if (checkWinner(lobbyId, lobby)) return;

        if (isJumpIn) {
            lobby.currentPlayerIndex = lobby.players.findIndex(p => p.userId === userId);
        }

        const curIdx = lobby.currentPlayerIndex;

        if (card.value === "skip") {
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction, true);
        } else if (card.value === "reverse") {
            lobby.direction *= -1;
            lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
        } else if (card.value === "draw2") {
            if (lobby.options.stackable) {
                lobby.drawStack += 2;
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, curIdx, lobby.direction);
            } else {
                const nextIdx = nextPlayerIndex(lobby, curIdx, lobby.direction);
                drawCards(lobby, lobby.players[nextIdx].userId, 2);
                lobby.currentPlayerIndex = nextPlayerIndex(lobby, nextIdx, lobby.direction);
            }
        } else if (card.value === "wild4") {
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
            io.to(`uno:${lobbyId}`).emit("uno:penaltyApplied", { targetId: userId, reason: "forgot_uno", cards: UNO_PENALTY });
        }

        startInactivityTimer(lobbyId, lobby);
        emitGameState(lobbyId, lobby);
    });

    socket.on("uno:drawCard", () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== "PLAYING") return;
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
        startInactivityTimer(lobbyId, lobby);
        emitGameState(lobbyId, lobby);
    });

    socket.on("uno:sayUno", () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (lobby.spectators?.find(s => s.userId === userId)) return;
        lobby.saidUno.add(userId);
        emitGameState(lobbyId, lobby);
    });

    socket.on("uno:callUno", ({ targetId }) => {
        const { lobbyId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        const targetHand = lobby.hands.get(targetId) ?? [];
        if (targetHand.length === 1 && !lobby.saidUno.has(targetId)) {
            drawCards(lobby, targetId, UNO_PENALTY);
            io.to(`uno:${lobbyId}`).emit("uno:penaltyApplied", { targetId, reason: "forgot_uno", cards: UNO_PENALTY });
            emitGameState(lobbyId, lobby);
        }
    });

    socket.on("uno:restart", () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        clearInactivityTimer(lobby);
        lobby.status = "WAITING";
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
        emitLobbyState(lobbyId, lobby);
    });

    socket.on("uno:surrender", () => {
        const { lobbyId, userId } = socket.data || {};
        const lobby = lobbies.get(lobbyId);
        if (lobby && lobby.status === "PLAYING" && userId) {
            const player = lobby.players.find(p => p.userId === userId);
            if (player) {
                const hand = lobby.hands.get(userId) ?? [];
                if (!lobby.kickedPlayers) lobby.kickedPlayers = [];
                lobby.kickedPlayers.push({
                    userId: player.userId,
                    username: player.username,
                    cardsLeft: hand.length,
                    pointsInHand: handPoints(hand),
                    hand: hand,
                    socketId: socket.id,
                    abandon: true,
                });
            }
        }
        handleLeave(lobbyId, userId);
    });

    socket.on("uno:leave", () => {
        const { lobbyId, userId } = socket.data || {};
        handleLeave(lobbyId, userId);
    });

    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.status !== "PLAYING") {
            handleLeave(lobbyId, userId);
            return;
        }
        // Délai de grâce : 10s pour permettre la reconnexion (ex. rafraîchissement)
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

const PORT = process.env.PORT || 10001;
server.listen(PORT, () => console.log("[UNO] realtime listening on", PORT));


const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
