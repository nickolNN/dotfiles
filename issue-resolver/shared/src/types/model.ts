import type { ThinkingLevel } from '../status';

export interface ModelDescriptor {
  id: string;
  provider?: string;
  name?: string;
  contextWindow?: number;
  thinkingLevels?: ThinkingLevel[];
}