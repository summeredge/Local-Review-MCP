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

export interface ReviewSnapshot {
  readonly branch: string | null;
  readonly head: string;
  readonly diff_sha256: string;
}

export function sameReviewSnapshot(
  left: ReviewSnapshot,
  right: ReviewSnapshot,
): boolean {
  return left.branch === right.branch
    && left.head === right.head
    && left.diff_sha256 === right.diff_sha256;
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
