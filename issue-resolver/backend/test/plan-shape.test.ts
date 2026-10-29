import { describe, expect, it } from 'vitest';
import { planShapeWarnings } from '../src/workflow/engine';

describe('planShapeWarnings', () => {
  it('числый бриф → без предупреждений', () => {
    const plan = '# Plan\n\nD1: курсор при перетаскивании — grabbing.\nДо: стрелка. После: закрытая рука.\n';

    expect(planShapeWarnings(plan)).toEqual([]);
  });

  it('бриф не написан → предупреждение, исполнитель получит только summary', () => {
    const warnings = planShapeWarnings(null);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plan.md отсутствует');
    expect(warnings[0]).toContain('summary');
  });

  it('ссылка на строку → предупреждение с файлом и строкой', () => {
    const plan = '# Plan\n\nМеняем `src/components/tasks/KanbanBoard.tsx:335` — курсор.';
    const warnings = planShapeWarnings(plan);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('KanbanBoard.tsx:335');
    expect(warnings[0]).toContain('правку проектирует исполнитель');
  });

  it('диапазон строк тоже ловится', () => {
    expect(planShapeWarnings('правка в src/a/b.ts:10-20')).toHaveLength(1);
  });

  it('URL с портом — не ссылка на строку', () => {
    const plan = '# Plan\n\nПроверять на http://localhost:5101 и https://example.com:8080/x.\n';

    expect(planShapeWarnings(plan)).toEqual([]);
  });

  it('имя файла без номера строки — не нарушение', () => {
    const plan = '# Plan\n\nПравки в src/components/KanbanBoard.tsx и docs/plan.md.\n';

    expect(planShapeWarnings(plan)).toEqual([]);
  });

  it('несколько нарушений → сообщение одно, по первому', () => {
    const plan = 'a.ts:1 и b.tsx:2 и c.py:3';

    expect(planShapeWarnings(plan)).toHaveLength(1);
  });
});