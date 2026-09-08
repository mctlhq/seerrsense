import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

/**
 * stdio mode: stdout is the JSON-RPC channel, so every line must be a JSON-RPC
 * message and the server must answer initialize/tools/list without
 * SEERRSENSE_AUTH_TOKEN (the client owns the process).
 */
describe("stdio transport", () => {
  it("serves initialize and tools/list over stdio with clean stdout", async () => {
    const env = { ...process.env, SEERR_API_KEY: "test" };
    delete env.SEERRSENSE_AUTH_TOKEN;
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const deadline = Date.now() + 15000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length, `stdout was:\n${stdout}\nstderr:\n${stderr}`).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => {
      expect(() => JSON.parse(l), `non-JSON line on stdout: ${l}`).not.toThrow();
      return JSON.parse(l);
    });
    for (const msg of parsed) expect(msg.jsonrpc).toBe("2.0");

    const init = parsed.find((m) => m.id === 1);
    expect(init.result.serverInfo.name).toBe("SeerrSense");
    const tools = parsed.find((m) => m.id === 2);
    expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["get_media", "request_media", "resolve_media", "search_media"],
    );
  }, 20000);
});
