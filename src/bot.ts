import { Card, Lobby } from './types';
import { canPlay } from './game';

export function chooseBotColor(hand: Card[]): string {
    const counts: Record<string, number> = { red: 0, green: 0, blue: 0, yellow: 0 };
    for (const c of hand) {
        if (c.color in counts) counts[c.color]++;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function botChooseCard(lobby: Lobby, botId: string): Card | null {
    const hand = lobby.hands.get(botId) ?? [];
    const topCard = lobby.discardPile[lobby.discardPile.length - 1];
    const currentColor = lobby.currentColor!;

    if (lobby.drawStack > 0 && !lobby.options.stackable) return null;

    if (lobby.drawStack > 0 && lobby.options.stackable) {
        const stackable = hand.filter(c => c.value === 'draw2' || c.value === 'wild4');
        return stackable[0] ?? null;
    }

    const playable = hand.filter(c => canPlay(c, topCard, currentColor));
    if (playable.length === 0) return null;

    const actions = playable.filter(c => ['skip', 'reverse', 'draw2'].includes(c.value));
    const numbers = playable.filter(c => !['skip', 'reverse', 'draw2', 'wild', 'wild4'].includes(c.value));
    const wilds = playable.filter(c => c.value === 'wild');
    const wild4s = playable.filter(c => c.value === 'wild4');

    return actions[0] ?? numbers[0] ?? wilds[0] ?? wild4s[0] ?? null;
}
