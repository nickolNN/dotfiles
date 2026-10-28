import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { RepoInfo, RepoValidationResult } from '@issue-resolver/shared';
import RepoUrlInput, {
  isLikelyRepoUrl,
  normalizeRepoUrl,
} from './RepoUrlInput';

const GITHUB_URL = 'https://github.com/facebook/react';

const reactInfo: RepoInfo = {
  platform: 'github',
  fullName: 'facebook/react',
  defaultBranch: 'main',
  branches: ['main', 'develop'],
  language: 'JavaScript',
  description: 'The library for web and native user interfaces.',
  stars: 230000,
  isPrivate: false,
  cloneUrl: 'https://github.com/facebook/react.git',
  writeAccess: true,
};

function validResult(url: string, info: RepoInfo = reactInfo): RepoValidationResult {
  return { url, valid: true, platform: info.platform, info };
}

function invalidResult(url: string, error = 'Repository not found'): RepoValidationResult {
  return { url, valid: false, platform: 'github', error };
}

function stubValidateFetch(results: RepoValidationResult[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness({
  initial = '',
  onChange,
}: {
  initial?: string;
  onChange?: (url: string, info?: RepoInfo | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RepoUrlInput
      value={value}
      onChange={(url, info) => {
        setValue(url);
        onChange?.(url, info);
      }}
    />
  );
}

function typeUrl(url: string) {
  fireEvent.change(screen.getByTestId('repo-url-field'), {
    target: { value: url },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RepoUrlInput', () => {
  it('показывает спиннер во время проверки, затем ✅ и enriched info', async () => {
    stubValidateFetch([validResult(GITHUB_URL)]);
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);
    typeUrl(GITHUB_URL);

    expect(screen.getByTestId('repo-url-spinner')).toBeInTheDocument();

    await waitFor(
      () => expect(screen.getByTestId('repo-url-valid')).toBeInTheDocument(),
      { timeout: 2000 },
    );

    expect(screen.queryByTestId('repo-url-spinner')).toBeNull();
    expect(screen.queryByTestId('repo-url-invalid')).toBeNull();

    const card = screen.getByTestId('repo-info-card');
    expect(card).toBeInTheDocument();
    expect(within(card).getByText('facebook/react')).toBeInTheDocument();
    expect(screen.getByTestId('repo-platform')).toHaveTextContent('GitHub');
    expect(screen.getByTestId('repo-language')).toHaveTextContent('JavaScript');
    expect(screen.getByTestId('repo-stars')).toHaveTextContent('230000');
    expect(screen.getByTestId('repo-branch')).toHaveTextContent('main');

    expect(onChange).toHaveBeenCalledWith(GITHUB_URL, reactInfo);
  });

  it('показывает ❌ и красный текст ошибки после неудачной валидации', async () => {
    stubValidateFetch([invalidResult(GITHUB_URL)]);

    render(<Harness />);
    typeUrl(GITHUB_URL);

    await waitFor(
      () => expect(screen.getByTestId('repo-url-invalid')).toBeInTheDocument(),
      { timeout: 2000 },
    );

    expect(screen.queryByTestId('repo-url-valid')).toBeNull();
    expect(screen.queryByTestId('repo-info-card')).toBeNull();
    expect(screen.getByTestId('repo-url-message')).toHaveTextContent(
      'Repository not found',
    );
  });

  it('не вызывает API для пустого и не-репозиторного URL', async () => {
    const fetchMock = stubValidateFetch([validResult(GITHUB_URL)]);

    render(<Harness />);
    typeUrl('');
    typeUrl('https://example.com');
    typeUrl('https://example.com/one-segment');

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('repo-url-spinner')).toBeNull();
    expect(screen.getByTestId('repo-url-status')).toHaveAttribute(
      'data-state',
      'invalid-url',
    );
  });

  it('URL без схемы нормализуется до https и валидируется', async () => {
    const fetchMock = stubValidateFetch([
      validResult('https://github.com/facebook/react'),
    ]);
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);
    typeUrl('github.com/facebook/react');

    expect(screen.getByTestId('repo-url-spinner')).toBeInTheDocument();

    await waitFor(
      () => expect(screen.getByTestId('repo-url-valid')).toBeInTheDocument(),
      { timeout: 2000 },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/issue-resolver/api/v1/repos/validate');
    expect(JSON.parse(String(init.body))).toEqual({
      urls: ['https://github.com/facebook/react'],
    });
    expect(onChange).toHaveBeenCalledWith(
      'github.com/facebook/react',
      reactInfo,
    );
  });

  it('ssh-стиль нормализуется до https перед отправкой', async () => {
    const fetchMock = stubValidateFetch([
      validResult('https://github.com/facebook/react.git'),
    ]);

    render(<Harness />);
    typeUrl('git@github.com:facebook/react.git');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      urls: ['https://github.com/facebook/react.git'],
    });
  });

  it('неизвестный хост с путём owner/repo тоже валидируется', async () => {
    const url = 'https://example.com/org/repo';
    const fetchMock = stubValidateFetch([
      {
        url,
        valid: false,
        platform: 'unknown',
        error: 'Unsupported platform',
      },
    ]);

    render(<Harness />);
    typeUrl(url);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ urls: [url] });

    await waitFor(
      () => expect(screen.getByTestId('repo-url-invalid')).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(screen.getByTestId('repo-url-message')).toHaveTextContent(
      'Unsupported platform',
    );
  });

  it('мусор → ✕ «Invalid URL» без запроса к API', async () => {
    const fetchMock = stubValidateFetch([validResult(GITHUB_URL)]);

    render(<Harness />);
    typeUrl('not a url');
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('repo-url-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('repo-url-message')).toHaveTextContent(
      'Invalid URL',
    );
  });

  it('URL без пути owner/repo → серая подсказка, data-state=invalid-url', async () => {
    const fetchMock = stubValidateFetch([validResult(GITHUB_URL)]);

    render(<Harness />);
    typeUrl('https://example.com');
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('repo-url-hint')).toHaveTextContent(
      'Непохоже на URL репозитория',
    );
    expect(screen.getByTestId('repo-url-status')).toHaveAttribute(
      'data-state',
      'invalid-url',
    );
    expect(screen.getByTestId('repo-url-input')).toHaveAttribute(
      'data-state',
      'invalid-url',
    );
  });

  it('debounce: не шлёт запрос на каждое нажатие, только один после паузы', async () => {
    const fetchMock = stubValidateFetch([validResult(GITHUB_URL)]);
    render(<Harness />);

    typeUrl('https://github.com');
    typeUrl('https://github.com/facebook');
    typeUrl(GITHUB_URL);

    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/issue-resolver/api/v1/repos/validate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ urls: [GITHUB_URL] });
  });

  it('bitbucket (в т.ч. self-hosted/stash) → фиолетово-синий чип Bitbucket', async () => {
    const info: RepoInfo = {
      platform: 'bitbucket',
      fullName: 'ACME/app',
      defaultBranch: 'master',
      branches: ['master', 'develop'],
      language: null,
      description: 'Internal service',
      stars: 0,
      isPrivate: true,
      cloneUrl: 'https://stash.internal.ru/scm/acme/app.git',
      writeAccess: true,
    };
    const url = 'https://stash.internal.ru/scm/acme/app.git';
    stubValidateFetch([
      {
        url,
        valid: true,
        platform: 'bitbucket',
        info,
      },
    ]);

    render(<Harness />);
    typeUrl(url);

    await waitFor(
      () => expect(screen.getByTestId('repo-url-valid')).toBeInTheDocument(),
      { timeout: 2000 },
    );

    const chip = screen.getByTestId('repo-platform');
    expect(chip).toHaveTextContent('Bitbucket');
    expect(chip.className).toContain('2684FF');
  });

  it('показывает внешнюю ошибку и не дёргает API при disabled', async () => {
    const fetchMock = stubValidateFetch([validResult(GITHUB_URL)]);

    render(
      <RepoUrlInput
        value={GITHUB_URL}
        onChange={() => {}}
        error="Сервер отклонил репозиторий"
        disabled
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('repo-url-message')).toHaveTextContent(
      'Сервер отклонил репозиторий',
    );
  });
});

