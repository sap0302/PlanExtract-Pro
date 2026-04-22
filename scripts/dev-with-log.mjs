// Cross-platform wrapper around `next dev --webpack` that mirrors stdout and
// stderr to a log file. Used by `npm run dev` so that any extraction error,
// stack trace, or build failure is captured to disk automatically — without
// relying on shell redirection (tee / Tee-Object) which doesn't work the
// same in CMD, PowerShell, and Git Bash.
//
// Log file: <project>/.next/dev-server.log (gitignored)
// Behavior:
//   - Appends to the log on every restart (with a session separator line)
//   - Truncates if the file grows past 20 MB (keeps last ~80% to preserve
//     recent history but avoid unbounded growth)
//   - Forwards Ctrl+C / SIGTERM to the Next.js child so the server shuts
//     down cleanly

import { spawn } from "node:child_process";
import {
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const LOG_PATH = resolve(".next", "dev-server.log");
const NEXT_BIN = resolve("node_modules", "next", "dist", "bin", "next");
const MAX_LOG_BYTES = 20 * 1024 * 1024; // 20 MB

// Ensure the .next directory exists before opening the log file
try {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
} catch {
  // ignore
}

// If the log file is already over the size limit, rotate it in place:
// keep the last 80% of the file so we retain recent context.
try {
  const st = statSync(LOG_PATH);
  if (st.size > MAX_LOG_BYTES) {
    const buf = readFileSync(LOG_PATH);
    const keep = buf.subarray(Math.floor(buf.length * 0.2));
    writeFileSync(LOG_PATH, keep);
  }
} catch {
  // no file yet, or stat failed — no-op
}

const fd = openSync(LOG_PATH, "a");
const SEP = `\n\n=== dev server started at ${new Date().toISOString()} (pid ${process.pid}) ===\n`;
writeSync(fd, SEP);

function writeLog(chunk) {
  try {
    writeSync(fd, chunk);
  } catch {
    // log write failed — keep running, don't crash the dev server
  }
}

// Spawn Next.js directly via its bin script — avoids the cost and quoting
// quirks of going through cmd.exe / npm again.
//
// NODE_OPTIONS=--max-old-space-size=8192 raises the V8 heap ceiling from the
// default ~2 GB to 8 GB. Necessary for large civil plan PDFs (100+ MB),
// which during extraction hold: original buffer, chunked sub-buffers,
// base64 strings (1.34× raw), rendered page images, and 2 chunks worth of
// parallel extraction state. A 109 MB PDF can easily push 3-4 GB transient
// memory, which OOMs at the 2 GB default.
//
// User can override by setting NODE_OPTIONS in their own environment; we
// only merge in the flag if it's not already present.
const childEnv = { ...process.env };
const HEAP_FLAG = "--max-old-space-size=8192";
if (!childEnv.NODE_OPTIONS) {
  childEnv.NODE_OPTIONS = HEAP_FLAG;
} else if (!childEnv.NODE_OPTIONS.includes("--max-old-space-size")) {
  childEnv.NODE_OPTIONS = `${childEnv.NODE_OPTIONS} ${HEAP_FLAG}`;
}

const child = spawn(
  process.execPath,
  [NEXT_BIN, "dev", "--webpack"],
  {
    stdio: ["inherit", "pipe", "pipe"],
    env: childEnv,
  }
);

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  writeLog(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  writeLog(chunk);
});

child.on("exit", (code, signal) => {
  try {
    writeSync(
      fd,
      `\n=== dev server exited at ${new Date().toISOString()} (code=${code}, signal=${signal}) ===\n`
    );
    closeSync(fd);
  } catch {
    // ignore
  }
  process.exit(code ?? 0);
});

// Forward Ctrl+C and termination so the child gets a chance to shut down.
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
