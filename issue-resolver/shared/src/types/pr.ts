export interface MergeRequestEntry {
  repository_url: string;
  url: string;
  title?: string;
  message?: string;
}

export interface StepReportMrEntry {
  repository_url: string;
  title: string;
  description: string;
}