describe('isLikelyRepoUrl', () => {
  it.each([
    ['https://github.com/org/repo', true],
    ['git@github.com:org/repo.git', true],
    ['https://gitlab.com/org/repo', true],
    ['https://gitlab.company.com/group/app', true],
    ['git@gitlab.local:org/repo.git', true],
    ['https://gitlab.local/org/repo/extra', true],
    ['https://bitbucket.org/acme/app', true],
    ['https://bitbucket.company.com/scm/proj/app.git', true],
    ['git@stash.internal.ru:proj/app.git', true],
    ['https://stash.internal.ru/scm/proj/app.git', true],
    ['https://example.com/org/repo', true],
    ['https://example.org/org/repo', true],
    ['github.com/org/repo', true],
    ['https://example.com', false],
    ['https://example.com/one-segment', false],
    ['https://github.com/facebook', false],
    ['', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isLikelyRepoUrl(url)).toBe(expected);
  });
});

describe('normalizeRepoUrl', () => {
  it.each([
    ['github.com/org/repo', 'https://github.com/org/repo'],
    ['git@github.com:org/repo.git', 'https://github.com/org/repo.git'],
    ['https://gitlab.local/org/repo', 'https://gitlab.local/org/repo'],
    ['https://example.com/org/repo', 'https://example.com/org/repo'],
    ['not a url', null],
    ['', null],
  ])('%s → %s', (value, expected) => {
    expect(normalizeRepoUrl(value)).toBe(expected);
  });
});