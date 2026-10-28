
export const ROOM_TOOL_PATTERNS: string[] = ['room_*'];

export function soloRunExcludeTools(): string[] {
  return [...ROOM_TOOL_PATTERNS];
}
