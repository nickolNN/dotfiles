interface TaskDetailStatesProps {
  issueId: string | null | undefined;
  deleting: boolean;
}

export default function TaskDetailStates({
  issueId,
  deleting,
}: TaskDetailStatesProps) {
  if (!issueId) {
    return (
      <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
        <header className="mb-6">
          <h2 className="glow text-xl font-semibold text-[#00FF41]">Задача</h2>
        </header>
        <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
          Выберите задачу из списка.
        </div>
      </div>
    );
  }

  if (deleting) {
    return (
      <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
        <div
          data-testid="task-deleting"
          className="flex items-center justify-center gap-2 rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm italic text-[#00FF41]/60"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[#00FF41]/30 border-t-[#00FF41]"
          />
          Задача удаляется...
        </div>
      </div>
    );
  }

  return null;
}