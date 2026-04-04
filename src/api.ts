import { FinalScore } from './types';

export async function saveUnoAttempts(gameId: string, finalScores: FinalScore[]): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;

    const vsBot = finalScores.some(e => e.userId?.startsWith('bot-'));
    const humanScores = finalScores
        .filter(e => e.userId && !e.userId.startsWith('bot-'))
        .map(e => ({
            userId: e.userId,
            score: e.score,
            placement: e.rank,
            abandon: e.abandon ?? false,
            afk: e.afk ?? false,
        }));
    if (humanScores.length === 0) return;

    const bots = finalScores
        .filter(e => e.userId?.startsWith('bot-'))
        .map(e => ({ username: e.username, score: e.score, placement: e.rank }));

    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({
                gameType: 'UNO',
                gameId,
                vsBot,
                bots: bots.length > 0 ? bots : undefined,
                scores: humanScores,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[UNO] scores saved for ${gameId}`);
    } catch (err) {
        console.error('[UNO] saveUnoAttempts error:', err);
    }
}
