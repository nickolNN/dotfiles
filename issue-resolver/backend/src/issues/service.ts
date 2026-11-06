import { desc } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { DEFAULT_WORKSPACE_ROOT } from '../workspace/paths';
import {
  getMdArtifact,
  getResultArchive,
  getResultArtifact,
  getResultFiles,
} from './artifacts';
import { deleteIssueInBackground } from './delete';
import { toIssue } from './mapper';
import { getIssueRow } from './queries';
import type { IssueService, IssueServiceConfig } from './types';

export { toIssue, toIteration } from './mapper';
export type {
  IssueService,
  IssueServiceConfig,
  ResultArtifactResponse,
} from './types';

export function createIssueService(): IssueService {
  return {
    resolveConfig(deps): IssueServiceConfig {
      return {
        workspaceRoot: deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        container: deps.container,
        sse: deps.sse,
      };
    },

    listIssues(db, config) {
      const rows = db
        .select()
        .from(issues)
        .orderBy(desc(issues.created_at))
        .all();
      return rows.map((row) => toIssue(db, row, config.workspaceRoot));
    },

    getIssue(db, config, id) {
      const row = getIssueRow(db, id);
      return row ? toIssue(db, row, config.workspaceRoot) : null;
    },

    getResultArtifact,

    getMdArtifact,

    getResultFiles,

    getResultArchive,

    async deleteIssue(db, config, id) {
      await deleteIssueInBackground(db, config, id);
    },
  };
}