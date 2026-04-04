import { Server } from 'socket.io';
import { Lobby } from './types';
import { getTeammate, getTeamOf } from './game';
import { INACTIVITY_KICK_MS } from './timer';

export function buildStateFor(lobby: Lobby, userId: string) {
    let teammateHand = null;
    let teammateId = null;
    if (lobby.options.teamMode === '2v2' && lobby.teams) {
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
        turnEndsAt: lobby.turnStartedAt ? lobby.turnStartedAt + INACTIVITY_KICK_MS : null,
    };
}

export function buildSpectatorState(lobby: Lobby) {
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
        turnEndsAt: lobby.turnStartedAt ? lobby.turnStartedAt + INACTIVITY_KICK_MS : null,
    };
}

export function buildPublicState(lobby: Lobby) {
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

export function emitGameState(io: Server, lobbyId: string, lobby: Lobby): void {
    for (const player of lobby.players) {
        const socketId = lobby.socketMap.get(player.userId);
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit('uno:state', buildStateFor(lobby, player.userId));
    }
    for (const spectator of (lobby.spectators ?? [])) {
        const socketId = lobby.socketMap.get(spectator.userId);
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit('uno:state', buildSpectatorState(lobby));
    }
    io.to(`uno:${lobbyId}`).emit('uno:publicState', buildPublicState(lobby));
}

export function emitFinalState(io: Server, lobbyId: string, lobby: Lobby): void {
    emitGameState(io, lobbyId, lobby);
    for (const kicked of (lobby.kickedPlayers ?? [])) {
        const socketId = kicked.socketId;
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit('uno:state', {
            hand: [],
            currentColor: lobby.currentColor,
            topCard: lobby.discardPile[lobby.discardPile.length - 1] ?? null,
            currentPlayerIndex: lobby.currentPlayerIndex,
            players: [],
            direction: lobby.direction,
            drawStack: 0,
            status: 'FINISHED',
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

export function emitLobbyState(io: Server, lobbyId: string, lobby: Lobby): void {
    io.to(`uno:${lobbyId}`).emit('uno:lobbyState', {
        hostId: lobby.hostId,
        status: lobby.status,
        players: lobby.players,
        options: lobby.options,
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
    });
}
