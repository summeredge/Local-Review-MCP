import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceManager } from "../workspace/manager.js";
import { GitService } from "./service.js";
import { sameReviewSnapshot, type ReviewSnapshot } from "./types.js";

const runProcess = promisify(execFile);

export interface ReviewSnapshotDiagnosticResult {
  readonly baseline: ReviewSnapshot;
  readonly same_status: "CURRENT" | "STALE_REVIEW";
  readonly diff_mismatch: "CURRENT" | "STALE_REVIEW";
  readonly head_mismatch: "CURRENT" | "STALE_REVIEW";
  readonly branch_mismatch: "CURRENT" | "STALE_REVIEW";
}

function comparison(original: ReviewSnapshot, current: ReviewSnapshot): "CURRENT" | "STALE_REVIEW" {
  return sameReviewSnapshot(original, current) ? "CURRENT" : "STALE_REVIEW";
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await runProcess("git", args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

export async function generateReviewSnapshotExample(): Promise<ReviewSnapshotDiagnosticResult> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-review-snapshot-"));
  try {
    await git(workspace, "init", "-b", "main");
    await git(workspace, "config", "user.email", "test@example.invalid");
    await git(workspace, "config", "user.name", "Local Review Diagnostic");
    await writeFile(join(workspace, "app.txt"), "first");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "initial");
    const snapshots = new GitService(new WorkspaceManager(workspace));
    const baseline = await snapshots.snapshot();
    const repeated = await snapshots.snapshot();
    await writeFile(join(workspace, "app.txt"), "second");
    const changed = await snapshots.snapshot();
    await git(workspace, "add", "app.txt");
    await git(workspace, "commit", "-m", "second");
    const advanced = await snapshots.snapshot();
    await git(workspace, "checkout", "-b", "feature");
    const branched = await snapshots.snapshot();
    const result: ReviewSnapshotDiagnosticResult = {
      baseline,
      same_status: comparison(baseline, repeated),
      diff_mismatch: comparison(baseline, changed),
      head_mismatch: comparison(baseline, advanced),
      branch_mismatch: comparison(baseline, branched),
    };
    if (result.same_status !== "CURRENT"
      || result.diff_mismatch !== "STALE_REVIEW"
      || result.head_mismatch !== "STALE_REVIEW"
      || result.branch_mismatch !== "STALE_REVIEW") {
      throw new Error("Review snapshot diagnostic did not verify the expected workspace states.");
    }
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
