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
    // Статус агента остаётся PASS — публикация отдельна от самого шага.
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

  it('execution: mode, executors, decomposition, rationale', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: {
            mode: 'room',
            executors: 3,
            decomposition: ['бэк', 'фронт', 'тесты'],
            rationale: 'много контекста',
          },
        })}
      />,
    );

    expect(screen.getByTestId('step-report-execution')).toBeInTheDocument();
    expect(screen.getByTestId('step-report-execution-mode')).toHaveTextContent(
      'room',
    );
    expect(
      screen.getByTestId('step-report-execution-executors'),
    ).toHaveTextContent('3');

    const decomposition = screen.getByTestId(
      'step-report-execution-decomposition',
    );
    expect(decomposition.querySelectorAll('li')).toHaveLength(3);
    expect(decomposition).toHaveTextContent('бэк');
    expect(decomposition).toHaveTextContent('тесты');

    expect(
      screen.getByTestId('step-report-execution-rationale'),
    ).toHaveTextContent('много контекста');
  });

  it('execution stages: рендерит нумерованный список этапов', () => {
    render(
      <StepReportView
        raw={JSON.stringify({
          status: 'pass',
          summary: 's',
          execution: {
            mode: 'stages',
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
    // Без name — дефолт «Этап N»; task без executors.
    expect(items[1]).toHaveTextContent('Этап 2');
    expect(items[1]).toHaveTextContent('починить');
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