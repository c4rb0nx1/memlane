// Verify entity writes cannot escape KNOWLEDGE_DIR via path, targetPath, or entityType.
import { KnowledgeStore } from "../dist/store.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "memlane-path-safety-"));
const KDIR = path.join(ROOT, "knowledge");
const store = new KnowledgeStore(KDIR);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function expectReject(label, fn) {
  try {
    await fn();
  } catch (err) {
    const message = String(err?.message ?? err);
    console.log(`${label}: rejected (${message})`);
    assert(
      message.includes("Unsafe") || message.includes("outside KNOWLEDGE_DIR"),
      `${label}: wrong rejection message`
    );
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

try {
  await store.init();

  console.log("=== valid nested relative path ===");
  const valid = await store.createEntity({
    name: "valid-nested",
    entityType: "note",
    path: "plans/2026",
    observations: ["stays inside knowledge dir"],
  });
  console.log(path.relative(KDIR, valid.filePath));
  assert(
    valid.filePath === path.join(KDIR, "plans", "2026", "valid-nested.md"),
    "valid nested path should stay under KNOWLEDGE_DIR"
  );

  console.log("=== reject explicit path traversal ===");
  await expectReject("path ../escaped", () =>
    store.createEntity({
      name: "escape-proof",
      entityType: "note",
      path: "../escaped",
    })
  );
  assert(
    !(await exists(path.join(ROOT, "escaped", "escape-proof.md"))),
    "path traversal wrote outside KNOWLEDGE_DIR"
  );

  console.log("=== reject absolute explicit path ===");
  await expectReject("path absolute", () =>
    store.createEntity({
      name: "absolute-proof",
      entityType: "note",
      path: path.join(ROOT, "absolute"),
    })
  );

  console.log("=== reject traversal through entity type ===");
  await expectReject("entityType ../evil", () =>
    store.createEntity({
      name: "entity-type-proof",
      entityType: "../evil",
    })
  );
  assert(
    !(await exists(path.join(ROOT, "evils", "entity-type-proof.md"))),
    "entityType traversal wrote outside KNOWLEDGE_DIR"
  );

  console.log("=== reject import_markdown targetPath traversal ===");
  const legacy = path.join(ROOT, "legacy.md");
  await fs.writeFile(legacy, "# Legacy\n\nbody\n");
  const imported = await store.importMarkdown({
    srcPaths: [legacy],
    entityType: "note",
    targetPath: "../import-escape",
  });
  console.log(JSON.stringify(imported, null, 2));
  assert(imported.imported.length === 0, "import should not succeed");
  assert(
    imported.skipped.some((s) => s.reason.includes("Unsafe")),
    "import should report unsafe targetPath"
  );
  assert(
    !(await exists(path.join(ROOT, "import-escape", "legacy.md"))),
    "import targetPath traversal wrote outside KNOWLEDGE_DIR"
  );

  await fs.rm(ROOT, { recursive: true, force: true });
  console.log("ALL CHECKS PASSED");
} catch (err) {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  throw err;
}
