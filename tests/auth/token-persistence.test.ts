import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthTokenStore } from "../../src/auth/token.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), chmodSync: vi.fn(actual.chmodSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
  vi.mocked(fs.chmodSync).mockReset().mockImplementation(actual.chmodSync);
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("keeps refresh credentials consistent after EPERM and rotates after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "lrm-token-persistence-"));
  directories.push(root);
  const path = join(root, "tokens.json");
  const store = new OAuthTokenStore({ path });
  const issued = store.issue("resource", "client");
  const before = await readFile(path, "utf8");
  vi.mocked(fs.renameSync).mockImplementation(() => { throw Object.assign(new Error("occupied"), { code: "EPERM" }); });
  expect(() => store.rotate(issued.refreshToken, "client", "resource")).toThrow("could not be saved");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(store.validate(issued.token, "resource")).toBe(true);
  expect(() => store.delete(issued.token)).toThrow("could not be saved");
  expect(store.validate(issued.token, "resource")).toBe(true);
  expect(() => store.issue("resource", "client")).toThrow("could not be saved");
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.chmodSync).mockImplementation((target, mode) => {
    if (String(target).endsWith(".tmp")) throw Object.assign(new Error("occupied"), { code: "EPERM" });
    return actual.chmodSync(target, mode);
  });
  expect(() => store.rotate(issued.refreshToken, "client", "resource")).toThrow("could not be saved");
  expect(await readFile(path, "utf8")).toBe(before);
  vi.mocked(fs.chmodSync).mockImplementation(actual.chmodSync);
  const rotated = store.rotate(issued.refreshToken, "client", "resource")!;
  expect(rotated).not.toBeNull();
  expect(store.rotate(issued.refreshToken, "client", "resource")).toBeNull();
  const restored = new OAuthTokenStore({ path });
  expect(restored.rotate(issued.refreshToken, "client", "resource")).toBeNull();
  expect(restored.validate(rotated.token, "resource")).toBe(true);
  expect(store.rotate(rotated.refreshToken, "wrong-client", "resource")).toBeNull();
  expect(store.rotate(rotated.refreshToken, "client", "wrong-resource")).toBeNull();
  expect(restored.rotate(rotated.refreshToken, "client", "resource")).not.toBeNull();
});
