import type { ReactNode } from 'react';
import type {
  ModelDescriptor,
  PipelineStep,
  ThinkingLevel,
} from '@issue-resolver/shared';
import ModelThinkingSelect from './ModelThinkingSelect';
import { inputClass } from './formStyles';

export interface StepRowProps {
  step: { value: PipelineStep; label: string };
  checked: boolean;
  disabled?: boolean;
  labelSuffix?: string;
  modelEnabled: boolean;
  thinkingLevels: readonly ThinkingLevel[];
  thinkingEnabled: boolean;
  currentModel: string;
  currentThinkingLevel: string;
  models: ModelDescriptor[];
  modelsLoading: boolean;
  onToggle: (step: PipelineStep) => void;
  onModelChange: (step: PipelineStep, value: string) => void;
  onThinkingChange: (step: PipelineStep, value: string) => void;
  hint?: ReactNode;
}

export default function StepRow({
  step,
  checked,
  disabled = false,
  labelSuffix,
  modelEnabled,
  thinkingLevels,
  thinkingEnabled,
  currentModel,
  currentThinkingLevel,
  models,
  modelsLoading,
  onToggle,
  onModelChange,
  onThinkingChange,
  hint,
}: StepRowProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80">
          <input
            type="checkbox"
            className="accent-[#00FF41] transition-base"
            checked={checked}
            disabled={disabled}
            onChange={() => onToggle(step.value)}
          />
          {step.label}
          {labelSuffix}
        </label>
        {hint && <div className="pl-6">{hint}</div>}
      </div>
      {modelEnabled && (
        <ModelThinkingSelect
          models={models}
          thinkingLevels={thinkingLevels}
          modelValue={currentModel}
          thinkingValue={currentThinkingLevel}
          disabled={modelsLoading}
          thinkingDisabled={!thinkingEnabled}
          modelPlaceholder="По умолчанию"
          thinkingPlaceholder="По умолчанию"
          modelAriaLabel={`Модель для шага ${step.label}`}
          thinkingAriaLabel={`Уровень размышления для шага ${step.label}`}
          modelSelectClassName={`${inputClass} sm:w-64`}
          thinkingSelectClassName={`${inputClass} sm:w-40`}
          onModelChange={(value) => onModelChange(step.value, value)}
          onThinkingChange={(value) => onThinkingChange(step.value, value)}
        />
      )}
    </div>
  );
}