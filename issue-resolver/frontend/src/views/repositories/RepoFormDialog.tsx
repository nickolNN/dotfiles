import { useState, type FormEvent } from 'react';
import type { RepoInfo } from '@issue-resolver/shared';
import ModalShell, { ModalSize } from '../../components/ModalShell';
import FormError from '../../components/FormError';
import RepoUrlInput from '../../components/RepoUrlInput';
import { btnPrimary, btnSecondary } from '../../components/buttonStyles';

interface RepoFormDialogProps {
  title: string;
  initialUrl: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (url: string) => void;
}

export default function RepoFormDialog({
  title,
  initialUrl,
  saving,
  error,
  onCancel,
  onSubmit,
}: RepoFormDialogProps) {
  const [url, setUrl] = useState(initialUrl);
  const [valid, setValid] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || saving) return;
    onSubmit(url);
  }

  return (
    <ModalShell
      onClose={onCancel}
      size={ModalSize.md}
      cardTestId="repo-form"
      closeTestId="repo-form-close"
      dialogLabel={title}
      title={<h3 className="glow text-lg font-semibold text-[#00FF41]">{title}</h3>}
      classes={{
        overlay: 'bg-black/70',
        card: 'panel space-y-4 p-5',
      }}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <RepoUrlInput
          id="repo-form-url"
          value={url}
          onChange={(value, info?: RepoInfo | null) => {
            setUrl(value);
            setValid(Boolean(info));
          }}
          placeholder="git@github.com:org/repo.git"
        />
        <FormError message={error} />
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            data-testid="repo-form-cancel"
            className={btnSecondary}
            onClick={onCancel}
            disabled={saving}
          >
            Отмена
          </button>
          <button
            type="submit"
            data-testid="repo-form-save"
            className={btnPrimary}
            disabled={!valid || saving}
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}