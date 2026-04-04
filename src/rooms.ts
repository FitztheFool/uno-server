import { Lobby, GameOptions } from './types';
import { clearInactivityTimer } from './timer';

export const lobbies = new Map<string, Lobby>();

export function resetLobby(lobby: Lobby, options?: GameOptions): void {
    clearInactivityTimer(lobby);
    if (lobby.disconnectTimers) {
        for (const timer of lobby.disconnectTimers.values()) clearTimeout(timer);
        lobby.disconnectTimers.clear();
    }
    lobby.status = 'WAITING';
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
