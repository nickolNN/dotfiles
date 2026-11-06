import type { Tag } from '@issue-resolver/shared';

export interface TagRepoDraft {
  repository_id: string;
  bootstrap_enabled: boolean;
}

export interface TagDraft {
  name: string;
  description: string;
  run_instructions: string;
  repositories: TagRepoDraft[];
}

export type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; tag: Tag }
  | null;

export interface TagsProps {
  createSignal?: number;
}