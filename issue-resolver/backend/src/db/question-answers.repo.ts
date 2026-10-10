import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { questionAnswers } from './schema';

export interface RecordQuestionAnswerInput {
  iterationId: string;
  questionId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * Идемпотентно фиксирует ответ пользователя на вопрос итерации: повторный
 * ответ на тот же вопрос не создаёт вторую строку и не бросает (UNIQUE +
 * onConflictDoNothing). Значения value/confirmed/cancelled взаимоисключаемы
 * на уровне формы, но в БД хранятся как есть.
 */
export async function recordQuestionAnswer(
  db: Db,
  input: RecordQuestionAnswerInput,
): Promise<void> {
  const now = new Date().toISOString();
  db.insert(questionAnswers)
    .values({
      id: randomUUID(),
      iteration_id: input.iterationId,
      question_id: input.questionId,
      value: input.value ?? null,
      confirmed: input.confirmed ?? null,
      cancelled: input.cancelled ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing({
      target: [questionAnswers.iteration_id, questionAnswers.question_id],
    })
    .run();
}

/** Id вопросов, на которые для итерации сохранён ответ (любого вида). */
export async function listAnsweredQuestionIds(
  db: Db,
  iterationId: string,
): Promise<string[]> {
  return db
    .select({ question_id: questionAnswers.question_id })
    .from(questionAnswers)
    .where(eq(questionAnswers.iteration_id, iterationId))
    .all()
    .map((row) => row.question_id);
}

/** Есть ли сохранённый ответ на конкретный вопрос итерации. */
export async function hasQuestionAnswer(
  db: Db,
  iterationId: string,
  questionId: string,
): Promise<boolean> {
  const row = db
    .select({ id: questionAnswers.id })
    .from(questionAnswers)
    .where(
      and(
        eq(questionAnswers.iteration_id, iterationId),
        eq(questionAnswers.question_id, questionId),
      ),
    )
    .get();
  return row !== undefined;
}