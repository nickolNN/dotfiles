import type {
  ModelDescriptor,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { thinkingLevelsFor } from '../constants/thinking-levels';
import { inputClass } from './formStyles';

export interface ModelThinkingSelectProps {
  models: ModelDescriptor[];
  thinkingLevels: readonly ThinkingLevel[];

  modelValue: string;
  thinkingValue: string;

  disabled?: boolean;
  thinkingDisabled?: boolean;

  modelOptionValue?: (model: ModelDescriptor) => string;
  modelOptionLabel?: (model: ModelDescriptor) => string;

  modelPlaceholder?: string;
  thinkingPlaceholder?: string;

  modelLabel?: string;
  thinkingLabel?: string;

  modelTestId?: string;
  thinkingTestId?: string;

  modelAriaLabel?: string;
  thinkingAriaLabel?: string;

  modelSelectClassName?: string;
  thinkingSelectClassName?: string;

  className?: string;

  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
}

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