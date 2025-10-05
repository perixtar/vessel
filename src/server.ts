import express from "express";
import { spawn } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "128kb" }));

// Health for ALB
app.get("/", (_req, res) => res.status(200).send("OK"));

// Use a clean directory so Claude won't scan your app workspace
const WORKDIR = "/workspace";
try {
  fs.mkdirSync(WORKDIR, { recursive: true });
} catch {
  /* ignore */
}

// POST /ask  { prompt: string, timeoutMs?: number }
app.post("/ask", (req, res) => {
  const { prompt, timeoutMs } = req.body ?? {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt (string) required" });
  }

  // If running as root, DO NOT pass --dangerously-skip-permissions (blocked by CLI)
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  // Keep it minimal: print mode, text output, strict to skip IDE/MCP discovery
  // Use a stable model alias if you want; or omit --model to let CLI choose default.
  const model = process.env.CLAUDE_MODEL; // e.g., "sonnet"
  const args = [
    "-p",
    "--output-format",
    "text",
    "--strict-mcp-config",
    ...(isRoot ? [] : ["--dangerously-skip-permissions"]), // <- omit for simplicity & root-safe
    ...(model ? ["--model", model] : []),
    prompt,
  ];

  const child = spawn("claude", args, {
    cwd: WORKDIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "",
    stderr = "";

  // Stream everything exactly as the terminal would produce
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Kill the child if it runs too long (keep < ALB idle timeout)
  const maxMs = Math.min(Number(timeoutMs || 50_000), 55_000);
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {}
  }, maxMs);

  child.on("close", (code) => {
    clearTimeout(timer);
    res.status(200).json({
      code: typeof code === "number" ? code : -1,
      stdout,
      stderr,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    res.status(500).json({ error: err.message || String(err) });
  });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Server on ${port}`));
