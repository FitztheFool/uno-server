import type { Server } from 'socket.io';
import { saveAttemptsAndEmit } from '@kwizar/shared';
import { FinalScore } from './types';

export async function saveUnoAttempts(io: Server, room: string, gameId: string, finalScores: FinalScore[]): Promise<void> {
    const vsBot = finalScores.some(e => e.userId?.startsWith('bot-'));
    const scores = finalScores.map(e => ({
        userId: e.userId,
        username: e.username,
        score: e.score,
        placement: e.rank,
        team: e.team,
        abandon: e.abandon ?? false,
        afk: e.afk ?? false,
    }));
    await saveAttemptsAndEmit(io, room, 'UNO', gameId, scores, vsBot);
}
