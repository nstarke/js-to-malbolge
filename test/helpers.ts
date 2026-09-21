import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
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
export const ORACLE20 = path.join(VENDOR, "interp", "unshackled20");
export const hasOracle20 = existsSync(ORACLE20);

/** Run generated source without colliding with other parallel test files. */
export function runOracleSource(source: string, oracle = ORACLE, input = "", encoding: BufferEncoding = "utf8"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "js2mb-oracle-"));
  try {
    const file = path.join(dir, "program.mb");
    writeFileSync(file, source, "ascii");
    return execFileSync(oracle, [file], { input, timeout: 10_000, maxBuffer: 64 << 20 }).toString(encoding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Let the test worker process messages while a large source image runs. */
export async function runOracleSourceAsync(source: string, oracle = ORACLE, input = "", timeoutMs = 180_000): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "js2mb-oracle-"));
  try {
    const file = path.join(dir, "program.mb");
    writeFileSync(file, source, "ascii");
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(oracle, [file], { timeout: timeoutMs, maxBuffer: 64 << 20 }, (error, stdout) => {
        if (error) {
          error.message += ` (code=${error.code}, signal=${error.signal})`;
          reject(error);
        } else resolve(stdout);
      });
      child.stdin!.end(input);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run Lutter's C interpreter on a program file with the given stdin. */
export function runOracle(programPath: string, input = "", timeoutMs = 60_000): string {
  return execFileSync(ORACLE, [programPath], { input, timeout: timeoutMs, maxBuffer: 64 << 20 }).toString("utf8");
}
