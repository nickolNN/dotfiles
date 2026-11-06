import { RepoPlatform } from '@issue-resolver/shared';

export const PLATFORM_LABELS: Record<RepoPlatform, string> = {
  [RepoPlatform.github]: 'GitHub',
  [RepoPlatform.gitlab]: 'GitLab',
  [RepoPlatform.bitbucket]: 'Bitbucket',
  [RepoPlatform.unknown]: 'Repo',
};

export const PLATFORM_CHIP_CLASSES: Record<RepoPlatform, string> = {
  [RepoPlatform.github]: 'border-[#00FF41] text-[#00FF41]',
  [RepoPlatform.gitlab]: 'border-[#00FF41] text-[#00FF41]',
  [RepoPlatform.bitbucket]: 'border-[#2684FF] bg-[#001B4D]/40 text-[#5CA8FF]',
  [RepoPlatform.unknown]: 'border-[#008F11] text-[#00FF41]/70',
};