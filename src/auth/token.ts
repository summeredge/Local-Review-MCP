import { timingSafeEqual } from "node:crypto";

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  return /^Bearer[ \t]+([^\s]+)$/iu.exec(header)?.[1];
}

export function tokensMatch(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}
