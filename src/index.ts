#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  KnowledgeStore,
  listWorkstreams,
  DEFAULT_RELATION_VOCABULARY,
  STATE_FIELDS,
  DEFAULT_STATE_NAME,
} from "./store.js";
import { StoredEntity, type Relation, entityShape, relationShape } from "./types.js";
import { Telemetry, instrument } from "./telemetry.js";
import { loadLLMConfig, chat, loadEmbedConfig, embed } from "./llm.js";
import { VectorIndex, type VectorRecord } from "./vectors.js";
import fs from "node:fs/promises";

function resolveKnowledgeDir(): string {
  const raw = process.env.KNOWLEDGE_DIR;
  if (!raw) {
    process.stderr.write(
      "[memlane] FATAL: KNOWLEDGE_DIR env var not set\n"
    );
    process.exit(1);
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function reply(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function project(e: StoredEntity, root: string) {
  return {
    name: e.name,
    entityType: e.entityType,
    observations: e.observations,
    ...(e.content !== undefined ? { content: e.content } : {}),
    ...(e.gist !== undefined ? { gist: e.gist } : {}),
    tags: e.tags,
    updated: e.updated,
    filePath: path.relative(root, e.filePath),
  };
}

function resolveWorkstreamsRoot(knowledgeDir: string): string {
  const raw = process.env.WORKSTREAMS_ROOT;
  if (raw && raw.trim()) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  // Default: parent of the parent of KNOWLEDGE_DIR
  // (KNOWLEDGE_DIR=<workstream>/knowledge → parent = <workstream>, parent.parent = workstreams root)
  return path.dirname(path.dirname(knowledgeDir));
}

type DoctorFinding = {
  code: string;
  message: string;
  details?: unknown;
};

type InitOptions = {
  dir: string;
  name: string;
  gist: string;
  only: Set<string> | null;
  skip: Set<string>;
  withOllama: boolean;
  json: boolean;
};

type InitStep = {
  label: string;
  path?: string;
  status: "created" | "updated" | "exists" | "skipped";
  message?: string;
};

const MEMLANE_BLOCK_BEGIN = "<!-- MEMLANE:BEGIN -->";
const MEMLANE_BLOCK_END = "<!-- MEMLANE:END -->";

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out.sort();
}

function printCliHelp() {
  process.stdout.write(`Memlane gives AI agents durable operational memory.

Usage:
  memlane                 Start the MCP server over stdio (backward compatible)
  memlane mcp serve       Start the MCP server over stdio
  memlane init [flags]    Initialise a workstream and wire MCP clients

Init flags:
  --dir <path>            Knowledge directory (default: knowledge)
  --name <id>             Workstream id (default: current directory name)
  --gist <summary>        Workstream summary
  --only <csv>            Writers to run: claude,cursor,codex,opencode,instructions
  --skip-claude           Do not write .mcp.json
  --skip-cursor           Do not write .cursor/mcp.json
  --skip-codex            Do not write ~/.codex/config.toml
  --skip-opencode         Do not write opencode.jsonc
  --skip-instructions     Do not update AGENTS.md / CLAUDE.md
  --with-ollama           Add local Ollama embedding env to MCP configs
  --json                  Print machine-readable init result
`);
}

function parseInitOptions(args: string[]): InitOptions {
  const cwdName = path.basename(process.cwd()) || "memlane-workstream";
  const opts: InitOptions = {
    dir: "knowledge",
    name: cwdName,
    gist: `Memlane workstream for ${cwdName}.`,
    only: null,
    skip: new Set(),
    withOllama: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (!v) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--dir":
        opts.dir = next();
        break;
      case "--name":
        opts.name = next();
        break;
      case "--gist":
        opts.gist = next();
        break;
      case "--only":
        opts.only = new Set(
          next()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        );
        break;
      case "--skip-claude":
        opts.skip.add("claude");
        break;
      case "--skip-cursor":
        opts.skip.add("cursor");
        break;
      case "--skip-codex":
        opts.skip.add("codex");
        break;
      case "--skip-opencode":
        opts.skip.add("opencode");
        break;
      case "--skip-instructions":
        opts.skip.add("instructions");
        break;
      case "--with-ollama":
        opts.withOllama = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        printCliHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown init flag: ${a}`);
    }
  }
  return opts;
}

function shouldRunWriter(opts: InitOptions, name: string): boolean {
  if (opts.only && !opts.only.has(name)) return false;
  return !opts.skip.has(name);
}

function mcpEnv(opts: InitOptions): Record<string, string> {
  const env: Record<string, string> = { KNOWLEDGE_DIR: opts.dir };
  if (opts.withOllama) {
    env.MEMLANE_EMBED_BASE_URL = "http://127.0.0.1:11434/v1";
    env.MEMLANE_EMBED_API_KEY = "ollama";
    env.MEMLANE_EMBED_MODEL = "nomic-embed-text";
  }
  return env;
}

async function readJsonFile(filePath: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const stripped = raw
      .replace(/^\uFEFF/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const parsed = stripped.trim() ? JSON.parse(stripped) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<InitStep["status"]> {
  let prior: string | null = null;
  try {
    prior = await fs.readFile(filePath, "utf8");
  } catch {
    // missing
  }
  const next = JSON.stringify(data, null, 2) + "\n";
  if (prior === next) return "exists";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next);
  return prior === null ? "created" : "updated";
}

async function upsertMcpJson(
  filePath: string,
  opts: InitOptions
): Promise<InitStep> {
  const data = await readJsonFile(filePath);
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers.memlane = {
    command: "memlane",
    env: mcpEnv(opts),
  };
  const status = await writeJsonFile(filePath, data);
  return { label: "MCP config", path: filePath, status };
}

async function upsertOpenCodeConfig(opts: InitOptions): Promise<InitStep> {
  const filePath = path.resolve(process.cwd(), "opencode.jsonc");
  const data = await readJsonFile(filePath);
  data.$schema = data.$schema ?? "https://opencode.ai/config.json";
  data.mcp = data.mcp ?? {};
  data.mcp.memlane = {
    command: ["memlane"],
    enabled: true,
    environment: mcpEnv(opts),
    type: "local",
  };
  const status = await writeJsonFile(filePath, data);
  return { label: "OpenCode MCP", path: filePath, status };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineEnv(env: Record<string, string>): string {
  return `{ ${Object.entries(env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(", ")} }`;
}

async function upsertCodexConfig(opts: InitOptions): Promise<InitStep> {
  const filePath = path.join(os.homedir(), ".codex", "config.toml");
  let prior = "";
  try {
    prior = await fs.readFile(filePath, "utf8");
  } catch {
    // missing
  }
  const block = `[mcp_servers.memlane]
command = "memlane"
env = ${tomlInlineEnv(mcpEnv(opts))}
`;
  const re = /(?:^|\n)\[mcp_servers\.memlane\]\n(?:[^\n]*(?:\n|$))*?(?=\n\[|\s*$)/m;
  const next = re.test(prior)
    ? prior.replace(re, `${prior.startsWith("[mcp_servers.memlane]") ? "" : "\n"}${block}`)
    : `${prior.trimEnd()}${prior.trim() ? "\n\n" : ""}${block}`;
  if (prior === next) return { label: "Codex MCP", path: filePath, status: "exists" };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next.endsWith("\n") ? next : next + "\n");
  return {
    label: "Codex MCP",
    path: filePath,
    status: prior ? "updated" : "created",
  };
}

function memlaneInstructionBlock(opts: InitOptions): string {
  return `${MEMLANE_BLOCK_BEGIN}
## Memlane MCP

This workstream uses Memlane for durable operational memory in \`${opts.dir}/\`.

Default tool path:
- Start with \`memlane.bootstrap\`.
- Use \`memlane.doctor\` before high-risk work or handoff.
- Use \`memlane.get_state\` / \`memlane.set_state\` for phase, next action, rollback, and validation state.
- Use \`memlane.reflect\` for day-to-day observations and relation edits.
- Use \`memlane.neighbors\` for graph traversal.
- Use \`memlane.recent_activity\` after a pause to see what changed lately.
- Use \`memlane.search_nodes\` when you remember exact words and want snippets.
- Use \`memlane.semantic_search\` when recall is fuzzy.

Keep writes factual and dated when verified against live systems. Do not store secrets.
${MEMLANE_BLOCK_END}`;
}

async function findInstructionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "knowledge",
    ".graymatter",
    ".cursor",
  ]);
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && (e.name === "AGENTS.md" || e.name === "CLAUDE.md")) {
        out.push(full);
      }
    }
  };
  await walk(root, 0);
  return [...new Set(out)].sort();
}

