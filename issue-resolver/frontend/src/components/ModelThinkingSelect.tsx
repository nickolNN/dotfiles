import type {
  ModelDescriptor,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { thinkingLevelsFor } from '../constants/thinking-levels';
import { inputClass } from './formStyles';

export interface ModelThinkingSelectProps {
  /** Доступные модели. */
  models: ModelDescriptor[];
  /** Доступные уровни мышления (обычно из thinkingLevelsFor выбранной модели). */
  thinkingLevels: readonly ThinkingLevel[];

  /** Текущее значение модели. */
  modelValue: string;
  /** Текущий уровень мышления. */
  thinkingValue: string;

  /** Заблокировать оба селекта. */
  disabled?: boolean;
  /** Заблокировать только thinking (когда модель не выбрана). */
  thinkingDisabled?: boolean;

  /** Как строить value для <option> модели. По умолчанию: model.id. */
  modelOptionValue?: (model: ModelDescriptor) => string;
  /** Как строить label для <option> модели. По умолчанию: model.name ?? model.id. */
  modelOptionLabel?: (model: ModelDescriptor) => string;

  /** Плейсхолдер для пустой опции модели. */
  modelPlaceholder?: string;
  /** Плейсхолдер для пустой опции мышления. */
  thinkingPlaceholder?: string;

  /** Видимая подпись рядом с селектом модели (если задана). */
  modelLabel?: string;
  /** Видимая подпись рядом с селектом мышления (если задана). */
  thinkingLabel?: string;

  /** data-testid для селекта модели. */
  modelTestId?: string;
  /** data-testid для селекта мышления. */
  thinkingTestId?: string;

  /** aria-label для селекта модели. */
  modelAriaLabel?: string;
  /** aria-label для селекта мышления. */
  thinkingAriaLabel?: string;

  /** CSS-класс для селекта модели (по умолчанию inputClass). */
  modelSelectClassName?: string;
  /** CSS-класс для селекта мышления (по умолчанию inputClass). */
  thinkingSelectClassName?: string;

  /** Дополнительный класс для враппера пары. */
  className?: string;

  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
}

/**
 * Единая пара «модель + thinking» для ВСЕХ мест в приложении. Одна реализация —
 * больше никакой копипасты селектов модели и мышления.
 */
export default function ModelThinkingSelect({
  models,
  thinkingLevels,
  modelValue,
  thinkingValue,
  disabled = false,
  thinkingDisabled = false,
  modelOptionValue = (m) => m.id,
  modelOptionLabel = (m) => m.name ?? m.id,
  modelPlaceholder = 'По умолчанию',
  thinkingPlaceholder = 'По умолчанию',
  modelLabel,
  thinkingLabel,
  modelTestId,
  thinkingTestId,
  modelAriaLabel,
  thinkingAriaLabel,
  modelSelectClassName,
  thinkingSelectClassName,
  className = '',
  onModelChange,
  onThinkingChange,
}: ModelThinkingSelectProps) {
  const modelClass = modelSelectClassName ?? inputClass;
  const thinkingClass = thinkingSelectClassName ?? inputClass;

  const modelSelect = (
    <select
      data-testid={modelTestId}
      aria-label={modelAriaLabel}
      className={modelClass}
      value={modelValue}
      disabled={disabled}
      onChange={(event) => onModelChange(event.target.value)}
    >
      <option value="">{modelPlaceholder}</option>
      {models.map((model) => (
        <option key={modelOptionValue(model)} value={modelOptionValue(model)}>
          {modelOptionLabel(model)}
        </option>
      ))}
    </select>
  );

  const thinkingSelect = (
    <select
      data-testid={thinkingTestId}
      aria-label={thinkingAriaLabel}
      className={thinkingClass}
      value={thinkingValue}
      disabled={disabled || thinkingDisabled}
      onChange={(event) => onThinkingChange(event.target.value)}
    >
      <option value="">{thinkingPlaceholder}</option>
      {thinkingDisabled ? null : thinkingLevels.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );

  const labelled = (label: string | undefined, select: typeof modelSelect) =>
    label ? (
      <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="text-sm text-[#00FF41]/80">{label}</span>
        {select}
      </label>
    ) : (
      select
    );

  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:items-center ${className}`}>
      {labelled(modelLabel, modelSelect)}
      {labelled(thinkingLabel, thinkingSelect)}
    </div>
  );
}

export { thinkingLevelsFor };