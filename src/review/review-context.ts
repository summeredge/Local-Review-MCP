import { GitService } from "../git/service.js";
import type { GitChangeType, GitDiffResponse, GitStatusEntry } from "../git/types.js";
import type { WorkspaceSelection } from "../workspace/registry.js";

export interface WorkspaceReviewInfo {
  readonly workspace_id: string;
  readonly root: "workspace:/";
  readonly branch: string | null;
  readonly status: "clean" | "dirty";
}

export interface WorkspaceReviewContext {
  readonly workspace_id: string;
  readonly git_status: {
    readonly branch: string | null;
    readonly status: "clean" | "dirty";
    readonly entries: readonly GitStatusEntry[];
  };
  readonly changed_files: readonly string[];
  readonly diff_summary: {
    readonly files_changed: number;
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly diff: {
    readonly staged: string;
    readonly unstaged: string;
  };
  readonly review_candidates: readonly {
    readonly path: string;
    readonly status: GitChangeType;
  }[];
}

function lineCounts(...diffs: GitDiffResponse[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    for (const line of diff.diff.split(/\r?\n/u)) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { insertions, deletions };
}

export class ReviewContextService {
  public constructor(private readonly workspace: WorkspaceSelection) {}

  public async info(): Promise<WorkspaceReviewInfo> {
    const status = await new GitService(this.workspace.manager).status();
    return {
      workspace_id: this.workspace.id,
      root: "workspace:/",
      branch: status.branch,
      status: status.entries.length === 0 ? "clean" : "dirty",
    };
  }

  public async context(): Promise<WorkspaceReviewContext> {
    const git = new GitService(this.workspace.manager);
    const [status, staged, unstaged] = await Promise.all([
      git.status(),
      git.diff({ cached: true }),
      git.diff(),
    ]);
    const changedFiles = [...new Set([
      ...status.entries.map((entry) => entry.path),
      ...staged.files,
      ...unstaged.files,
    ])].sort();
    return {
      workspace_id: this.workspace.id,
      git_status: {
        branch: status.branch,
        status: status.entries.length === 0 ? "clean" : "dirty",
        entries: status.entries,
      },
      changed_files: changedFiles,
      diff_summary: {
        files_changed: changedFiles.length,
        ...lineCounts(staged, unstaged),
      },
      diff: {
        staged: staged.diff,
        unstaged: unstaged.diff,
      },
      review_candidates: status.entries.map(({ path, status: changeStatus }) => ({
        path,
        status: changeStatus,
      })),
    };
  }
}
