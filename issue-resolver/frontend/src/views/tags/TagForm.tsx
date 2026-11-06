import { useState, type FormEvent } from 'react';
import type { SavedRepo } from '@issue-resolver/shared';
import { btnPrimary, btnSecondary } from '../../components/buttonStyles';
import FormError from '../../components/FormError';
import { inputClass, labelClass } from '../../components/formStyles';
import Toggle from './Toggle';
import type { TagDraft, TagRepoDraft } from './types';

interface TagFormProps {
  initial: TagDraft;
  savedRepos: SavedRepo[];
  savedReposLoading: boolean;
  saving: boolean;
  error: string | null;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (draft: TagDraft) => void;
}

export default function TagForm({
  initial,
  savedRepos,
  savedReposLoading,
  saving,
  error,
  submitLabel,
  onCancel,
  onSubmit,
}: TagFormProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [runInstructions, setRunInstructions] = useState(
    initial.run_instructions,
  );
  const [repos, setRepos] = useState<TagRepoDraft[]>(initial.repositories);

  function toggleRepo(repoId: string) {
    setRepos((current) =>
      current.some((repo) => repo.repository_id === repoId)
        ? current.filter((repo) => repo.repository_id !== repoId)
        : [...current, { repository_id: repoId, bootstrap_enabled: true }],
    );
  }

  function toggleBootstrap(repoId: string) {
    setRepos((current) =>
      current.map((repo) =>
        repo.repository_id === repoId
          ? { ...repo, bootstrap_enabled: !repo.bootstrap_enabled }
          : repo,
      ),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      run_instructions: runInstructions.trim() || '',
      repositories: repos,
    });
  }

  const selected = new Set(repos.map((repo) => repo.repository_id));

  return (
    <form
      data-testid="tag-form"
      className="space-y-3 border border-[#008F11]/40 p-3"
      onSubmit={handleSubmit}
    >
      <div>
        <label className={labelClass} htmlFor="tag-name">
          Имя
        </label>
        <input
          id="tag-name"
          data-testid="tag-name"
          className={inputClass}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Например: Frontend"
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="tag-description">
          Описание
        </label>
        <textarea
          id="tag-description"
          data-testid="tag-description"
          className={inputClass}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Зачем нужен этот тег"
          rows={3}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="tag-instructions">
          Run-инструкции (Markdown) — как запускать весь набор репозиториев
          вместе: прокси, порты, переменные окружения
        </label>
        <textarea
          id="tag-instructions"
          data-testid="tag-run-instructions"
          className={inputClass}
          value={runInstructions}
          onChange={(event) => setRunInstructions(event.target.value)}
          placeholder="## Прокси&#10;```bash&#10;ssh -L 4300:localhost:4300 ...&#10;```&#10;&#10;## Порты&#10;- Репо A: 5100&#10;- Репо B: 5200"
          rows={6}
        />
      </div>

      <div>
        <span className={labelClass}>Репозитории</span>
        {savedReposLoading && (
          <p className="text-xs text-[#00FF41]/50">Загружаем репозитории…</p>
        )}
        {!savedReposLoading && savedRepos.length === 0 && (
          <p className="text-xs text-[#00FF41]/50">
            Нет сохранённых репозиториев — добавьте их на странице «Репозитории»
          </p>
        )}
        {!savedReposLoading && savedRepos.length > 0 && (
          <div className="space-y-2">
            {savedRepos.map((repo) => {
              const isSelected = selected.has(repo.id);
              const draft = repos.find((item) => item.repository_id === repo.id);
              return (
                <div key={repo.id} className="border border-[#008F11]/30 p-2">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80">
                    <input
                      type="checkbox"
                      className="accent-[#00FF41]"
                      data-testid={`tag-repo-${repo.id}`}
                      checked={isSelected}
                      onChange={() => toggleRepo(repo.id)}
                    />
                    <span className="truncate">
                      {repo.fullName ?? repo.url}
                    </span>
                  </label>
                  {draft && (
                    <div className="mt-1 pl-6">
                      <Toggle
                        checked={draft.bootstrap_enabled}
                        label="Запустить (установка зависимостей)"
                        onToggle={() => toggleBootstrap(repo.id)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <FormError message={error} />

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          className={btnPrimary}
          disabled={saving || !name.trim()}
        >
          {saving ? 'Сохраняем…' : submitLabel}
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={onCancel}
          disabled={saving}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}