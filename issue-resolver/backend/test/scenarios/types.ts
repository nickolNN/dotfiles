
export type ScenarioPipelineStep =
  | 'refine'
  | 'resolve'
  | 'review'
  | 'test'
  | 'pr';

export type MockPiStepType = 'success' | 'failure' | 'question' | 'timeout';

export interface MockPiQuestion {
  question: string;
  options?: string[];
}

export interface MockPiStep {
  type: MockPiStepType;
  step?: ScenarioPipelineStep;
  reportData?: Record<string, unknown>;
  questionEvent?: MockPiQuestion;
  delayMs?: number;
}

export type ScenarioBootstrapMode = 'success' | 'failure';

export interface MockPiScenario {
  name?: string;
  steps: MockPiStep[];
  bootstrap?: ScenarioBootstrapMode;
  questionTimeoutMs?: number;
}