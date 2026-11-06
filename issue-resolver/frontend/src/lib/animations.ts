const CARD_ANIMATIONS = [
  'animate-fade-in-up-d1',
  'animate-fade-in-up-d2',
  'animate-fade-in-up-d3',
  'animate-fade-in-up-d4',
  'animate-fade-in-up-d5',
  'animate-fade-in-up-d6',
  'animate-fade-in-up-d7',
  'animate-fade-in-up-d8',
] as const;

export function cardAnimation(index: number): string {
  return CARD_ANIMATIONS[index] ?? 'animate-fade-in-up';
}