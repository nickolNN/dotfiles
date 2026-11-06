import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import StepReportView from './StepReportView';

afterEach(cleanup);

describe('StepReportView — структурированный отчёт', () => {
  it('pass: бейдж PASS и summary через markdown', () => {
    render(
      <StepReportView
        raw={JSON.stringify({ status: 'pass', summary: 'всё **ок**' })}
      />,
    );

    const badge = screen.getByTestId('step-report-status');
    expect(badge).toHaveTextContent('PASS');
    expect(badge.className).toContain('#00FF41');

    const summary = screen.getByTestId('step-report-summary');
    expect(summary).toHaveTextContent('всё ок');
    expect(summary.querySelector('strong')).not.toBeNull();
  });

  it('fail: бейдж FAIL и красный цвет', () => {
    render(
      <StepReportView
        raw={JSON.stringify({ status: 'fail', summary: 'сломалось' })}
      />,
    );

    const badge = screen.getByTestId('step-report-status');
    expect(badge).toHaveTextContent('FAIL');
    expect(badge.className).toContain('#FF0033');
  });

  it('blocked: бейдж BLOCKED и оранжевый цвет', () => {
    render(
      <StepReportView
        raw={JSON.stringify({ status: 'blocked', summary: 'нужен ответ' })}
      />,
    );

    const badge = screen.getByTestId('step-report-status');
    expect(badge).toHaveTextContent('BLOCKED');
    expect(badge.className).toContain('#FFB000');
  });

  it('pr_error: баннер о несозданном MR/ветке с причиной', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 'PR готов',
          pr_error: 'https://github.com/acme/app.git — commit/push: rejected',
        })}
      />,
    );

    const banner = screen.getByTestId('step-report-pr-error');
    expect(banner).toHaveTextContent('MR/ветка не созданы');
    expect(banner).toHaveTextContent('commit/push: rejected');
    expect(screen.getByTestId('step-report-status')).toHaveTextContent('PASS');
  });

  it('scenarios: name и status для каждого сценария (+details)', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'fail',
          summary: 's',
          scenarios: [
            { name: 'логин', status: 'pass', details: 'работает' },
            { name: 'логаут', status: 'fail' },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-scenarios')).toBeInTheDocument();
    expect(screen.getAllByTestId('step-report-scenario')).toHaveLength(2);

    const names = screen.getAllByTestId('step-report-scenario-name');
    expect(names[0]).toHaveTextContent('логин');
    expect(names[1]).toHaveTextContent('логаут');

    const statuses = screen.getAllByTestId('step-report-scenario-status');
    expect(statuses[0]).toHaveTextContent('PASS');
    expect(statuses[0].className).toContain('#00FF41');
    expect(statuses[1]).toHaveTextContent('FAIL');
    expect(statuses[1].className).toContain('#FF0033');

    expect(screen.getByTestId('step-report-scenario-details')).toHaveTextContent(
      'работает',
    );
  });

  it('findings: severity с цветом и description', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'fail',
          summary: 's',
          findings: [
            { severity: 'minor', description: 'опечатка' },
            { severity: 'critical', description: 'утечка' },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-findings')).toBeInTheDocument();
    expect(screen.getAllByTestId('step-report-finding')).toHaveLength(2);

    const severities = screen.getAllByTestId('step-report-finding-severity');
    expect(severities[0]).toHaveTextContent('minor');
    expect(severities[0].className).toContain('#00B4FF');
    expect(severities[1]).toHaveTextContent('critical');
    expect(severities[1].className).toContain('#FF0033');

    const descriptions = screen.getAllByTestId(
      'step-report-finding-body',
    );
    expect(descriptions[0]).toHaveTextContent('опечатка');
    expect(descriptions[1]).toHaveTextContent('утечка');
  });

  it('мусорные findings и scenarios не роняют рендер', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'fail',
          summary: 's',
          findings: [null, { title: 'без severity' }, { severity: 'minor', description: 'ok' }],
          scenarios: [null, { name: 'ok', status: 'pass' }],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-status')).toHaveTextContent('FAIL');
    // A finding without a severity is kept as a blocking `critical` one, not dropped.
    expect(screen.getAllByTestId('step-report-finding')).toHaveLength(2);
    expect(screen.getAllByTestId('step-report-scenario')).toHaveLength(1);
  });

  it('finding: severity info c title+detail рендерит title и body=detail', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          findings: [{ severity: 'info', title: 'T', detail: 'D' }],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-finding-severity')).toHaveTextContent(
      'info',
    );
    expect(screen.getByTestId('step-report-finding-title')).toHaveTextContent(
      'T',
    );
    expect(screen.getByTestId('step-report-finding-body')).toHaveTextContent(
      'D',
    );
  });

  it('finding: severity minor без title рендерит body=description', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'fail',
          summary: 's',
          findings: [{ severity: 'minor', description: 'X' }],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-finding-severity')).toHaveTextContent(
      'minor',
    );
    expect(screen.queryByTestId('step-report-finding-title')).toBeNull();
    expect(screen.getByTestId('step-report-finding-body')).toHaveTextContent(
      'X',
    );
  });

  it('scenario: expected/actual рендерятся, статус-бейдж не рисуется', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'fail',
          summary: 's',
          scenarios: [{ name: 'контракт', expected: 'E', actual: 'A' }],
        })}
      />,
    );

    expect(screen.getByTestId('step-report-scenario-name')).toHaveTextContent(
      'контракт',
    );
    expect(screen.queryByTestId('step-report-scenario-status')).toBeNull();
    expect(
      screen.getByTestId('step-report-scenario-expected'),
    ).toHaveTextContent('E');
    expect(screen.getByTestId('step-report-scenario-actual')).toHaveTextContent(
      'A',
    );
  });

  it('execution stages: рендерит нумерованный список этапов', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: {
            mode: 'stages',
            executors: 3,
            decomposition: ['бэк', 'фронт'],
            rationale: 'много контекста',
            stages: [
              {
                index: 1,
                name: 'Сбор контекста',
                executors: 2,
                task: 'собрать',
              },
              { index: 2, task: 'починить' },
            ],
          },
        })}
      />,
    );

    const stages = screen.getByTestId('step-report-execution-stages');
    const items = stages.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Сбор контекста');
    expect(items[0]).toHaveTextContent('2 исп.');
    expect(items[0]).toHaveTextContent('собрать');
    expect(items[1]).toHaveTextContent('Этап 2');
    expect(items[1]).toHaveTextContent('починить');
    expect(
      screen.queryByTestId('step-report-execution-executors'),
    ).toBeNull();
    expect(
      screen.queryByTestId('step-report-execution-decomposition'),
    ).toBeNull();
    expect(
      screen.getByTestId('step-report-execution-rationale'),
    ).toHaveTextContent('много контекста');
  });

  it('execution stages: негодный executors не печатается как NaN', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: {
            mode: 'stages',
            stages: [
              { index: 1, name: 'Сбор', executors: '3', task: 'собрать' },
            ],
          },
        })}
      />,
    );

    const items = screen
      .getByTestId('step-report-execution-stages')
      .querySelectorAll('li');
    expect(items[0]).toHaveTextContent('Сбор');
    expect(items[0]).not.toHaveTextContent('NaN');
    expect(items[0]).not.toHaveTextContent('исп.');
  });

  it('execution single: негодный executors не печатает NaN', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: { mode: 'single', executors: '9' },
        })}
      />,
    );

    expect(
      screen.queryByTestId('step-report-execution-executors'),
    ).toBeNull();
    expect(
      screen.getByTestId('step-report-execution'),
    ).not.toHaveTextContent('NaN');
  });

  it('execution single: показывает исполнителей из плана', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: { mode: 'single', executors: 1, decomposition: ['всё'] },
        })}
      />,
    );

    expect(screen.getByTestId('step-report-execution-executors')).toHaveTextContent(
      '1',
    );
    expect(
      screen.getByTestId('step-report-execution-decomposition'),
    ).toHaveTextContent('всё');
  });

  it('execution single без опциональных полей рендерит только mode', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: { mode: 'single' },
        })}
      />,
    );

    expect(screen.getByTestId('step-report-execution-mode')).toHaveTextContent(
      'single',
    );
    expect(
      screen.queryByTestId('step-report-execution-executors'),
    ).toBeNull();
    expect(
      screen.queryByTestId('step-report-execution-decomposition'),
    ).toBeNull();
    expect(
      screen.queryByTestId('step-report-execution-rationale'),
    ).toBeNull();
  });

  it('execution unreadable: маркер вместо молчания, блок исполнителей не рисуется', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: { mode: 'room', executors: 2, decomposition: ['a', 'b'] },
        })}
      />,
    );

    const banner = screen.getByTestId('step-report-execution-unreadable');
    expect(banner).toHaveTextContent('План нечитаем');
    expect(banner).toHaveTextContent('single или stages');
    expect(screen.queryByTestId('step-report-execution')).toBeNull();
    expect(
      screen.queryByTestId('step-report-execution-executors'),
    ).toBeNull();
  });

  it('execution unreadable: явный null и отсутствие ключа баннера не дают', () => {
    for (const execution of [null, undefined]) {
      cleanup();
      render(
        <StepReportView
          raw={JSON.stringify({ status: 'pass', summary: 's', execution })}
        />,
      );

      expect(
        screen.queryByTestId('step-report-execution-unreadable'),
      ).toBeNull();
      expect(screen.queryByTestId('step-report-execution')).toBeNull();
    }
  });

  it('не-JSON raw → <pre> фолбек с текстом как есть', () => {
    render(<StepReportView raw="## Итог\nвсё хорошо" />);

    const pre = screen.getByTestId('step-report-raw');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveTextContent('## Итог');
    expect(screen.queryByTestId('step-report')).toBeNull();
  });

  it('валидный JSON другого вида → pretty-print в <pre>', () => {
    const raw = '{"foo":1,"bar":[1,2]}';
    render(<StepReportView raw={raw} />);

    const pre = screen.getByTestId('step-report-raw');
    expect(pre.textContent).toBe(JSON.stringify(JSON.parse(raw), null, 2));
    expect(pre.textContent).toContain('\n');
  });
});