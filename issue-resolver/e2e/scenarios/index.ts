import { agentQuestionScenario } from './agent-question';
import { allSuccessScenario } from './all-success';
import { bootstrapFailureScenario } from './bootstrap-failure';
import { concurrentQuestionsScenario } from './concurrent-questions';
import { stepFailureScenario } from './step-failure';
import type { MockPiScenario } from './types';

export type {
  MockPiQuestion,
  MockPiScenario,
  MockPiStep,
  MockPiStepType,
  ScenarioBootstrapMode,
  ScenarioPipelineStep,
} from './types';

export {
  agentQuestionScenario,
  allSuccessScenario,
  bootstrapFailureScenario,
  concurrentQuestionsScenario,
  stepFailureScenario,
};

/** Имя встроенного сценария. */
export type BuiltinScenarioName =
  | 'all-success'
  | 'step-failure'
  | 'agent-question'
  | 'concurrent-questions'
  | 'bootstrap-failure';

/** Реестр встроенных сценариев: имя → неизменяемое описание. */
export const BUILTIN_SCENARIOS: Readonly<
  Record<BuiltinScenarioName, MockPiScenario>
> = {
  'all-success': allSuccessScenario,
  'step-failure': stepFailureScenario,
  'agent-question': agentQuestionScenario,
  'concurrent-questions': concurrentQuestionsScenario,
  'bootstrap-failure': bootstrapFailureScenario,
};

/** Разрешает имя встроенного сценария или бросает понятную ошибку. */
export function builtinScenario(name: string): MockPiScenario {
  const scenario = BUILTIN_SCENARIOS[name as BuiltinScenarioName];
  if (!scenario) {
    throw new Error(
      `unknown builtin scenario "${name}"; expected one of: ${Object.keys(
        BUILTIN_SCENARIOS,
      ).join(', ')}`,
    );
  }
  return scenario;
}