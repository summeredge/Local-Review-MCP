import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(testsDirectory, "..");
const sourceDirectory = join(projectDirectory, "src");

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? findTypeScriptFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [path]
        : [];
  }));
  return files.flat();
}

describe("production static boundaries", () => {
  it("defines the default port only in config/settings.ts", async () => {
    const files = await findTypeScriptFiles(sourceDirectory);
    const occurrences = (await Promise.all(files.map(async (path) => {
      const source = await readFile(path, "utf8");
      return [...source.matchAll(/\b12080\b/g)].map(() => path);
    }))).flat();

    expect(occurrences).toHaveLength(1);
    expect(relative(projectDirectory, occurrences[0]).replaceAll("\\", "/")).toBe("src/config/settings.ts");
  });
});
