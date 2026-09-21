import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const VENDOR = path.join(ROOT, "vendor");

export function fixturePath(name: string): string {
  return path.join(VENDOR, "programs", name);
}

export function hasFixture(name: string): boolean {
  return existsSync(fixturePath(name));
}

export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "latin1");
}

export const ORACLE = path.join(VENDOR, "interp", "unshackled");
export const hasOracle = existsSync(ORACLE);

/** Run Lutter's C interpreter on a program file with the given stdin. */
export function runOracle(programPath: string, input = "", timeoutMs = 60_000): string {
  return execFileSync(ORACLE, [programPath], { input, timeout: timeoutMs, maxBuffer: 64 << 20 }).toString("utf8");
}
