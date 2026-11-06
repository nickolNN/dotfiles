import ModelThinkingSelect from '../ModelThinkingSelect';
import { thinkingLevelsFor } from '../../constants/thinking-levels';
import { inputClass } from '../formStyles';
import { btnOutline } from '../buttonStyles';
import { retroStatusColor } from '../../theme';
import { formatStamp } from './format';
import { STATUS_LABEL } from './status';
import type { RetroRunState } from './useRetroRun';

interface RetroRunControlsProps {
  state: RetroRunState;
}

export default function RetroRunControls({ state }: RetroRunControlsProps) {
  const {
    models,
    model,
    thinking,
    sessionLimit,
    instructions,
    run,
    starting,
    aborting,
    running,
    setSessionLimit,
    setInstructions,
    setThinking,
    changeModel,
    handleStart,
    handleAbort,
  } = state;

  return (
    <>
      <div className="space-y-3">
        <ModelThinkingSelect
          models={models}
          thinkingLevels={thinkingLevelsFor(
            models.find((item) => item.id === model),
          )}
          modelValue={model}
          thinkingValue={thinking}
          disabled={starting || running}
          thinkingDisabled={!model}
          modelLabel="Модель"
          thinkingLabel="Thinking effort"
          labelClassName="text-xs text-[#00FF41]/70"
          modelTestId="retro-model"
          thinkingTestId="retro-thinking"
          modelAriaLabel="Модель ретро-агента"
          thinkingAriaLabel="Thinking effort ретро-агента"
          modelSelectClassName={`${inputClass} sm:w-64`}
          thinkingSelectClassName={`${inputClass} sm:w-48`}
          onModelChange={changeModel}
          onThinkingChange={setThinking}
        />
        <label className="block text-xs text-[#00FF41]/70">
          Сессий для анализа
          <input
            data-testid="retro-sessions"
            type="number"
            min={1}
            max={50}
            className={`${inputClass} mt-1 w-full sm:w-40`}
            value={sessionLimit}
            onChange={(event) => setSessionLimit(event.currentTarget.value)}
          />
        </label>
      </div>

      <label className="block text-xs text-[#00FF41]/70">
        Что ещё учесть
        <textarea
          data-testid="retro-instructions"
          rows={3}
          placeholder="например: посмотри, почему ревью пропускало ошибки в миграциях"
          className={`${inputClass} mt-1`}
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="retro-start"
          disabled={starting || running}
          className={btnOutline}
          onClick={() => void handleStart()}
        >
          Запустить
        </button>
        {starting && (
          <span className="text-xs text-[#00FF41]/50">Запуск...</span>
        )}
        {running && (
          <button
            type="button"
            data-testid="retro-abort"
            disabled={aborting}
            className="rounded-none border border-[#FFB000] px-4 py-2 text-sm font-medium text-[#FFB000] transition-colors hover:bg-[#FFB000]/10 disabled:opacity-50"
            onClick={() => void handleAbort()}
          >
            {aborting ? 'Останавливаю...' : 'Остановить'}
          </button>
        )}
        {run && (
          <span
            data-testid="retro-status"
            className="text-xs"
            style={{ color: retroStatusColor[run.status] }}
          >
            {STATUS_LABEL[run.status]} · {formatStamp(run.updated_at)}
          </span>
        )}
      </div>

      {run && (
        <p
          data-testid="retro-run-params"
          className="text-[11px] text-[#00FF41]/40"
        >
          {run.model ?? 'модель по умолчанию'}
          {run.thinking_level ? ` · ${run.thinking_level}` : ''}
          {' · '}
          {run.session_limit
            ? `${run.session_limit} сессий`
            : 'лимит по умолчанию'}
          {run.instructions ? ' · свои инструкции' : ''}
        </p>
      )}
    </>
  );
}