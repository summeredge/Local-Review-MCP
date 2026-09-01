export const GIT_ERROR_CODES = [
  "GIT_NOT_FOUND",
  "NOT_A_REPOSITORY",
  "GIT_COMMAND_FAILED",
  "DIFF_TOO_LARGE",
  "BINARY_DIFF",
] as const;

export type GitErrorCode = typeof GIT_ERROR_CODES[number];

export class GitError extends Error {
  public readonly code: GitErrorCode;

  public constructor(code: GitErrorCode, message = "Git operation failed.") {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}
