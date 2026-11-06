import type { Tag } from '@issue-resolver/shared';
import type { TagDraft } from './types';

export function draftFromTag(tag: Tag): TagDraft {
  return {
    name: tag.name,
    description: tag.description ?? '',
    run_instructions: tag.run_instructions ?? '',
    repositories: tag.repositories.map((tr) => ({
      repository_id: tr.repository_id,
      bootstrap_enabled: tr.bootstrap_enabled,
    })),
  };
}