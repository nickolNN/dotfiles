import { describe, expect, it } from 'vitest';
import { FakeJiraClient, HttpJiraClient, type JiraClient } from '../src/jira/client';

describe('FakeJiraClient', () => {
  it('setIssue → fetchIssue возвращает сохранённую задачу', async () => {
    const client = new FakeJiraClient();
    client.setIssue('KLA-5672', {
      key: 'KLA-5672',
      title: 'Курсор',
      summary: 'desc',
    });

    await expect(client.fetchIssue('KLA-5672')).resolves.toEqual({
      key: 'KLA-5672',
      title: 'Курсор',
      summary: 'desc',
    });
  });

  it('неизвестный ключ → дефолт { key, title: key, summary: "" }', async () => {
    const client = new FakeJiraClient();

    await expect(client.fetchIssue('NOPE-1')).resolves.toEqual({
      key: 'NOPE-1',
      title: 'NOPE-1',
      summary: '',
    });
  });

  it('failNextWith → fetchIssue rejects', async () => {
    const client = new FakeJiraClient();
    client.failNextWith(new Error('401'));

    await expect(client.fetchIssue('KLA-1')).rejects.toThrow('401');
  });

  it('calls фиксирует ключи в порядке вызовов', async () => {
    const client = new FakeJiraClient();

    await client.fetchIssue('KLA-1');
    await client.fetchIssue('KLA-2');
    await client.fetchIssue('KLA-3');

    expect(client.calls).toEqual(['KLA-1', 'KLA-2', 'KLA-3']);
  });
});

describe('HttpJiraClient', () => {
  it('конструируется и совместим с JiraClient (сигнатура компилируется)', () => {
    const client: JiraClient = new HttpJiraClient(
      'https://jira.example.com',
      't',
    );
    expect(typeof client.fetchIssue).toBe('function');
  });
});