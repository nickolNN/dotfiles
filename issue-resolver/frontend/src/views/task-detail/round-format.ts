export interface RoundQuestion {
  id: string;
  text: string;
  recommendation: string;
}

const QUESTION_MARKER = /❓\s*\*{0,2}Q(\d+)\*{0,2}/g;
const RECOMMENDATION_MARKER = /➡️?/;

export function parseRound(body: string): RoundQuestion[] | null {
  const markers = [...body.matchAll(QUESTION_MARKER)];
  if (markers.length === 0) return null;
  return markers.map((marker, i) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[i + 1]?.index ?? body.length;
    const chunk = body.slice(start, end);
    const rec = chunk.match(RECOMMENDATION_MARKER);
    const recIndex = rec?.index ?? -1;
    const rawText = recIndex >= 0 ? chunk.slice(0, recIndex) : chunk;
    const text = rawText
      .replace(/^[\s\-–—:]+/, "")
      .replace(/\*\*/g, "")
      .trim();
    const recommendation =
      recIndex >= 0 ? chunk.slice(recIndex + (rec?.[0].length ?? 0)).trim() : "";
    return { id: `Q${marker[1]}`, text, recommendation };
  });
}

export function roundAnswerValue(
  questions: RoundQuestion[],
  answers: string[],
): string {
  return questions
    .map((q, i) => `${q.id}: ${(answers[i] ?? "").trim()}`)
    .join("\n\n");
}
