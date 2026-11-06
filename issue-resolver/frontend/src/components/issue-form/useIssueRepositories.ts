import { useEffect, useRef, useState } from 'react';
import type { SavedRepo, Tag } from '@issue-resolver/shared';
import { getRepositoryBranches } from '../../api/client';
import { messageOf } from '../../lib/errors';
import { useSavedRepos, useTags } from '../../stores/queries';
import type { RepoRowData } from '../RepoRow';
import type { InitialRepository } from './types';

function withBranches(
  repository: RepoRowData,
  branches: string[],
): RepoRowData {
  const options =
    repository.base_branch && !branches.includes(repository.base_branch)
      ? [repository.base_branch, ...branches]
      : branches;
  return { ...repository, branches: options, branchesLoading: false };
}

function loadBranches(
  repoId: string,
  matches: (repository: RepoRowData, index: number) => boolean,
  setRepositories: (
    update: (current: RepoRowData[]) => RepoRowData[],
  ) => void,
  isCancelled: () => boolean = () => false,
) {
  void getRepositoryBranches(repoId)
    .then((branches) => {
      if (isCancelled()) return;
      setRepositories((current) =>
        current.map((repository, index) =>
          matches(repository, index)
            ? withBranches(repository, branches)
            : repository,
        ),
      );
    })
    .catch(() => {
      if (isCancelled()) return;
      setRepositories((current) =>
        current.map((repository, index) =>
          matches(repository, index)
            ? { ...repository, branchesLoading: false }
            : repository,
        ),
      );
    });
}

interface IssueRepositories {
  repositories: RepoRowData[];
  savedRepos: SavedRepo[];
  savedReposLoading: boolean;
  savedReposErrorText: string | null;
  tags: Tag[];
  mrRepositories: RepoRowData[];
  updateBaseBranch: (index: number, value: string) => void;
  selectRepository: (index: number, repoId: string) => void;
  selectTag: (tagId: string) => void;
  addRepository: () => void;
  toggleRepositoryBootstrap: (index: number) => void;
  removeRepository: (index: number) => void;
}

export function useIssueRepositories(
  initial?: InitialRepository[],
): IssueRepositories {
  const [repositories, setRepositories] = useState<RepoRowData[]>(() =>
    (initial ?? []).map((repository) => ({
      repo_id: repository.repo_id,
      repository_url: repository.repository_url,
      base_branch: repository.base_branch,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
      branches: [],
      branchesLoading: Boolean(repository.repo_id),
    })),
  );

  const {
    data: savedRepos = [],
    isLoading: savedReposLoading,
    error: savedReposError,
  } = useSavedRepos();
  const { data: tags = [] } = useTags();
  const savedReposErrorText = savedReposError
    ? messageOf(savedReposError)
    : null;

  const initialRepositoriesRef = useRef(initial);
  useEffect(() => {
    const initialRows = initialRepositoriesRef.current ?? [];
    let cancelled = false;

    for (const row of initialRows) {
      if (!row.repo_id) continue;
      loadBranches(
        row.repo_id,
        (repository) => repository.repo_id === row.repo_id,
        setRepositories,
        () => cancelled,
      );
    }

    return () => {
      cancelled = true;
    };
  }, []);

  function updateBaseBranch(index: number, value: string) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index ? { ...repository, base_branch: value } : repository,
      ),
    );
  }

  function selectRepository(index: number, repoId: string) {
    const saved = savedRepos.find((repo) => repo.id === repoId);
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index
          ? {
              ...repository,
              repo_id: repoId,
              base_branch: saved?.defaultBranch ?? '',
              branches: [],
              branchesLoading: Boolean(repoId),
            }
          : repository,
      ),
    );

    if (!repoId) return;
    loadBranches(
      repoId,
      (repository, i) => i === index && repository.repo_id === repoId,
      setRepositories,
    );
  }

  function selectTag(tagId: string) {
    const tag = tags.find((item) => item.id === tagId);
    if (!tag) return;

    const existing = new Set(
      repositories.map((repository) => repository.repo_id),
    );
    const additions: RepoRowData[] = [];
    for (const tr of tag.repositories) {
      const repoId = tr.repository.id;
      if (!repoId || existing.has(repoId)) continue;
      existing.add(repoId);
      additions.push({
        repo_id: repoId,
        base_branch: tr.repository.defaultBranch ?? '',
        bootstrap_enabled: tr.bootstrap_enabled,
        branches: [],
        branchesLoading: true,
      });
    }
    if (additions.length === 0) return;

    setRepositories((current) => [...current, ...additions]);

    for (const row of additions) {
      loadBranches(
        row.repo_id,
        (repository) => repository.repo_id === row.repo_id,
        setRepositories,
      );
    }
  }

  function addRepository() {
    setRepositories((current) => [
      ...current,
      {
        repo_id: '',
        base_branch: '',
        bootstrap_enabled: true,
        branches: [],
        branchesLoading: false,
      },
    ]);
  }

  function toggleRepositoryBootstrap(index: number) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index
          ? {
              ...repository,
              bootstrap_enabled: !repository.bootstrap_enabled,
            }
          : repository,
      ),
    );
  }

  function removeRepository(index: number) {
    setRepositories((current) => current.filter((_, i) => i !== index));
  }

  const mrRepositories = repositories.filter(
    (repository) =>
      repository.repo_id &&
      savedRepos.find((repo) => repo.id === repository.repo_id)
        ?.writeAccess === true,
  );

  return {
    repositories,
    savedRepos,
    savedReposLoading,
    savedReposErrorText,
    tags,
    mrRepositories,
    updateBaseBranch,
    selectRepository,
    selectTag,
    addRepository,
    toggleRepositoryBootstrap,
    removeRepository,
  };
}