import { describe, expect, it } from 'vitest';
import {
  repoDevPort,
  repoFullNameFromUrl,
  repoPrepStatus,
  type RepoPrepStep,
} from './repoPrep';

const step = (
  s: string,
  status: RepoPrepStep['status'],
  message?: string,
  devPort?: number,
): RepoPrepStep => ({ step: s, repo: 'Hello-World', status, message, devPort });

describe('repoFullNameFromUrl', () => {
  it('достаёт owner/repo из https-URL', () => {
    expect(repoFullNameFromUrl('https://github.com/octocat/Hello-World')).toBe(
      'octocat/Hello-World',
    );
  });

  it('срезает .git и завершающий слэш', () => {
    expect(repoFullNameFromUrl('https://github.com/octocat/Hello-World.git')).toBe(
      'octocat/Hello-World',
    );
    expect(repoFullNameFromUrl('https://github.com/octocat/Hello-World/')).toBe(
      'octocat/Hello-World',
    );
  });

  it('понимает ssh-форму', () => {
    expect(repoFullNameFromUrl('git@github.com:octocat/Hello-World.git')).toBe(
      'octocat/Hello-World',
    );
  });

  it('не падает на односегментном URL', () => {
    expect(repoFullNameFromUrl('Hello-World')).toBe('Hello-World');
    expect(repoFullNameFromUrl('')).toBe('');
  });
});

describe('repoPrepStatus', () => {
  it('без событий — pending', () => {
    expect(repoPrepStatus('Hello-World', true, [])).toBe('pending');
  });

  it('клонирование running/done → cloning/cloned', () => {
    expect(repoPrepStatus('Hello-World', true, [step('cloning', 'running')])).toBe(
      'cloning',
    );
    expect(repoPrepStatus('Hello-World', true, [step('cloning', 'done')])).toBe(
      'cloned',
    );
  });

  it('проверка инструкции → cloned', () => {
    expect(
      repoPrepStatus('Hello-World', true, [step('checking_instructions', 'done')]),
    ).toBe('cloned');
  });

  it('бутстрап и установка', () => {
    expect(
      repoPrepStatus('Hello-World', true, [step('bootstrapping', 'running')]),
    ).toBe('bootstrapping');
    expect(repoPrepStatus('Hello-World', true, [step('installing', 'done')])).toBe(
      'installed',
    );
  });

  it('терминальный ready → ready', () => {
    expect(
      repoPrepStatus('Hello-World', true, [step('installing', 'done')], true),
    ).toBe('ready');
  });

  it('bootstrap отключён → skipped (в т.ч. после ready)', () => {
    expect(
      repoPrepStatus(
        'Hello-World',
        false,
        [step('bootstrapping', 'done', 'пропущен'), step('installing', 'done', 'пропущен')],
      ),
    ).toBe('skipped');
    expect(repoPrepStatus('Hello-World', false, [], true)).toBe('skipped');
  });

  it('ошибка перевешивает ready', () => {
    expect(
      repoPrepStatus(
        'Hello-World',
        true,
        [step('cloning', 'error', 'clone failed')],
        true,
      ),
    ).toBe('failed');
  });

  it('игнорирует шаги чужих репозиториев', () => {
    const foreign: RepoPrepStep = {
      step: 'installing',
      repo: 'Other-Repo',
      status: 'done',
    };
    expect(repoPrepStatus('Hello-World', true, [foreign])).toBe('pending');
  });

  it('берёт последний шаг, а не первый', () => {
    expect(
      repoPrepStatus('Hello-World', true, [
        step('cloning', 'running'),
        step('cloning', 'done'),
      ]),
    ).toBe('cloned');
  });

  it('dev_server running → dev_server, warning → installed (не failed)', () => {
    expect(
      repoPrepStatus('Hello-World', true, [
        step('installing', 'done'),
        step('dev_server', 'running'),
      ]),
    ).toBe('dev_server');
    expect(
      repoPrepStatus('Hello-World', true, [
        step('installing', 'done'),
        step('dev_server', 'warning', 'порт не найден'),
      ]),
    ).toBe('installed');
  });
});

describe('repoDevPort', () => {
  it('возвращает порт из done-шага dev_server', () => {
    expect(
      repoDevPort('Hello-World', [
        step('installing', 'done'),
        step('dev_server', 'done', 'localhost:5173', 5173),
      ]),
    ).toBe(5173);
  });

  it('нет порта/warning/чужой репозиторий → undefined', () => {
    expect(repoDevPort('Hello-World', [step('dev_server', 'running')])).toBeUndefined();
    expect(
      repoDevPort('Hello-World', [step('dev_server', 'warning', 'нет')]),
    ).toBeUndefined();
    expect(
      repoDevPort('Other-Repo', [step('dev_server', 'done', 'x', 5173)]),
    ).toBeUndefined();
  });
});