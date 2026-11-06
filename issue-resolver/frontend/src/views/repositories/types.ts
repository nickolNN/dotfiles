import type { SavedRepo } from '@issue-resolver/shared';

export type DialogState = { mode: 'create' } | { mode: 'edit'; repo: SavedRepo };

export interface RepositoriesProps {
  createSignal?: number;
}