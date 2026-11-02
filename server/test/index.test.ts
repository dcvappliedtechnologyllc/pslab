import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe("server process", () => {
  // The MCP host (Claude Desktop, Claude Code) owns the server's stdin. When the
  // host goes away the server must exit, or it lingers as an orphan that keeps
  // the port and every later server reports PORT_BUSY against a pslab nobody can see.
  it("exits and frees the port when its stdin closes", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PSLAB_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    try {
      await expect.poll(() => stderr, { timeout: 15000 }).toContain(`bridge listening on 127.0.0.1:${port}`);
      await expect.poll(() => stderr, { timeout: 5000 }).toContain("MCP server ready");
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin.end();
      await expect(Promise.race([exited, new Promise((_, r) => setTimeout(() => r(new Error("still running 3 s after stdin closed")), 3000))])).resolves.toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30000);

  it("a second server process on the same port follows the first", async () => {
    const port = await freePort();
    const env = { ...process.env, PSLAB_PORT: String(port) };
    const start = () => spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    const first = start();
    let second: ReturnType<typeof start> | null = null;
    let err1 = "";
    let err2 = "";
    first.stderr.on("data", (d) => (err1 += d));
    try {
      await expect.poll(() => err1, { timeout: 15000 }).toContain(`bridge listening on 127.0.0.1:${port}`);
      second = start();
      second.stderr.on("data", (d) => (err2 += d));
      await expect.poll(() => err2, { timeout: 15000 }).toContain(`following owner pid ${first.pid} on 127.0.0.1:${port}`);
    } finally {
      for (const c of [first, second]) {
        if (!c || c.exitCode !== null) continue;
        const exited = new Promise((r) => c.once("exit", r));
        c.kill("SIGKILL");
        await exited;
      }
    }
  }, 40000);
});
