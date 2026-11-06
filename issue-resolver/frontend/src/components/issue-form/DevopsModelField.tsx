import type { ModelDescriptor, ThinkingLevel } from '@issue-resolver/shared';
import ModelThinkingSelect from '../ModelThinkingSelect';
import { thinkingLevelsFor, isThinkingLevel } from '../../constants/thinking-levels';
import { inputClass } from '../formStyles';

interface DevopsModelFieldProps {
  models: ModelDescriptor[];
  modelsLoading: boolean;
  model: string;
  thinking: ThinkingLevel | '';
  onChangeModel: (value: string) => void;
  onChangeThinking: (value: ThinkingLevel | '') => void;
}

export default function DevopsModelField({
  models,
  modelsLoading,
  model,
  thinking,
  onChangeModel,
  onChangeThinking,
}: DevopsModelFieldProps) {
  return (
    <fieldset data-testid="devops-section">
      <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
        DevOps проектов
      </legend>
      <ModelThinkingSelect
        models={models}
        thinkingLevels={thinkingLevelsFor(
          models.find((item) => item.id === model),
        )}
        modelValue={model}
        thinkingValue={thinking}
        disabled={modelsLoading}
        thinkingDisabled={!model}
        modelLabel="Модель анализатора"
        thinkingLabel="Thinking effort анализатора"
        modelTestId="devops-model-input"
        thinkingTestId="devops-thinking-input"
        modelAriaLabel="Модель анализатора для DevOps-агента проектов"
        thinkingAriaLabel="Thinking effort для DevOps-агента проектов"
        modelSelectClassName={`${inputClass} sm:w-64`}
        thinkingSelectClassName={`${inputClass} sm:w-64`}
        onModelChange={onChangeModel}
        onThinkingChange={(value) =>
          onChangeThinking(isThinkingLevel(value) ? value : '')
        }
      />
    </fieldset>
  );
}