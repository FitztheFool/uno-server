import { Server } from 'socket.io';
import { Lobby } from './types';

export const INACTIVITY_WARNING_MS = 30_000;
export const INACTIVITY_KICK_MS = 60_000;

/** Set by index.ts to break the circular dep timer → handleLeave → timer. */
export const timerCallbacks: {
    handleLeave?: (lobbyId: string, userId: string, isKick: boolean) => void;
    getLobby?: (lobbyId: string) => Lobby | undefined;
} = {};

export function clearInactivityTimer(lobby: Lobby): void {
    if (lobby.inactivityWarning) { clearTimeout(lobby.inactivityWarning); lobby.inactivityWarning = null; }
    if (lobby.inactivityKick) { clearTimeout(lobby.inactivityKick); lobby.inactivityKick = null; }
    lobby.turnStartedAt = null;
}

export function startInactivityTimer(io: Server, lobbyId: string, lobby: Lobby): void {
    clearInactivityTimer(lobby);
    if (lobby.status !== 'PLAYING') return;
    const currentPlayer = lobby.players[lobby.currentPlayerIndex];
    if (!currentPlayer) return;
    if (currentPlayer.userId.startsWith('bot-')) return;

    lobby.turnStartedAt = Date.now();

    lobby.inactivityWarning = setTimeout(() => {
        io.to(`uno:${lobbyId}`).emit('uno:inactivityWarning', {
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            secondsLeft: 30,
        });
    }, INACTIVITY_WARNING_MS);

    lobby.inactivityKick = setTimeout(() => {
        const currentLobby = timerCallbacks.getLobby?.(lobbyId);
        if (!currentLobby || currentLobby.status !== 'PLAYING') return;
        const stillCurrent = currentLobby.players[currentLobby.currentPlayerIndex];
        if (!stillCurrent || stillCurrent.userId !== currentPlayer.userId) return;

        io.to(`uno:${lobbyId}`).emit('uno:playerKicked', {
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            reason: 'inactivity',
        });

        const hand = currentLobby.hands.get(currentPlayer.userId) ?? [];
        const socketId = currentLobby.socketMap.get(currentPlayer.userId) ?? null;
        if (!currentLobby.kickedPlayers) currentLobby.kickedPlayers = [];
        currentLobby.kickedPlayers.push({
            userId: currentPlayer.userId,
            username: currentPlayer.username,
            cardsLeft: hand.length,
            pointsInHand: hand.reduce((s, c) => {
                if (c.value === 'wild' || c.value === 'wild4') return s + 50;
                if (['skip', 'reverse', 'draw2'].includes(c.value)) return s + 20;
                return s + (parseInt(c.value, 10) || 0);
            }, 0),
            hand: [...hand],
            socketId,
            afk: true,
        });

        timerCallbacks.handleLeave?.(lobbyId, currentPlayer.userId, true);
    }, INACTIVITY_KICK_MS);
}
