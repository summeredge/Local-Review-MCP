export type GitChangeType = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface GitStatusEntry {
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly status: GitChangeType;
  readonly original_path?: string;
}

export interface GitStatusResponse {
  readonly branch: string | null;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitDiffOptions {
  readonly path?: string;
  readonly stat?: boolean;
}

export interface GitDiffResponse {
  readonly path: string;
  readonly stat: boolean;
  readonly diff: string;
  readonly files: readonly string[];
  readonly binary: boolean;
  readonly binary_paths?: readonly string[];
}
