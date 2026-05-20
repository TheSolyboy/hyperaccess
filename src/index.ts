import { exec } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 10 * 1024 * 1024);

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
// File helpers
// ---------------------------------------------------------------------------

function requireAbsolutePath(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`path must be absolute, got: ${p}`);
  }
  return p;
}

async function atomicWrite(target: string, content: string | Buffer): Promise<number> {
  const tmp = `${target}.tmp.${randomBytes(8).toString("hex")}`;
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  return buf.byteLength;
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

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Reads a UTF-8 file from the host. Truncates the content if the file " +
        "is larger than max_bytes (or MAX_FILE_BYTES).",
      inputSchema: {
        path: z
          .string()
          .min(1, "path must not be empty")
          .describe("Absolute path to the file to read"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum bytes to return; overrides MAX_FILE_BYTES"),
      },
      outputSchema: {
        path: z.string(),
        content: z.string(),
        size: z.number(),
        truncated: z.boolean(),
      },
    },
    async ({ path: filePath, max_bytes }) => {
      const abs = requireAbsolutePath(filePath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        throw new Error(`not a regular file: ${abs}`);
      }
      const limit = max_bytes ?? MAX_FILE_BYTES;
      const buf = await fs.readFile(abs);
      const truncated = buf.byteLength > limit;
      const slice = truncated ? buf.subarray(0, limit) : buf;
      const result = {
        path: abs,
        content: slice.toString("utf8"),
        size: stat.size,
        truncated,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Writes a UTF-8 file atomically (write to temp, then rename). Optionally " +
        "creates parent directories. Fails if overwrite=false and the target exists.",
      inputSchema: {
        path: z
          .string()
          .min(1, "path must not be empty")
          .describe("Absolute path to the file to write"),
        content: z.string().describe("File content (UTF-8)"),
        overwrite: z
          .boolean()
          .optional()
          .default(true)
          .describe("Overwrite an existing file. Default true."),
        create_dirs: z
          .boolean()
          .optional()
          .default(false)
          .describe("mkdir -p the parent directory first. Default false."),
      },
      outputSchema: {
        path: z.string(),
        bytes_written: z.number(),
        created: z.boolean(),
      },
    },
    async ({ path: filePath, content, overwrite, create_dirs }) => {
      const abs = requireAbsolutePath(filePath);
      let existed = false;
      try {
        await fs.stat(abs);
        existed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (existed && !overwrite) {
        throw new Error(`refusing to overwrite existing file: ${abs}`);
      }
      if (create_dirs) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }
      const bytes = await atomicWrite(abs, content);
      const result = { path: abs, bytes_written: bytes, created: !existed };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Replaces a unique occurrence of old_str with new_str in a UTF-8 file. " +
        "Fails if old_str matches zero or more than one location. Atomic write.",
      inputSchema: {
        path: z
          .string()
          .min(1, "path must not be empty")
          .describe("Absolute path to the file to edit"),
        old_str: z
          .string()
          .min(1, "old_str must not be empty")
          .describe("Exact text to replace; must occur exactly once in the file"),
        new_str: z.string().describe("Replacement text"),
      },
      outputSchema: {
        path: z.string(),
        matches: z.number(),
      },
    },
    async ({ path: filePath, old_str, new_str }) => {
      const abs = requireAbsolutePath(filePath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        throw new Error(`not a regular file: ${abs}`);
      }
      const original = await fs.readFile(abs, "utf8");
      const matches = original.split(old_str).length - 1;
      if (matches === 0) {
        throw new Error(`old_str not found in ${abs}`);
      }
      if (matches > 1) {
        throw new Error(
          `old_str matches ${matches} locations in ${abs}; it must be unique`,
        );
      }
      const updated = original.replace(old_str, new_str);
      await atomicWrite(abs, updated);
      const result = { path: abs, matches };
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
