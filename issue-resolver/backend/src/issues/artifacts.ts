import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DesiredResult } from '@issue-resolver/shared';
import type { WorkspaceFile } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { createTarGz, type ArchiveEntry } from '../workspace/archive';
import {
  ALL_RESULT_ARTIFACTS,
  HTML_ARTIFACT,
  iterationResultDirFor,
  MD_ARTIFACT,
  type ResultArtifact,
  workspaceHostDirFor,
} from '../workspace/paths';
import {
  listWorkspaceFiles,
  workspaceFilePathFor,
} from '../workspace/workspace-files';
import { getIssueRow, latestCompletedIterationId } from './queries';
import type { IssueServiceConfig, ResultArtifactResponse } from './types';

export async function readArtifactFrom(
  dir: string,
  artifact: ResultArtifact,
): Promise<({ body: string; mtime: string } & ResultArtifact) | null> {
  const path = join(dir, artifact.filename);
  try {
    const fileStat = await stat(path);
    const body = await readFile(path, 'utf8');
    return {
      ...artifact,
      body,
      mtime: fileStat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function artifactResponse(
  read: { body: string; mtime: string } & ResultArtifact,
  source: ResultArtifactResponse['source'],
): ResultArtifactResponse {
  return {
    body: read.body,
    contentType: read.contentType,
    filename: read.filename,
    source,
    mtime: read.mtime,
  };
}

export async function getResultArtifact(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<ResultArtifactResponse | null> {
  const row = getIssueRow(db, id);
  if (!row) return null;

  const latest = latestCompletedIterationId(db, id);

  const wsDir = workspaceHostDirFor(config.workspaceRoot, id);
  const rootHtml = await readArtifactFrom(wsDir, HTML_ARTIFACT);
  if (rootHtml) {
    return artifactResponse(rootHtml, 'root');
  }

  if (!latest) return null;
  const iterDir = iterationResultDirFor(config.workspaceRoot, id, latest);

  const htmlResult = await readArtifactFrom(iterDir, HTML_ARTIFACT);
  if (htmlResult) {
    return artifactResponse(htmlResult, 'iteration-snapshot');
  }

  const desiredResult: DesiredResult | undefined =
    (row.desired_result as DesiredResult) ?? undefined;
  if (desiredResult === DesiredResult.md || desiredResult === undefined) {
    const rootMd = await readArtifactFrom(wsDir, MD_ARTIFACT);
    if (rootMd) {
      return artifactResponse(rootMd, 'root');
    }
    const mdResult = await readArtifactFrom(iterDir, MD_ARTIFACT);
    if (mdResult) {
      return artifactResponse(mdResult, 'iteration-snapshot');
    }
  }

  return null;
}

export async function getMdArtifact(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<ResultArtifactResponse | null> {
  const row = getIssueRow(db, id);
  if (!row) return null;

  const wsDir = workspaceHostDirFor(config.workspaceRoot, id);

  const rootMd = await readArtifactFrom(wsDir, MD_ARTIFACT);
  if (rootMd) {
    return artifactResponse(rootMd, 'root');
  }

  const latest = latestCompletedIterationId(db, id);
  if (!latest) return null;
  const iterDir = iterationResultDirFor(config.workspaceRoot, id, latest);
  const result = await readArtifactFrom(iterDir, MD_ARTIFACT);
  if (!result) return null;

  return artifactResponse(result, 'iteration-snapshot');
}

export async function getResultFiles(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<WorkspaceFile[] | null> {
  const row = getIssueRow(db, id);
  if (!row) return null;

  if (!latestCompletedIterationId(db, id)) return null;

  const exclude = new Set(ALL_RESULT_ARTIFACTS.map((a) => a.filename));

  return listWorkspaceFiles(config.workspaceRoot, id, exclude);
}

export async function getResultArchive(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<Buffer> {
  const row = getIssueRow(db, id);
  if (!row) {
    throw new Error('issue not found');
  }

  const latest = latestCompletedIterationId(db, id);
  if (!latest) {
    throw new Error('result not found');
  }

  const files = await listWorkspaceFiles(
    config.workspaceRoot,
    id,
    new Set(ALL_RESULT_ARTIFACTS.map((a) => a.filename)),
  );

  const entries: ArchiveEntry[] = [];
  for (const file of files) {
    const abs = workspaceFilePathFor(config.workspaceRoot, id, file.rel_path);
    if (!abs) continue;
    try {
      entries.push({
        name: file.name,
        relPath: file.rel_path,
        body: await readFile(abs),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  const snapshotDir = iterationResultDirFor(config.workspaceRoot, id, latest);
  for (const artifact of ALL_RESULT_ARTIFACTS) {
    const result = await readArtifactFrom(snapshotDir, artifact);
    if (result) {
      entries.push({
        name: artifact.filename,
        relPath: artifact.filename,
        body: Buffer.from(result.body),
      });
    }
  }

  if (entries.length === 0) {
    throw new Error('result not found');
  }

  return createTarGz(entries);
}