
import { reportWarningsFor } from '../../workflow/run-iteration.service';
import { DEFAULT_WORKSPACE_ROOT, workspaceHostDirFor } from '../../workspace/paths';
export function artifactWarningHeaders(
  issueId: string,
  workspaceRoot?: string,
): Record<string, string> {
  const hostDir = workspaceHostDirFor(
    workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    issueId,
  );
  const warnings = reportWarningsFor(issueId, hostDir);
  if (warnings.length === 0) return {};
  const value = warnings.join('; ');
  const ascii = /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value);
  return { 'x-artifact-warning': ascii };
}

export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentDisposition(name: string): string {
  const ascii =
    name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}
