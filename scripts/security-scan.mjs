// Repeatable local security checks for Memlane.
//
// Runs:
// - TypeScript build, so proof scripts exercise current source.
// - npm audit, failing on any reported vulnerability.
// - path traversal regression proof.
// - high-confidence secret pattern scan over repo text files.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  ".graymatter",
  "dist",
  "node_modules",
]);
const SKIP_FILES = new Set(["package-lock.json"]);
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const SECRET_PATTERNS = [
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{80,})\b/g },
  { name: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

function run(label, cmd, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function runAudit() {
  console.log("\n=== npm audit ===");
  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  let audit;
  try {
    audit = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`npm audit returned invalid JSON:\n${result.stdout}`);
  }
  const total = audit.metadata?.vulnerabilities?.total ?? 0;
  console.log(`vulnerabilities: ${total}`);
  if (total !== 0 || result.status !== 0) {
    console.log(JSON.stringify(audit.vulnerabilities ?? audit, null, 2));
    throw new Error("npm audit reported vulnerabilities");
  }
}

async function listFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full));
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function readTextIfSafe(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_TEXT_FILE_BYTES) return null;
  const buf = await fs.readFile(file);
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

function redact(value) {
  if (value.length <= 10) return "[REDACTED]";
  return `${value.slice(0, 4)}...[${value.length - 8} chars]...${value.slice(-4)}`;
}

async function scanSecrets() {
  console.log("\n=== secret pattern scan ===");
  const findings = [];
  for (const file of await listFiles(ROOT)) {
    const text = await readTextIfSafe(file);
    if (text === null) continue;
    const rel = path.relative(ROOT, file);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(line)) !== null) {
          findings.push({
            file: rel,
            line: i + 1,
            pattern: pattern.name,
            match: redact(match[0]),
          });
        }
      }
    }
  }

  if (findings.length) {
    console.log(JSON.stringify(findings, null, 2));
    throw new Error(`${findings.length} high-confidence secret pattern(s) found`);
  }
  console.log("no high-confidence secret patterns found");
}

try {
  run("build", "npm", ["run", "build"]);
  runAudit();
  run("path safety proof", "node", ["scripts/proof-path-safety.mjs"]);
  await scanSecrets();
  console.log("\nALL SECURITY CHECKS PASSED");
} catch (err) {
  console.error(`\nSECURITY SCAN FAILED: ${(err && err.message) || err}`);
  process.exit(1);
}
