import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A control character in a source file is not a style question. A literal NUL
 * made git treat src/auth/store.ts as binary: its diffs collapsed to "Binary
 * files differ", GitHub refused review comments on it, and a change to the
 * AuthStore interface shipped unreviewable. Cheap to check, expensive to miss,
 * so it is checked here rather than remembered.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Everything below U+0020 except tab, newline and carriage return, plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

describe("source hygiene", () => {
  it("has no control characters in any TypeScript source", () => {
    const offenders: string[] = [];
    for (const path of [...sourceFiles("src"), ...sourceFiles("tests")]) {
      const text = readFileSync(path, "utf8");
      const match = CONTROL.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split("\n").length;
        const code = match[0].charCodeAt(0).toString(16).padStart(4, "0");
        offenders.push(`${path}:${line} contains U+${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