async function upsertInstructionBlock(filePath: string, block: string): Promise<InitStep> {
  let prior = "";
  try {
    prior = await fs.readFile(filePath, "utf8");
  } catch {
    // missing
  }
  const re = new RegExp(
    `${MEMLANE_BLOCK_BEGIN}[\\s\\S]*?${MEMLANE_BLOCK_END}`,
    "m"
  );
  const next = re.test(prior)
    ? prior.replace(re, block)
    : `${prior.trimEnd()}${prior.trim() ? "\n\n" : ""}${block}\n`;
  if (prior === next) return { label: "Agent instructions", path: filePath, status: "exists" };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next.endsWith("\n") ? next : next + "\n");
  return {
    label: "Agent instructions",
    path: filePath,
    status: prior ? "updated" : "created",
  };
}

async function updateInstructionFiles(opts: InitOptions): Promise<InitStep[]> {
  const root = process.cwd();
  let files = await findInstructionFiles(root);
  if (files.length === 0) {
    files = [path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md")];
  }
  const block = memlaneInstructionBlock(opts);
  const steps: InitStep[] = [];
  for (const file of files) {
    steps.push(await upsertInstructionBlock(file, block));
  }
  return steps;
}

async function runInit(args: string[]): Promise<void> {
  const opts = parseInitOptions(args);
  const steps: InitStep[] = [];
  const knowledgeDir = path.isAbsolute(opts.dir)
    ? opts.dir
    : path.resolve(process.cwd(), opts.dir);
  const store = new KnowledgeStore(knowledgeDir);
  await store.init();
  steps.push({
    label: "Knowledge directory",
    path: knowledgeDir,
    status: "created",
  });
  steps.push({
    label: "Relation index",
    path: path.join(knowledgeDir, "_index.json"),
    status: "exists",
  });

  const existingWorkstream = await store.getWorkstreamEntity();
  if (!existingWorkstream) {
    const created = await store.createEntity({
      name: opts.name,
      entityType: "workstream",
      gist: opts.gist,
      observations: [],
      tags: ["memlane"],
      content:
        "Created by `memlane init`. Use this entity as the discoverable root summary for the workstream.",
    });
    steps.push({
      label: "Workstream entity",
      path: created.filePath,
      status: "created",
    });
  } else {
    steps.push({
      label: "Workstream entity",
      path: existingWorkstream.filePath,
      status: "exists",
      message: `Using existing workstream '${existingWorkstream.name}'.`,
    });
  }

  const stateEntities = await store.listStateEntities();
  if (stateEntities.length <= 1) {
    const result = await store.setState({
      fields: {
        phase: "initialized",
        nextAction: "Run `memlane.bootstrap`, then `memlane.doctor`, then start recording real work.",
        doNotDoYet: "Do not store secrets or treat Memlane as proof of live infrastructure state.",
        keyRepos: process.cwd(),
        liveSourceOfTruth: "This repository/workstream on disk.",
        targetSourceOfTruth: opts.dir,
        rollbackUnit: "Delete or revert the Memlane init files if this setup was accidental.",
        validationSignal: "`memlane.doctor` returns ok:true after agent restart.",
      },
      extraObservations: [
        `[${new Date().toISOString().slice(0, 10)}] Workstream initialized by memlane init.`,
      ],
      tags: ["memlane", "initialized"],
    });
    steps.push({
      label: "Current state",
      path: result.entity.filePath,
      status: result.noOp ? "exists" : stateEntities.length ? "updated" : "created",
    });
  } else {
    steps.push({
      label: "Current state",
      status: "skipped",
      message: `Multiple state entities exist: ${stateEntities.map((e) => e.name).join(", ")}.`,
    });
  }

  if (shouldRunWriter(opts, "claude")) {
    steps.push(await upsertMcpJson(path.resolve(process.cwd(), ".mcp.json"), opts));
  }
  if (shouldRunWriter(opts, "cursor")) {
    steps.push(await upsertMcpJson(path.resolve(process.cwd(), ".cursor", "mcp.json"), opts));
  }
  if (shouldRunWriter(opts, "codex")) {
    steps.push(await upsertCodexConfig(opts));
  }
  if (shouldRunWriter(opts, "opencode")) {
    steps.push(await upsertOpenCodeConfig(opts));
  }
  if (shouldRunWriter(opts, "instructions")) {
    steps.push(...(await updateInstructionFiles(opts)));
  }

  const result = {
    ok: true,
    knowledgeDir,
    workstream: opts.name,
    steps,
    nextSteps: [
      "Restart your agent/MCP client so it loads the memlane server.",
      "Ask the agent to call memlane.bootstrap.",
      "Ask the agent to call memlane.doctor.",
    ],
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Initialised Memlane at ${opts.dir}\n\n`);
  for (const s of steps) {
    const mark =
      s.status === "skipped" ? "·" : s.status === "exists" ? "✓" : "✓";
    const p = s.path ? `  ${path.relative(process.cwd(), s.path) || s.path}` : "";
    const msg = s.message ? ` — ${s.message}` : "";
    process.stdout.write(`  ${mark} ${s.label}${p} (${s.status})${msg}\n`);
  }
  process.stdout.write("\nNext steps:\n");
  for (const s of result.nextSteps) process.stdout.write(`  ${s}\n`);
}

async function main() {
  const root = resolveKnowledgeDir();
  const store = new KnowledgeStore(root);
  await store.init();
  process.stderr.write(`[memlane] root=${root}\n`);

  const server = new McpServer({
    name: "memlane",
    version: "0.1.0",
  });

  // Per-tool telemetry. Wraps every handler via the `register` helper below.
  const telemetry = new Telemetry();

  // Helper: registerTool + automatic instrumentation. Use this instead of
  // server.registerTool directly so every tool's calls/errors/latency are tracked.
  // Schema-aware wrapper around server.registerTool. Generic over the input
  // schema so handler args still infer from `inputSchema`. Adds telemetry
  // (calls/errors/latency) without touching the runtime contract.
  const register = <S extends z.ZodRawShape>(
    name: string,
    def: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>
  ) => {
    (server as any).registerTool(
      name,
      def,
      instrument(telemetry, name, handler)
    );
  };

  register(
    "create_entities",
    {
      title: "Create entities",
      description:
        "Create new entities. Each becomes a markdown file at <KNOWLEDGE_DIR>/<type>s/<slug>.md (or under an explicit `path`). Errors if the name already exists or a slug collision is detected.",
      inputSchema: {
        entities: z.array(z.object(entityShape)).min(1),
      },
    },
    async ({ entities }) => {
      const out: ReturnType<typeof project>[] = [];
      for (const e of entities) {
        const created = await store.createEntity(e);
        out.push(project(created, root));
      }
      return reply(out);
    }
  );

  // Strict vocabulary is on by default. Set STRICT_VOCABULARY=0 to allow
  // non-canonical relationTypes through with warnings instead of rejection.
  const strictVocab = process.env.STRICT_VOCABULARY !== "0";
  process.stderr.write(
    `[memlane] STRICT_VOCABULARY=${strictVocab ? "1 (default)" : "0"} — non-canonical relationTypes ${strictVocab ? "rejected" : "warned"}\n`
  );

  register(
    "create_relations",
    {
      title: "Create relations",
      description:
        "Create directed relations between entities. Stored in _index.json. Duplicates skipped. By default the server runs in strict mode: non-canonical relationTypes are REJECTED with an error (use a verb from the canonical 15-verb vocabulary or extend it via DEFAULT_RELATION_VOCABULARY in source). To loosen — get warnings without rejection — start the server with STRICT_VOCABULARY=0; the response then carries a `warnings` array.",
      inputSchema: {
        relations: z.array(z.object(relationShape)).min(1),
      },
    },
    async ({ relations }) => {
      const { created, warnings } = await store.createRelations(relations, {
        vocabulary: DEFAULT_RELATION_VOCABULARY,
        strict: strictVocab,
      });
      return reply({ created, warnings });
    }
  );

  register(
    "reflect",
    {
      title: "Self-curate memory in one call",
      description:
        "Unified self-edit tool: add/update/forget observations, or link/unlink relations. Single verb the agent reaches for when it has just learned something new (add), realized prior info is wrong (update or forget), or wants to wire entities together (link/unlink). Façade over add_observations / delete_observations / create_relations / delete_relations — same guarantees as those tools (vocab enforcement on link, dedupe on add, etc.). Use for natural mid-session self-curation; the granular tools remain available when you want them.",
      inputSchema: {
        action: z
          .enum(["add", "update", "forget", "link", "unlink"])
          .describe(
            "add: append an observation to an entity. update: atomically replace one observation with another (logs reason). forget: remove an observation. link: create a relation. unlink: remove a relation."
          ),
        // shared
        entityName: z.string().optional(),
        observation: z.string().optional(),
        // update-specific
        oldObservation: z.string().optional(),
        newObservation: z.string().optional(),
        reason: z
          .string()
          .optional()
          .describe(
            "Free-form reason for the change. Recorded as an observation prefixed with [reflect:update] when action='update' or [reflect:forget] when action='forget'."
          ),
        // link/unlink
        from: z.string().optional(),
        to: z.string().optional(),
        relationType: z.string().optional(),
      },
    },
    async (args) => {
      const a = args as Record<string, string | undefined>;
      switch (a.action) {
        case "add": {
          if (!a.entityName || !a.observation) {
            throw new Error("'add' requires entityName and observation");
          }
          const added = await store.addObservations(a.entityName, [
            a.observation,
          ]);
          return reply({
            action: "add",
            entityName: a.entityName,
            added,
            wasDuplicate: added.length === 0,
          });
        }
        case "update": {
          if (!a.entityName || !a.oldObservation || !a.newObservation) {
            throw new Error(
              "'update' requires entityName, oldObservation, newObservation"
            );
          }
          await store.deleteObservations(a.entityName, [a.oldObservation]);
          const trail = a.reason
            ? `[reflect:update] ${a.newObservation} (reason: ${a.reason})`
            : a.newObservation;
          const added = await store.addObservations(a.entityName, [trail]);
          return reply({
            action: "update",
            entityName: a.entityName,
            removed: a.oldObservation,
            added: added[0] ?? null,
          });
        }
        case "forget": {
          if (!a.entityName || !a.observation) {
            throw new Error("'forget' requires entityName and observation");
          }
          await store.deleteObservations(a.entityName, [a.observation]);
          if (a.reason) {
            await store.addObservations(a.entityName, [
              `[reflect:forget] removed: "${a.observation}" (reason: ${a.reason})`,
            ]);
          }
          return reply({
            action: "forget",
            entityName: a.entityName,
            removed: a.observation,
          });
        }
        case "link": {
          if (!a.from || !a.to || !a.relationType) {
            throw new Error("'link' requires from, to, relationType");
          }
          const { created, warnings } = await store.createRelations(
            [{ from: a.from, to: a.to, relationType: a.relationType }],
            { vocabulary: DEFAULT_RELATION_VOCABULARY, strict: strictVocab }
          );
          return reply({
            action: "link",
            created,
            warnings,
          });
        }
        case "unlink": {
          if (!a.from || !a.to || !a.relationType) {
            throw new Error("'unlink' requires from, to, relationType");
          }
          const removed = await store.deleteRelations([
            { from: a.from, to: a.to, relationType: a.relationType },
          ]);
          return reply({
            action: "unlink",
            removed,
          });
        }
        default:
          throw new Error(`unknown action: ${a.action}`);
      }
    }
  );

  register(
    "add_observations",
    {
      title: "Add observations",
      description:
        "Append bullet-point observations to existing entities. Trims whitespace and skips duplicates.",
      inputSchema: {
        observations: z
          .array(
            z.object({
              entityName: z.string().min(1),
              contents: z.array(z.string()).min(1),
            })
          )
          .min(1),
      },
    },
    async ({ observations }) => {
      const result: { entityName: string; added: string[] }[] = [];
      for (const o of observations) {
        const added = await store.addObservations(o.entityName, o.contents);
        result.push({ entityName: o.entityName, added });
      }
      return reply(result);
    }
  );

  register(
    "delete_entities",
    {
      title: "Delete entities",
      description:
        "Delete entities and any relations referencing them. Returns names actually deleted.",
      inputSchema: {
        entityNames: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ entityNames }) => {
      const deleted = await store.deleteEntities(entityNames);
      return reply({ deleted });
    }
  );

  register(
    "delete_observations",
    {
      title: "Delete observations",
      description:
        "Remove specific observation strings from entities (exact match).",
      inputSchema: {
        deletions: z
          .array(
            z.object({
              entityName: z.string().min(1),
              observations: z.array(z.string()).min(1),
            })
          )
          .min(1),
      },
    },
    async ({ deletions }) => {
      for (const d of deletions) {
        await store.deleteObservations(d.entityName, d.observations);
      }
      return reply({ ok: true });
    }
  );

  register(
    "delete_relations",
    {
      title: "Delete relations",
      description: "Remove specific relations from _index.json.",
      inputSchema: {
        relations: z.array(z.object(relationShape)).min(1),
      },
    },
    async ({ relations }) => {
      const removed = await store.deleteRelations(relations);
      return reply({ removed });
    }
  );

  register(
    "read_graph",
    {
      title: "Read full graph",
      description:
        "Return all entities and relations. Use this to bootstrap context at the start of a session.",
      inputSchema: {},
    },
    async () => {
      const { entities, relations } = await store.readGraph();
      return reply({
        entities: entities.map((e) => project(e, root)),
        relations,
      });
    }
  );

  register(
    "search_nodes",
    {
      title: "Search nodes",
      description:
        "Substring search across name/type/tags/gist/observations/content. Supports tag/type/since filters and returns compact match snippets so agents can decide what to open next without embeddings.",
      inputSchema: {
        query: z.string().default(""),
        tags: z.array(z.string()).optional(),
        entityTypes: z.array(z.string()).optional(),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp or YYYY-MM-DD. Matches entities updated since then, or entities with date-prefixed observations since then."),
        limit: z.number().int().positive().optional(),
        maxMatchesPerEntity: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum snippet matches returned per entity. Default 5."),
      },
    },
    async ({ query, tags, entityTypes, since, limit, maxMatchesPerEntity }) => {
      const matches = await store.searchNodesDetailed({
        query: query ?? "",
        tags,
        entityTypes,
        since,
        limit,
        maxMatchesPerEntity,
      });
      return reply(
        matches.map((m) => ({
          ...project(m.entity, root),
          matchedText: m.matchedText,
          whyMatched: m.whyMatched,
          matches: m.matches,
        }))
      );
    }
  );

  register(
    "recent_activity",
    {
      title: "Recent activity",
      description:
        "Read-only timeline of recently touched entities, combining entity updated timestamps with date-prefixed observations like [2026-05-06]. Use after a pause to ask what changed lately without needing embeddings.",
      inputSchema: {
        entityTypes: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp or YYYY-MM-DD. Filters by latest entity update or date-prefixed observation."),
        limit: z.number().int().positive().optional(),
        includeObservations: z
          .boolean()
          .optional()
          .describe("Include recent date-prefixed observations. Default true."),
        maxObservationsPerEntity: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum date-prefixed observations returned per entity. Default 5."),
      },
    },
    async ({
      entityTypes,
      tags,
      since,
      limit,
      includeObservations,
      maxObservationsPerEntity,
    }) => {
      const activity = await store.recentActivity({
        entityTypes,
        tags,
        since,
        limit,
        includeObservations,
        maxObservationsPerEntity,
      });
      return reply({
        since: since ?? null,
        items: activity.map((item) => ({
          entity: project(item.entity, root),
          activityAt: item.activityAt,
          reasons: item.reasons,
          recentObservations: item.recentObservations,
        })),
      });
    }
  );

  register(
    "open_nodes",
    {
      title: "Open nodes by name",
      description: "Return entities by exact-name lookup.",
      inputSchema: {
        names: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ names }) => {
      const entities = await store.openNodes(names);
      return reply(entities.map((e) => project(e, root)));
    }
  );

  register(
    "update_content",
    {
      title: "Update content section",
      description:
        "Replace the free-form `## Content` section of an entity. Use for prose like migration plans, handoff docs, troubleshooting guides. Pass an empty string to clear.",
      inputSchema: {
        name: z.string().min(1),
        content: z.string(),
      },
    },
    async ({ name, content }) => {
      await store.setContent(name, content);
      return reply({ ok: true });
    }
  );

  const workstreamsRoot = resolveWorkstreamsRoot(root);
  process.stderr.write(`[memlane] workstreams_root=${workstreamsRoot}\n`);

  // Vector index lives at <KNOWLEDGE_DIR>/_vectors.json. Workstream-local;
  // gitignored by convention. Lazy: built / rebuilt only on demand.
  const vectorIndex = new VectorIndex(path.join(root, "_vectors.json"));

  const stateFieldsShape = Object.fromEntries(
    STATE_FIELDS.map((f) => [f.key, z.string().optional().describe(f.label)])
  ) as Record<string, z.ZodOptional<z.ZodString>>;

  register(
    "get_state",
    {
      title: "Get current workstream state",
      description:
        "Cheap read of the canonical state entity for this workstream. Returns the entity (with structured fields parsed out) or null if no state entity exists yet. Use this for fast 'up next?' / 'where am I?' queries instead of read_graph.",
      inputSchema: {},
    },
    async () => {
      const { state, conflicts } = await store.getState();
      if (!state) return reply({ state: null, fields: null, conflicts });
      const fields: Record<string, string> = {};
      for (const f of STATE_FIELDS) {
        const obs = state.observations.find((o) => o.startsWith(`${f.label}: `));
        if (obs) fields[f.key] = obs.slice(f.label.length + 2);
      }
      return reply({
        state: project(state, root),
        fields,
        conflicts,
        ...(conflicts.length
          ? {
              conflictWarning: `Multiple state entities exist (${conflicts
                .map((n) => `'${n}'`)
                .join(", ")}). Returning '${state.name}'. Consolidate by deleting duplicates and renaming the survivor to '${DEFAULT_STATE_NAME}'.`,
            }
          : {}),
      });
    }
  );

  register(
    "set_state",
    {
      title: "Set / update workstream state",
      description:
        `Upsert the canonical state entity for this workstream. Without \`name\`: finds the existing state entity (whatever its name) and updates it; creates one named "${DEFAULT_STATE_NAME}" if none exist; **errors if multiple state entities exist** (pass \`name\` to disambiguate, or delete duplicates first). With \`name\`: writes to that entity (creating if missing). Each field is stored as a labeled observation ("Phase: shadow deploy"). Fields you omit keep their prior values; fields you pass replace. Other (non-labeled) observations are preserved. Pass \`extraObservations\` to append free-form bullets. Use on real state changes — phase advance, blocker resolved — not on lookups.`,
      inputSchema: {
        ...stateFieldsShape,
        name: z.string().optional().describe(`State entity name (default: "${DEFAULT_STATE_NAME}")`),
        extraObservations: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const { name, extraObservations, tags, ...rest } = args;
      const fields = rest as Record<string, string | undefined>;
      const result = await store.setState({
        name,
        fields,
        extraObservations,
        tags,
      });
      return reply({
        ...project(result.entity, root),
        diff: {
          changedFields: result.changedFields,
          unchangedFields: result.unchangedFields,
          appendedObservations: result.appendedObservations,
          skippedDuplicates: result.skippedDuplicates,
          noOp: result.noOp,
        },
        legacyObservations: result.legacyObservations,
        ...(result.noOp
          ? {
              noOpHint:
                "Nothing changed — every requested field already matched and every extraObservation was already present. The entity was not rewritten and the timestamp did not advance.",
            }
          : {}),
        ...(result.legacyObservations.length
          ? {
              legacyHint:
                "Found prior observations that mention state-vocabulary (phase, next action, rollback, validation). They were preserved alongside the new labeled fields. Review and clean up via delete_observations if they're now redundant.",
            }
          : {}),
      });
    }
  );

  register(
    "neighbors",
    {
      title: "Traverse the relation graph from a root entity",
      description:
        "BFS over relations from `name`, returning the visited entities and relations annotated with hopFromRoot. Use to answer 'what blocks X?', 'what does Y validate-with?', 'show me everything currently-targeting Z'. Defaults: direction='both', depth=1. Set `relationTypes` to filter by verb (e.g. ['blocked-by','blocks']). Cycles are handled. Dangling references (relation targets without an entity file) are reported separately. Max depth capped at 5; requesting more sets `truncated: true`.",
      inputSchema: {
        name: z.string().min(1).describe("Root entity name."),
        direction: z
          .enum(["out", "in", "both"])
          .optional()
          .describe(
            "out: only relations where root is `from`. in: only relations where root is `to`. both: undirected. Default: both."
          ),
        relationTypes: z
          .array(z.string())
          .optional()
          .describe("Filter by relationType. Default: all."),
        depth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Max hops from root. Default 1, capped at 5."),
      },
    },
    async ({ name, direction, relationTypes, depth }) => {
      const result = await store.traverse({
        name,
        direction,
        relationTypes,
        depth,
      });
      return reply({
        root: result.root ? project(result.root, root) : null,
        entities: result.entities.map((e) => ({
          ...project(e, root),
          hopFromRoot: e.hopFromRoot,
        })),
        relations: result.relations,
        maxDepthReached: result.maxDepthReached,
        truncated: result.truncated,
        danglingReferences: result.danglingReferences,
      });
    }
  );

  register(
    "consolidate_state",
    {
      title: "Consolidate duplicate state entities",
      description:
        `Repair friction caused by multiple state entities in one workstream. Merges all entityType="state" entities into one survivor. The survivor's labeled fields (Phase, Next Action, etc.) win on conflict; free-form observations from every state entity are merged and deduped. Relations referencing the deleted entities are repointed at the survivor; self-relations that result are dropped. Optionally renames the survivor (commonly to "${DEFAULT_STATE_NAME}"). Destructive — only use to clean up unintended duplicates. Pass keepName to choose the survivor explicitly; otherwise prefers "${DEFAULT_STATE_NAME}" then most-recently-updated.`,
      inputSchema: {
        keepName: z
          .string()
          .optional()
          .describe(
            "Name of the state entity to keep. If omitted: prefers DEFAULT_STATE_NAME, then most-recently-updated."
          ),
        renameTo: z
          .string()
          .optional()
          .describe(
            `Optional new name for the survivor. Often "${DEFAULT_STATE_NAME}" to canonicalize.`
          ),
      },
    },
    async ({ keepName, renameTo }) => {
      const result = await store.consolidateState({ keepName, renameTo });
      return reply(result);
    }
  );

  register(
    "bootstrap",
    {
      title: "Bootstrap context for a fresh session",
      description:
        "One-call cold-start answer for 'what's going on here?'. Returns the workstream entity, the canonical state entity (with structured fields), the 1-hop neighborhood of the state entity (entities related to it via any relation — `blocked-by`, `tracking`, `summarizes`, etc.), and the most recent session-state observations. This single call gives a memoryless agent the full picture: not just *what* the state is, but *what's connected to it*. Pass `includeStateNeighbors: false` to skip the traversal if you only need the state itself.",
      inputSchema: {
        sessionObservationLimit: z.number().int().positive().optional(),
        includeStateNeighbors: z
          .boolean()
          .optional()
          .describe(
            "Include the 1-hop neighborhood of the state entity. Default true."
          ),
      },
    },
    async ({ sessionObservationLimit, includeStateNeighbors }) => {
      const b = await store.bootstrap({ sessionObservationLimit });
      const fields: Record<string, string> = {};
      if (b.state) {
        for (const f of STATE_FIELDS) {
          const obs = b.state.observations.find((o) => o.startsWith(`${f.label}: `));
          if (obs) fields[f.key] = obs.slice(f.label.length + 2);
        }
      }
      const includeNeighbors = includeStateNeighbors !== false;
      let stateNeighbors: unknown = null;
      if (includeNeighbors && b.state) {
        const t = await store.traverse({
          name: b.state.name,
          direction: "both",
          depth: 1,
        });
        stateNeighbors = {
          entities: t.entities.map((e) => ({
            ...project(e, root),
            hopFromRoot: e.hopFromRoot,
          })),
          relations: t.relations,
          danglingReferences: t.danglingReferences,
        };
      }
      return reply({
        workstream: b.workstream ? project(b.workstream, root) : null,
        state: b.state ? project(b.state, root) : null,
        stateFields: b.state ? fields : null,
        stateConflicts: b.stateConflicts,
        ...(b.stateConflicts.length
          ? {
              conflictWarning: `Multiple state entities exist (${b.stateConflicts
                .map((n) => `'${n}'`)
                .join(", ")}). Bootstrap returned '${b.state?.name}'. set_state without an explicit \`name\` will fail until duplicates are removed.`,
            }
          : {}),
        stateNeighbors,
        sessionState: b.sessionState ? project(b.sessionState, root) : null,
        recentSessionObservations: b.recentSessionObservations,
      });
    }
  );

  register(
    "check_vocabulary",
    {
      title: "Audit relation vocabulary",
      description:
        "Surface drift in relation usage. Returns counts of every distinct `relationType` in the current graph, split into `inUse` (declared) and `drift` (not declared). Use to find sloppy verbs the agent invented (e.g. 'creates', 'runs-on') so they can be cleaned up via delete_relations + create_relations. Pass an explicit `declared` list to override the default 15-verb canonical vocabulary.",
      inputSchema: {
        declared: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Optional declared vocabulary. Defaults to the canonical list pinned in AGENTS.md / CLAUDE.md."
          ),
      },
    },
    async ({ declared }) => {
      const vocab =
        declared && declared.length > 0
          ? declared
          : [...DEFAULT_RELATION_VOCABULARY];
      const report = await store.checkVocabulary(vocab);
      return reply(report);
    }
  );

  register(
    "list_workstreams",
    {
      title: "List sibling workstreams",
      description:
        "Discovery tool. Returns an index of sibling workstreams under WORKSTREAMS_ROOT (default: parent of parent of KNOWLEDGE_DIR). Each entry has the workstream's name, knowledgeDir path, gist, tags, and (if `withCounts: true`) entity count. Counts are off by default because computing them walks each sibling's full tree. Used to navigate cross-workstream context on demand without auto-loading sibling data. A workstream is registered when it has an entity of type 'workstream' at the root of its knowledge dir.",
      inputSchema: {
        withCounts: z
          .boolean()
          .optional()
          .describe(
            "If true, compute entityCount per workstream by walking each sibling's full tree. Slower. Default false."
          ),
      },
    },
    async ({ withCounts }) => {
      const summaries = await listWorkstreams(workstreamsRoot, {
        withCounts: !!withCounts,
      });
      return reply({
        workstreamsRoot,
        currentKnowledgeDir: root,
        workstreams: summaries,
      });
    }
  );

  register(
    "import_markdown",
    {
      title: "Import legacy markdown",
      description:
        "Convert legacy unstructured markdown files into entity format. Reads each file, derives a name (from filename or H1), and places the body into `## Content`. Skips files whose name already exists or whose slug would collide.",
      inputSchema: {
        srcPaths: z.array(z.string().min(1)).min(1),
        entityType: z.string().min(1),
        tags: z.array(z.string()).optional(),
        targetPath: z
          .string()
          .optional()
          .describe(
            "Safe relative subdirectory under KNOWLEDGE_DIR. Absolute paths and '..' segments are rejected. Defaults to type-based routing."
          ),
        nameStrategy: z.enum(["filename", "h1"]).default("filename"),
      },
    },
    async ({ srcPaths, entityType, tags, targetPath, nameStrategy }) => {
      const result = await store.importMarkdown({
        srcPaths,
        entityType,
        tags,
        targetPath,
        nameStrategy,
      });
      return reply(result);
    }
  );

  register(
    "rebuild_index",
    {
      title: "Rebuild the semantic search index",
      description:
        "Walks every entity in this workstream, embeds each entity's summary (name + gist + first 500 chars of content) and each observation individually via the configured embedder (env: MEMLANE_EMBED_BASE_URL or MEMLANE_LLM_BASE_URL + matching API key). Writes <KNOWLEDGE_DIR>/_vectors.json. Idempotent — safe to re-run; old index is replaced. Run after a batch of writes when you want semantic_search to reflect current state. Embedding model defaults to `text-embedding-3-small` (1536 dim) — set MEMLANE_EMBED_MODEL to override.",
      inputSchema: {
        batchSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Texts to embed per HTTP request. Default 64. Reduce if your endpoint has tight token limits."
          ),
      },
    },
    async ({ batchSize }) => {
      const cfg = loadEmbedConfig();
      if ("error" in cfg) throw new Error(cfg.error);
      const batch = batchSize ?? 64;

      const entities = await store.listAllEntities();
      // Build the input list: one entry per entity summary, plus one per observation.
      const inputs: Array<{
        record: Omit<VectorRecord, "vec">;
        text: string;
      }> = [];
      for (const e of entities) {
        const summary = [
          e.name,
          e.gist ?? "",
          (e.content ?? "").slice(0, 500),
        ]
          .filter(Boolean)
          .join("\n\n")
          .trim() || e.name;
        inputs.push({
          record: {
            id: `entity:${e.name}`,
            source: "entity",
            entityName: e.name,
            entityType: e.entityType,
            text: summary,
            updated: e.updated,
            filePath: path.relative(root, e.filePath),
          },
          text: summary,
        });
        for (let i = 0; i < e.observations.length; i++) {
          const obs = e.observations[i];
          if (!obs.trim()) continue;
          inputs.push({
            record: {
              id: `obs:${e.name}:${i}`,
              source: "observation",
              entityName: e.name,
              entityType: e.entityType,
              text: obs,
              updated: e.updated,
              filePath: path.relative(root, e.filePath),
            },
            text: obs,
          });
        }
      }

      const t0 = Date.now();
      const records: VectorRecord[] = [];
      let dim = 0;
      for (let i = 0; i < inputs.length; i += batch) {
        const slice = inputs.slice(i, i + batch);
        const vecs = await embed(cfg, slice.map((s) => s.text));
        for (let j = 0; j < slice.length; j++) {
          if (dim === 0) dim = vecs[j].length;
          records.push({ ...slice[j].record, vec: vecs[j] });
        }
      }

      await vectorIndex.write({
        version: 1,
        model: cfg.model,
        dimension: dim,
        builtAt: new Date().toISOString(),
        records,
      });

      const elapsedMs = Date.now() - t0;
      const entityRecords = records.filter((r) => r.source === "entity").length;
      const observationRecords = records.length - entityRecords;
      return reply({
        entitiesIndexed: entityRecords,
        observationsIndexed: observationRecords,
        totalVectors: records.length,
        dimension: dim,
        model: cfg.model,
        elapsedMs,
        indexPath: path.relative(root, path.join(root, "_vectors.json")),
      });
    }
  );

  register(
    "semantic_search",
    {
      title: "Find what something is about, even without exact keywords",
      description:
        "Embeds the query and returns top-K nearest entities/observations by cosine similarity. Use to recall things you don't remember the exact words for: \"that issue with IAM token rotation last quarter\" finds the right entity even if the stored text says \"workload identity webhook stalled.\" Falls back to substring search via search_nodes if you need keyword precision. Requires the index to be built — run rebuild_index first if index_status reports exists:false. Returns null if MEMLANE_EMBED_BASE_URL+API_KEY aren't configured.",
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().positive().optional(),
        entityTypes: z.array(z.string()).optional(),
        source: z
          .enum(["entity", "observation", "both"])
          .optional()
          .describe(
            "Filter by record kind. 'entity' = entity-level summaries, 'observation' = single bullets. Default: both."
          ),
      },
    },
    async ({ query, k, entityTypes, source }) => {
      const cfg = loadEmbedConfig();
      if ("error" in cfg) throw new Error(cfg.error);
      const status = await vectorIndex.status();
      if (!status.exists) {
        throw new Error(
          "Vector index does not exist yet. Run rebuild_index first."
        );
      }
      if (status.model !== cfg.model) {
        throw new Error(
          `Index was built with model '${status.model}' but current MEMLANE_EMBED_MODEL is '${cfg.model}'. Vectors are not comparable across models — run rebuild_index to re-embed with the current model.`
        );
      }
      const t0 = Date.now();
      const [queryVec] = await embed(cfg, [query]);
      const sourceFilter =
        source && source !== "both"
          ? (source as "entity" | "observation")
          : undefined;
      const hits = await vectorIndex.search(queryVec, k ?? 10, {
        entityTypes,
        sourceFilter,
      });
      const elapsedMs = Date.now() - t0;
      return reply({
        query,
        elapsedMs,
        model: cfg.model,
        hits: hits.map((h) => ({
          source: h.source,
          entityName: h.entityName,
          entityType: h.entityType,
          text: h.text,
          similarity: Math.round(h.similarity * 1000) / 1000,
          filePath: h.filePath,
          updated: h.updated,
        })),
      });
    }
  );

  register(
    "index_status",
    {
      title: "Vector index diagnostics",
      description:
        "Returns whether the semantic search index has been built, how many vectors it holds, which model produced them, and when it was last built. Read-only.",
      inputSchema: {},
    },
    async () => {
      const status = await vectorIndex.status();
      const cfg = loadEmbedConfig();
      return reply({
        ...status,
        currentEmbedderConfigured: !("error" in cfg),
        currentModel: "error" in cfg ? null : cfg.model,
        modelMismatch:
          status.exists && !("error" in cfg) && status.model !== cfg.model,
      });
    }
  );

  register(
    "consolidate_phase",
    {
      title: "LLM-summarize a phase's observations into a retrospective entity",
      description:
        "Compresses a chunk of an entity's observations into one retrospective entity (entityType='retrospective'). Use when a migration phase completes and the granular weekly bullets have become noise — the retrospective stays queryable via `supersedes` relation and as a `repeats-from` target for the next cycle (e.g. quarterly cluster upgrades). Calls the configured LLM (env: MEMLANE_LLM_BASE_URL, MEMLANE_LLM_API_KEY, MEMLANE_LLM_MODEL). Pass observations explicitly OR pass a `phaseLabel` to filter by a `Phase: …` prefix. Source observations are pruned after the retro is written. Idempotent: errors if the retro entity already exists.",
      inputSchema: {
        sourceEntity: z
          .string()
          .describe(
            "Entity whose observations are being archived (typically the state entity)."
          ),
        retroEntityName: z
          .string()
          .describe(
            "Name for the new retrospective entity. Convention: phase-<slug>-retro or cluster-upgrade-<period>."
          ),
        observations: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit list of observation strings to archive. Mutually exclusive with `phaseLabel`."
          ),
        phaseLabel: z
          .string()
          .optional()
          .describe(
            "If provided, archive every observation whose text contains this substring (e.g. 'shadow deploy'). Mutually exclusive with `observations`."
          ),
        prune: z
          .boolean()
          .optional()
          .describe(
            "Default true. Set false to write the retro without removing source observations (dry-run-ish — useful when you want to verify the summary before committing to deletion)."
          ),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const { sourceEntity, retroEntityName, observations, phaseLabel, prune, tags } = args;
      if (observations && phaseLabel) {
        throw new Error(
          "Pass either `observations` or `phaseLabel`, not both."
        );
      }

      const cfg = loadLLMConfig();
      if ("error" in cfg) {
        throw new Error(cfg.error);
      }

      // Resolve which observations to archive.
      const source = await store.openNodes([sourceEntity]);
      if (source.length === 0) {
        throw new Error(`Source entity not found: '${sourceEntity}'`);
      }
      let toArchive: string[] = [];
      if (observations && observations.length > 0) {
        toArchive = observations;
      } else if (phaseLabel) {
        toArchive = source[0].observations.filter((o) =>
          o.toLowerCase().includes(phaseLabel.toLowerCase())
        );
      } else {
        throw new Error(
          "Must pass either `observations` or `phaseLabel` to specify what to archive."
        );
      }

      if (toArchive.length === 0) {
        throw new Error(
          phaseLabel
            ? `No observations on '${sourceEntity}' matched phaseLabel '${phaseLabel}'.`
            : "Empty observations list — nothing to archive."
        );
      }

      // Summarize via LLM.
      const t0 = Date.now();
      const summary = await chat(cfg, [
        {
          role: "system",
          content:
            "You are summarizing a list of observations from an AI agent's working memory of a multi-week infrastructure project. Produce one tight retrospective paragraph (≤180 words) that preserves: concrete decisions made, blockers hit, validations passed, and any names of systems/repos/clusters mentioned. Discard verbose detail and step-by-step narration. Output prose only — no bullet list, no preamble.",
        },
        {
          role: "user",
          content:
            `Source entity: ${sourceEntity}\n\nObservations to summarize:\n\n` +
            toArchive.map((o, i) => `${i + 1}. ${o}`).join("\n"),
        },
      ]);
      const llmCallLatencyMs = Date.now() - t0;

      // Apply.
      const result = await store.archivePhase({
        sourceEntityName: sourceEntity,
        retroEntityName,
        retroSummary: summary,
        observationsToPrune: prune === false ? [] : toArchive,
        tags,
      });

      return reply({
        retroEntity: project(result.retroEntity, root),
        retroSummary: summary,
        observationsArchived: toArchive.length,
        observationsPruned: result.pruned,
        relationCreated: result.relationCreated,
        llmCallLatencyMs,
        llmModel: cfg.model,
      });
    }
  );

  register(
    "doctor",
    {
      title: "Deep consistency check for the Memlane graph",
      description:
        "Read-only graph/index audit. Checks markdown entity frontmatter, duplicate names/slug collisions, canonical state/workstream presence, _index.json shape, dangling/non-canonical/duplicate relations, and optional vector-index consistency. Use before trusting memory for a high-risk handoff or migration. Unlike health, this can be slower and inspects the graph contents.",
      inputSchema: {
        includeIndex: z
          .boolean()
          .optional()
          .describe(
            "Whether to inspect <KNOWLEDGE_DIR>/_vectors.json. Default true. Set false to skip embedding/index diagnostics."
          ),
      },
    },
    async ({ includeIndex }) => {
      const errors: DoctorFinding[] = [];
      const warnings: DoctorFinding[] = [];
      const suggestions: string[] = [];

      const addError = (finding: DoctorFinding) => errors.push(finding);
      const addWarning = (finding: DoctorFinding) => warnings.push(finding);
      const suggest = (s: string) => {
        if (!suggestions.includes(s)) suggestions.push(s);
      };

      const knowledgeDir = {
        path: root,
        exists: true,
        writable: true,
      };
      try {
        await fs.access(root, fs.constants.F_OK);
      } catch {
        knowledgeDir.exists = false;
        knowledgeDir.writable = false;
        addError({
          code: "knowledge_dir_missing",
          message: `KNOWLEDGE_DIR does not exist: ${root}`,
        });
        suggest("Create the knowledge directory or restart Memlane with the intended KNOWLEDGE_DIR.");
      }
      if (knowledgeDir.exists) {
        try {
          await fs.access(root, fs.constants.W_OK);
        } catch {
          knowledgeDir.writable = false;
          addError({
            code: "knowledge_dir_not_writable",
            message: `KNOWLEDGE_DIR is not writable: ${root}`,
          });
          suggest("Fix filesystem permissions before relying on Memlane writes.");
        }
      }

      const markdownFiles = await listMarkdownFiles(root);
      const invalidMarkdown: Array<{ filePath: string; reason: string }> = [];
      const entities: StoredEntity[] = [];
      for (const file of markdownFiles) {
        try {
          const entity = await store.readEntityFromFile(file);
          if (!entity) {
            invalidMarkdown.push({
              filePath: path.relative(root, file),
              reason: "Missing required frontmatter fields `name` and/or `type`.",
            });
          } else {
            entities.push(entity);
          }
        } catch (err) {
          invalidMarkdown.push({
            filePath: path.relative(root, file),
            reason: (err as Error).message,
          });
        }
      }
      if (invalidMarkdown.length) {
        addError({
          code: "invalid_markdown_entities",
          message: `${invalidMarkdown.length} markdown file(s) could not be parsed as Memlane entities.`,
          details: invalidMarkdown,
        });
        suggest("Add valid frontmatter (`name`, `type`) or move non-entity markdown outside KNOWLEDGE_DIR.");
      }

      const byName = new Map<string, StoredEntity[]>();
      for (const e of entities) {
        const list = byName.get(e.name) ?? [];
        list.push(e);
        byName.set(e.name, list);
      }
      const duplicateNames = [...byName.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([name, list]) => ({
          name,
          filePaths: list.map((e) => path.relative(root, e.filePath)),
        }));
      if (duplicateNames.length) {
        addError({
          code: "duplicate_entity_names",
          message: `${duplicateNames.length} duplicate entity name(s) found.`,
          details: duplicateNames,
        });
        suggest("Rename or delete duplicate entities so each name is canonical.");
      }

      const slugGroups = new Map<string, StoredEntity[]>();
      for (const e of entities) {
        const key = `${e.entityType.toLowerCase()}\u0000${store.slugify(e.name)}`;
        const list = slugGroups.get(key) ?? [];
        list.push(e);
        slugGroups.set(key, list);
      }
      const slugCollisions = [...slugGroups.values()]
        .filter((list) => list.length > 1)
        .map((list) => ({
          entityType: list[0].entityType,
          slug: store.slugify(list[0].name),
          entities: list.map((e) => ({
            name: e.name,
            filePath: path.relative(root, e.filePath),
          })),
        }));
      if (slugCollisions.length) {
        addWarning({
          code: "potential_slug_collisions",
          message: `${slugCollisions.length} same-type slug collision group(s) found.`,
          details: slugCollisions,
        });
        suggest("Prefer distinct names that produce distinct slugs within the same entity type.");
      }

      const workstreams = entities.filter((e) => e.entityType === "workstream");
      if (workstreams.length !== 1) {
        addError({
          code: "workstream_entity_count",
          message:
            workstreams.length === 0
              ? "No workstream entity found."
              : `Expected 1 workstream entity, found ${workstreams.length}.`,
          details: workstreams.map((e) => ({
            name: e.name,
            filePath: path.relative(root, e.filePath),
          })),
        });
        suggest("Create exactly one root workstream entity so list_workstreams can discover this workstream.");
      }

      const stateEntities = entities.filter((e) => e.entityType === "state");
      let missingStateFields: string[] = [];
      if (stateEntities.length !== 1) {
        addError({
          code: "state_entity_count",
          message:
            stateEntities.length === 0
              ? "No state entity found."
              : `Expected 1 state entity, found ${stateEntities.length}.`,
          details: stateEntities.map((e) => ({
            name: e.name,
            filePath: path.relative(root, e.filePath),
          })),
        });
        if (stateEntities.length > 1) {
          suggest("Use consolidate_state to merge duplicate state entities.");
        } else {
          suggest("Use set_state to create the canonical current-state entity.");
        }
      } else {
        const state = stateEntities[0];
        const requiredStateKeys = [
          "phase",
          "nextAction",
          "rollbackUnit",
          "validationSignal",
        ];
        missingStateFields = requiredStateKeys.filter((key) => {
          const field = STATE_FIELDS.find((f) => f.key === key);
          return !field || !state.observations.some((o) => o.startsWith(`${field.label}: `));
        });
        if (missingStateFields.length) {
          addWarning({
            code: "missing_state_fields",
            message: `State entity is missing ${missingStateFields.length} important field(s).`,
            details: {
              state: state.name,
              missing: missingStateFields,
            },
          });
          suggest("Use set_state to fill phase, nextAction, rollbackUnit, and validationSignal before handoff.");
        }
      }

      const relationDiagnostics: {
        indexPath: string;
        parseable: boolean;
        total: number;
        malformed: unknown[];
        dangling: Relation[];
        nonCanonical: Relation[];
        duplicates: Relation[];
      } = {
        indexPath: path.relative(root, path.join(root, "_index.json")),
        parseable: true,
        total: 0,
        malformed: [],
        dangling: [],
        nonCanonical: [],
        duplicates: [],
      };

      let relations: Relation[] = [];
      try {
        const raw = await fs.readFile(path.join(root, "_index.json"), "utf8");
        const parsed = JSON.parse(raw) as { relations?: unknown };
        if (!Array.isArray(parsed.relations)) {
          relationDiagnostics.parseable = false;
          addError({
            code: "index_missing_relations",
            message: "_index.json is missing the `relations` array.",
          });
          suggest("Rewrite _index.json with shape `{ \"version\": 1, \"relations\": [] }` or restore it from git.");
        } else {
          const seen = new Set<string>();
          const entityNames = new Set(entities.map((e) => e.name));
          const allowed = new Set(DEFAULT_RELATION_VOCABULARY);
          for (const rawRel of parsed.relations) {
            const r = rawRel as Partial<Relation>;
            if (
              typeof r.from !== "string" ||
              typeof r.to !== "string" ||
              typeof r.relationType !== "string"
            ) {
              relationDiagnostics.malformed.push(rawRel);
              continue;
            }
            const rel: Relation = {
              from: r.from,
              to: r.to,
              relationType: r.relationType,
            };
            relations.push(rel);
            const key = `${rel.from}\u0000${rel.to}\u0000${rel.relationType}`;
            if (seen.has(key)) relationDiagnostics.duplicates.push(rel);
            else seen.add(key);
            if (!entityNames.has(rel.from) || !entityNames.has(rel.to)) {
              relationDiagnostics.dangling.push(rel);
            }
            if (!allowed.has(rel.relationType)) {
              relationDiagnostics.nonCanonical.push(rel);
            }
          }
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        relationDiagnostics.parseable = false;
        addError({
          code: "index_unreadable",
          message:
            e.code === "ENOENT"
              ? "_index.json is missing."
              : `_index.json unreadable or invalid JSON: ${e.message}`,
        });
        suggest("Restore or recreate _index.json before relying on relation graph traversal.");
      }

      relationDiagnostics.total = relations.length;
      if (relationDiagnostics.malformed.length) {
        addError({
          code: "malformed_relations",
          message: `${relationDiagnostics.malformed.length} relation(s) are malformed.`,
          details: relationDiagnostics.malformed.slice(0, 10),
        });
        suggest("Edit _index.json or use delete_relations/create_relations to replace malformed relations.");
      }
      if (relationDiagnostics.dangling.length) {
        addError({
          code: "dangling_relations",
          message: `${relationDiagnostics.dangling.length} relation(s) reference missing entities.`,
          details: relationDiagnostics.dangling.slice(0, 10),
        });
        suggest("Delete dangling relations or recreate the missing endpoint entities.");
      }
      if (relationDiagnostics.nonCanonical.length) {
        addError({
          code: "non_canonical_relations",
          message: `${relationDiagnostics.nonCanonical.length} relation(s) use non-canonical relation types.`,
          details: relationDiagnostics.nonCanonical.slice(0, 10),
        });
        suggest("Run check_vocabulary and replace drift verbs with canonical relation types.");
      }
      if (relationDiagnostics.duplicates.length) {
        addWarning({
          code: "duplicate_relations",
          message: `${relationDiagnostics.duplicates.length} duplicate relation(s) found.`,
          details: relationDiagnostics.duplicates.slice(0, 10),
        });
        suggest("Rewrite duplicate relations by deleting and recreating the unique relation set.");
      }

      const shouldCheckIndex = includeIndex !== false;
      const vectorDiagnostics: Record<string, unknown> = {
        checked: shouldCheckIndex,
      };
      if (shouldCheckIndex) {
        const status = await vectorIndex.status();
        const cfg = loadEmbedConfig();
        const expectedVectors =
          entities.length +
          entities.reduce(
            (sum, e) => sum + e.observations.filter((o) => o.trim()).length,
            0
          );
        Object.assign(vectorDiagnostics, {
          ...status,
          filePath: path.relative(root, status.filePath),
          expectedVectors,
          currentEmbedderConfigured: !("error" in cfg),
          currentModel: "error" in cfg ? null : cfg.model,
          modelMismatch:
            status.exists && !("error" in cfg) && status.model !== cfg.model,
          countMatches: !status.exists ? null : status.totalVectors === expectedVectors,
        });
        if (!status.exists) {
          addWarning({
            code: "vector_index_missing",
            message: "Vector index does not exist; semantic_search will fail until rebuild_index runs.",
          });
          suggest("Run rebuild_index after configuring MEMLANE_EMBED_* if semantic_search matters.");
        } else {
          if ("error" in cfg) {
            addWarning({
              code: "embedder_not_configured",
              message: "Vector index exists, but current MEMLANE_EMBED_* / MEMLANE_LLM_* env is not configured.",
            });
          } else if (status.model !== cfg.model) {
            addError({
              code: "vector_model_mismatch",
              message: `Vector index was built with '${status.model}' but current embedder model is '${cfg.model}'.`,
            });
            suggest("Run rebuild_index with the current embedder model before semantic_search.");
          }
          if (status.totalVectors !== expectedVectors) {
            addWarning({
              code: "vector_count_mismatch",
              message: `Vector index has ${status.totalVectors} vectors but current entities/observations imply ${expectedVectors}.`,
            });
            suggest("Run rebuild_index to refresh semantic_search after recent writes.");
          }
        }
      }

      return reply({
        ok: errors.length === 0,
        summary: {
          errors: errors.length,
          warnings: warnings.length,
          entities: entities.length,
          markdownFiles: markdownFiles.length,
          relations: relationDiagnostics.total,
        },
        errors,
        warnings,
        suggestions,
        checks: {
          knowledgeDir,
          markdown: {
            ok: invalidMarkdown.length === 0,
            filesScanned: markdownFiles.length,
            invalidFiles: invalidMarkdown,
          },
          workstream: {
            ok: workstreams.length === 1,
            count: workstreams.length,
            names: workstreams.map((e) => e.name),
          },
          state: {
            ok: stateEntities.length === 1 && missingStateFields.length === 0,
            count: stateEntities.length,
            names: stateEntities.map((e) => e.name),
            missingFields: missingStateFields,
          },
          relations: {
            ok:
              relationDiagnostics.parseable &&
              relationDiagnostics.malformed.length === 0 &&
              relationDiagnostics.dangling.length === 0 &&
              relationDiagnostics.nonCanonical.length === 0,
            ...relationDiagnostics,
          },
          vectorIndex: vectorDiagnostics,
        },
      });
    }
  );

  register(
    "health",
    {
      title: "Memlane health + telemetry",
      description:
        "Operational visibility. Returns whether the knowledge dir is writable, the index file is parseable, plus per-tool counters (calls, errors, latency totals/max, last error message). Use to detect degraded mode (`ok: false`) before trusting recent writes; use the per-tool stats to spot which operations are slow or failing. Read-only — never mutates state.",
      inputSchema: {},
    },
    async () => {
      const checks: { ok: boolean; messages: string[] } = {
        ok: true,
        messages: [],
      };

      // Check 1: KNOWLEDGE_DIR is writable.
      try {
        await fs.access(root, fs.constants.W_OK);
      } catch {
        checks.ok = false;
        checks.messages.push(
          `KNOWLEDGE_DIR not writable: ${root}`
        );
      }

      // Check 2: _index.json (if it exists) parses as valid JSON with relations array.
      const indexPath = path.join(root, "_index.json");
      try {
        const raw = await fs.readFile(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.relations)) {
          checks.ok = false;
          checks.messages.push(
            "_index.json is missing the `relations` array — graph traversal will return empty"
          );
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") {
          checks.ok = false;
          checks.messages.push(
            `_index.json unreadable or invalid JSON: ${e.message}`
          );
        }
      }

      const snap = telemetry.snapshot();
      return reply({
        ok: checks.ok,
        messages: checks.messages,
        knowledgeDir: root,
        workstreamsRoot,
        strictVocabulary: strictVocab,
        telemetry: snap,
      });
    }
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write("[memlane] connected via stdio\n");
}

async function runCli() {
  const [cmd, subcmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    await main();
    return;
  }
  if (cmd === "mcp" && (!subcmd || subcmd === "serve")) {
    await main();
    return;
  }
  if (cmd === "init") {
    await runInit([subcmd, ...rest].filter(Boolean));
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printCliHelp();
    return;
  }
  throw new Error(`Unknown command: ${cmd}. Run 'memlane --help'.`);
}

runCli().catch((e) => {
  process.stderr.write(
    `[memlane] FATAL: ${(e as Error).stack ?? e}\n`
  );
  process.exit(1);
});
