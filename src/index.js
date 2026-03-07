const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

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
        for (let i = 0;i < 4;i++) {
            deck.push({ color: "wild", value, id: `${value}_${i}` });
        }
    }
    return shuffle(deck);
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1;i > 0;i--) {
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
        });
    }
}

function buildStateFor(lobby, userId) {
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
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        finalScores: lobby.finalScores ?? null,
        options: lobby.options,
        isMyTurn: lobby.players[lobby.currentPlayerIndex]?.userId === userId,
        spectator: false,
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
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        finalScores: lobby.finalScores ?? null,
        options: lobby.options,
        isMyTurn: false,
        spectator: true,
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
        })),
        direction: lobby.direction,
        drawStack: lobby.drawStack,
        status: lobby.status,
        winner: lobby.winner ?? null,
        options: lobby.options,
    };
}

function emitLobbyState(lobbyId, lobby) {
    io.to(`uno:${lobbyId}`).emit("uno:lobbyState", {
        hostId: lobby.hostId,
        status: lobby.status,
        players: lobby.players,
        options: lobby.options,
    });
}

function drawCards(lobby, userId, count) {
    const hand = lobby.hands.get(userId) ?? [];
    for (let i = 0;i < count;i++) {
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

    for (const player of lobby.players) {
        const hand = lobby.hands.get(player.userId) ?? [];
        const pts = handPoints(hand);
        allEntries.push({
            userId: player.userId,
            username: player.username,
            cardsLeft: hand.length,
            pointsInHand: pts,
            score: 0,
            kicked: false,
        });
    }

    for (const kicked of (lobby.kickedPlayers ?? [])) {
        allEntries.push({
            userId: kicked.userId,
            username: kicked.username,
            cardsLeft: kicked.cardsLeft,
            pointsInHand: kicked.pointsInHand,
            score: 0,
            kicked: true,
        });
    }

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

    return allEntries.map((e, i) => ({ ...e, rank: i + 1 }));
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
}

function checkWinner(lobbyId, lobby) {
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
            socketId,
        });

        handleLeave(lobbyId, currentPlayer.userId, true);
    }, INACTIVITY_KICK_MS);
}

function resetLobby(lobby, hostId, options) {
    clearInactivityTimer(lobby);
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
    if (options) lobby.options = options;
}

function startGame(lobbyId, lobby) {
    if (lobby.status !== "WAITING") return;
    if (lobby.players.length < 2) return;

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

io.on("connection", (socket) => {

    socket.on("uno:configure", ({ lobbyId, options, expectedCount }) => {
        if (!lobbyId) return;
        let lobby = lobbies.get(lobbyId);
        if (!lobby) {
            lobby = {
                hostId: null,  // le premier uno:join définira le host
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
                options: options ?? { stackable: false, jumpIn: false },
                winner: null,
                finalScores: null,
                kickedPlayers: [],
                expectedCount: expectedCount ?? null,
                inactivityWarning: null,
                inactivityKick: null,
            };
            lobbies.set(lobbyId, lobby);
        } else {
            if (lobby.status === "FINISHED" || lobby.status === "PLAYING") {
                resetLobby(lobby, null, options);  // null = le premier join définira le host
            } else {
                if (options) lobby.options = options;
            }
            if (expectedCount) lobby.expectedCount = expectedCount;
        }
    });

    socket.on("uno:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;
        socket.data = { lobbyId, userId, username };
        socket.join(`uno:${lobbyId}`);

        let lobby = lobbies.get(lobbyId);
        if (!lobby) {
            // Lobby créé par un joueur arrivant directement sur la page
            lobby = {
                hostId: userId,
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
                options: { stackable: false, jumpIn: false },
                winner: null,
                finalScores: null,
                kickedPlayers: [],
                expectedCount: null,
                inactivityWarning: null,
                inactivityKick: null,
            };
            lobbies.set(lobbyId, lobby);
        }

        if (!lobby.spectators) lobby.spectators = [];
        lobby.socketMap.set(userId, socket.id);

        // Partie déjà en cours ou terminée → spectateur
        if (lobby.status === "PLAYING" || lobby.status === "FINISHED") {
            if (!lobby.spectators.find(s => s.userId === userId)) {
                lobby.spectators.push({ userId, username });
            }
            socket.emit("uno:state", buildSpectatorState(lobby));
            emitLobbyState(lobbyId, lobby);
            return;
        }

        if (!lobby.players.find(p => p.userId === userId)) {
            lobby.players.push({ userId, username });
        }

        emitLobbyState(lobbyId, lobby);

        if (lobby.expectedCount && lobby.players.length >= lobby.expectedCount) {
            startGame(lobbyId, lobby);
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
        emitLobbyState(lobbyId, lobby);
    });

    socket.on("uno:leave", () => {
        const { lobbyId, userId } = socket.data || {};
        handleLeave(lobbyId, userId);
    });

    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        handleLeave(lobbyId, userId);
    });
});

const PORT = process.env.PORT || 10001;
server.listen(PORT, () => console.log("UNO realtime listening on", PORT));
