import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ContainerStatsPayload } from '../api/sse';
import ContainerStatsBlock from './ContainerStatsBlock';

function stats(overrides: Partial<ContainerStatsPayload> = {}): ContainerStatsPayload {
  return {
    cpuPercent: 0,
    cpuLimitPercent: 800,
    memoryUsageBytes: 1073741824,
    memoryLimitBytes: 10737418240,
    pids: 1,
    ...overrides,
  };
}

function renderDot(overrides: Partial<ContainerStatsPayload>) {
  render(<ContainerStatsBlock stats={stats(overrides)} suffix="-test" />);
  return screen.getByTestId('cpu-health-test');
}

afterEach(cleanup);

describe('ContainerStatsBlock', () => {
  it('держит индикатор CPU зелёным на низкой доле общей ёмкости', () => {
    expect(renderDot({ cpuPercent: 50 })).toHaveStyle({
      backgroundColor: '#00FF41',
    });
  });

  it('считает цвет по доле от ёмкости, а не по абсолютному проценту', () => {
    expect(renderDot({ cpuPercent: 500 })).toHaveStyle({
      backgroundColor: '#FFB000',
    });
  });

  it('краснеет только у насыщения всей ёмкости', () => {
    expect(renderDot({ cpuPercent: 700 })).toHaveStyle({
      backgroundColor: '#FF0033',
    });
  });

  it('без сведений о ёмкости судит по абсолютному проценту', () => {
    expect(renderDot({ cpuPercent: 85, cpuLimitPercent: 0 })).toHaveStyle({
      backgroundColor: '#FF0033',
    });
  });

  it('печатает доли без повторных единиц', () => {
    render(<ContainerStatsBlock stats={stats({ cpuPercent: 145 })} suffix="-test" />);

    expect(screen.getByTestId('container-stats-test')).toHaveTextContent(
      'CPU 145.0/800%',
    );
    expect(screen.getByTestId('container-stats-test')).toHaveTextContent(
      'MEM 1.0/10.0GB',
    );
  });
});