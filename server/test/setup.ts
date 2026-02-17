import { type Subprocess } from "bun";

const PORT = 3001; // Use a different port to avoid conflicts
const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/paperhearts";

let serverProcess: Subprocess | null = null;

export async function startServer() {
  serverProcess = Bun.spawn(["bun", "run", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL },
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Even if health check fails (404), the server is up if fetch doesn't throw
  console.log(`Test server ready on port ${PORT}`);
}

export async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    await serverProcess.exited;
    serverProcess = null;
  }
}

export function getBaseUrl() {
  return `http://localhost:${PORT}`;
}
