import type {
  ModelDescriptor,
  StepModels,
  StepThinkingLevels,
} from '@issue-resolver/shared';
import { PipelineStep } from '@issue-resolver/shared';
import ModelThinkingSelect from '../ModelThinkingSelect';
import { thinkingLevelsFor } from '../../constants/thinking-levels';
import { inputClass } from '../formStyles';

interface ReportModelFieldProps {
  models: ModelDescriptor[];
  modelsLoading: boolean;
  stepModels: StepModels;
  stepThinkingLevels: StepThinkingLevels;
  onChangeModel: (step: PipelineStep, value: string) => void;
  onChangeThinking: (step: PipelineStep, value: string) => void;
}

export default function ReportModelField({
  models,
  modelsLoading,
  stepModels,
  stepThinkingLevels,
  onChangeModel,
  onChangeThinking,
}: ReportModelFieldProps) {
  return (
    <fieldset data-testid="report-section">
      <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
        Отчёт
      </legend>
      <ModelThinkingSelect
        models={models}
        thinkingLevels={thinkingLevelsFor(
          models.find((model) => model.id === stepModels.report),
        )}
        modelValue={stepModels.report ?? ''}
        thinkingValue={stepThinkingLevels.report ?? ''}
        disabled={modelsLoading}
        thinkingDisabled={!stepModels.report}
        modelLabel="Модель отчёта"
        thinkingLabel="Thinking effort отчёта"
        modelTestId="report-model-input"
        thinkingTestId="report-thinking-input"
        modelAriaLabel="Модель агента отчёта"
        thinkingAriaLabel="Thinking effort агента отчёта"
        modelSelectClassName={`${inputClass} sm:w-64`}
        thinkingSelectClassName={`${inputClass} sm:w-64`}
        onModelChange={(value) => onChangeModel(PipelineStep.report, value)}
        onThinkingChange={(value) => onChangeThinking(PipelineStep.report, value)}
      />
    </fieldset>
  );
}