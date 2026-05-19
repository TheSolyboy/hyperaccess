import { exec } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3420);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_KEY = process.env.API_KEY ?? "";
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 0);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 10 * 1024 * 1024);

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

if (API_KEY.trim() === "") {
  fatal("API_KEY is not set. Define it in .env.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fatal(`Invalid PORT: ${process.env.PORT}`);
}

// run_command runs arbitrary commands. Running as root would turn that into a
// privilege escalation, so refuse to start.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  fatal("refusing to run as root. Start the service as an unprivileged user.");
}

// ---------------------------------------------------------------------------
// API key authentication (constant time)
// ---------------------------------------------------------------------------

const API_KEY_HASH = createHash("sha256").update(API_KEY).digest();

function isValidApiKey(provided: string | undefined): boolean {
  if (!provided) return false;
  // Hashing yields equal-length buffers, so the comparison leaks no length.
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(providedHash, API_KEY_HASH);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

function runCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        timeout: COMMAND_TIMEOUT_MS > 0 ? COMMAND_TIMEOUT_MS : 0,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout,
            stderr,
            exitCode: typeof error.code === "number" ? error.code : null,
            signal: error.signal ?? null,
            timedOut: error.killed === true && error.signal === "SIGTERM",
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0, signal: null, timedOut: false });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "hyperaccess",
    version: "1.0.0",
  });

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Runs a shell command on the host and returns stdout, stderr and the " +
        "exit code. The command runs through the system's default shell.",
      inputSchema: {
        command: z
          .string()
          .min(1, "command must not be empty")
          .describe("The shell command to run"),
      },
      outputSchema: {
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        timedOut: z.boolean(),
      },
    },
    async ({ command }) => {
      const result = await runCommand(command);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "hyperaccess" });
});

// Authentication for all /mcp routes.
// The key can be sent either in the x-api-key header or as an ?api_key= query
// parameter, since some MCP clients cannot send custom headers.
app.use("/mcp", (req: Request, res: Response, next) => {
  const headerKey = req.header("x-api-key");
  const queryKey = typeof req.query.api_key === "string" ? req.query.api_key : undefined;
  if (!isValidApiKey(headerKey) && !isValidApiKey(queryKey)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized: missing or invalid API key (x-api-key header or ?api_key=)",
      },
      id: null,
    });
    return;
  }
  next();
});

// Stateless mode: each request gets its own server and transport instance.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET (SSE) and DELETE (session) are unused in stateless mode.
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`hyperaccess MCP server listening on http://${HOST}:${PORT}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down.`);
    httpServer.close(() => process.exit(0));
  });
}
