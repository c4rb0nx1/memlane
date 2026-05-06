import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { EntityInput, Relation, StoredEntity } from "./types.js";

export type SearchMatchField =
  | "name"
  | "entityType"
  | "tag"
  | "gist"
  | "observation"
  | "content";

export interface SearchNodeMatch {
  field: SearchMatchField;
  text: string;
  snippet: string;
  observationIndex?: number;
}

export interface SearchNodeResult {
  entity: StoredEntity;
  matches: SearchNodeMatch[];
  matchedText?: string;
  whyMatched: string[];
}

export interface DatedObservation {
  text: string;
  index: number;
  date: string;
  timestamp: string;
}

export interface RecentActivityItem {
  entity: StoredEntity;
  activityAt: string;
  reasons: string[];
  recentObservations: DatedObservation[];
}

export class KnowledgeStore {
  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const indexPath = this.indexPath();
    try {
      await fs.access(indexPath);
    } catch {
      await fs.writeFile(
        indexPath,
        JSON.stringify({ version: 1, relations: [] }, null, 2) + "\n"
      );
    }
  }

  get root(): string {
    return this.rootDir;
  }

  private indexPath(): string {
    return path.join(this.rootDir, "_index.json");
  }

  slugify(name: string): string {
    const slug = name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      throw new Error(`Cannot slugify name: '${name}' produces an empty slug`);
    }
    return slug;
  }

  // Default subdir = entityType + 's' (unless already ends in 's').
  // Explicit `path` always wins. Special case: `workstream` lives at root
  // so list_workstreams can find it predictably at <KNOWLEDGE_DIR>/workstream.md.
  private subdirFor(entity: { entityType: string; path?: string }): string {
    if (entity.path !== undefined) {
      return safeRelativeSubdir(entity.path, "entity path");
    }
    if (entity.entityType.toLowerCase() === "workstream") return "";
    const t = entity.entityType.toLowerCase();
    return safeRelativeSubdir(t.endsWith("s") ? t : t + "s", "entity type");
  }

  private filePathFor(entity: {
    name: string;
    entityType: string;
    path?: string;
  }): string {
    const subdir = this.subdirFor(entity);
    const slug = this.slugify(entity.name);
    const target = subdir
      ? path.join(this.rootDir, subdir, `${slug}.md`)
      : path.join(this.rootDir, `${slug}.md`);
    return assertInsideRoot(this.rootDir, target);
  }

  async listEntityFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
        if (e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && e.name.endsWith(".md")) {
          out.push(full);
        }
      }
    };
    await walk(this.rootDir);
    return out;
  }

  async readEntityFromFile(filePath: string): Promise<StoredEntity | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    if (typeof fm.name !== "string" || typeof fm.type !== "string") {
      return null;
    }
    const observations = extractObservations(parsed.content);
    const content = extractContent(parsed.content);
    let updated = "";
    if (typeof fm.updated === "string") updated = fm.updated;
    else if (fm.updated instanceof Date) updated = fm.updated.toISOString();
    return {
      name: fm.name,
      entityType: fm.type,
      observations,
      content,
      gist: typeof fm.gist === "string" ? fm.gist : undefined,
      tags: Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : [],
      updated,
      filePath,
    };
  }

  async findEntityByName(name: string): Promise<StoredEntity | null> {
    const files = await this.listEntityFiles();
    for (const f of files) {
      const e = await this.readEntityFromFile(f);
      if (e && e.name === name) return e;
    }
    return null;
  }

  async listAllEntities(): Promise<StoredEntity[]> {
    const files = await this.listEntityFiles();
    const entities: StoredEntity[] = [];
    for (const f of files) {
      const e = await this.readEntityFromFile(f);
      if (e) entities.push(e);
    }
    return entities;
  }

  // Returns the existing StoredEntity at the target path if its name differs;
  // null if path is free or holds the same-named entity.
  async checkSlugCollision(
    targetPath: string,
    newName: string
  ): Promise<StoredEntity | null> {
    try {
      await fs.access(targetPath);
    } catch {
      return null;
    }
    const existing = await this.readEntityFromFile(targetPath);
    if (existing && existing.name !== newName) return existing;
    return null;
  }

  async createEntity(input: EntityInput): Promise<StoredEntity> {
    const existing = await this.findEntityByName(input.name);
    if (existing) {
      throw new Error(
        `Entity '${input.name}' already exists at ${path.relative(
          this.rootDir,
          existing.filePath
        )}. Use add_observations to update or delete_entities first.`
      );
    }
    const targetPath = this.filePathFor(input);
    const collision = await this.checkSlugCollision(targetPath, input.name);
    if (collision) {
      throw new Error(
        `Slug collision: '${input.name}' would write to ${path.relative(
          this.rootDir,
          targetPath
        )}, but that file already holds entity '${collision.name}'. Choose a different name.`
      );
    }
    const stored: StoredEntity = {
      name: input.name,
      entityType: input.entityType,
      observations: input.observations ?? [],
      content: input.content,
      gist: input.gist,
      tags: input.tags ?? [],
      updated: new Date().toISOString(),
      filePath: targetPath,
    };
    await this.writeEntity(stored);
    return stored;
  }

  async writeEntity(entity: StoredEntity): Promise<void> {
    await fs.mkdir(path.dirname(entity.filePath), { recursive: true });
    const body = renderBody(entity);
    const fm: Record<string, unknown> = {
      name: entity.name,
      type: entity.entityType,
      ...(entity.gist !== undefined ? { gist: entity.gist } : {}),
      tags: entity.tags,
      updated: entity.updated,
    };
    const file = matter.stringify(body, fm);
    await fs.writeFile(entity.filePath, file);
  }

  async deleteEntities(names: string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const name of names) {
      const e = await this.findEntityByName(name);
      if (!e) continue;
      await fs.unlink(e.filePath);
      deleted.push(name);
    }
    if (deleted.length) {
      const relations = await this.readRelations();
      const removeSet = new Set(deleted);
      const filtered = relations.filter(
        (r) => !removeSet.has(r.from) && !removeSet.has(r.to)
      );
      if (filtered.length !== relations.length) {
        await this.writeRelations(filtered);
      }
    }
    return deleted;
  }

  async addObservations(
    name: string,
    contents: string[]
  ): Promise<string[]> {
    const e = await this.findEntityByName(name);
    if (!e) throw new Error(`Entity not found: '${name}'`);
    const seen = new Set(e.observations);
    const added: string[] = [];
    for (const c of contents) {
      const trimmed = c.trim();
      if (!trimmed) continue;
      if (!seen.has(trimmed)) {
        e.observations.push(trimmed);
        seen.add(trimmed);
        added.push(trimmed);
      }
    }
    if (added.length) {
      e.updated = new Date().toISOString();
      await this.writeEntity(e);
    }
    return added;
  }

  async deleteObservations(name: string, contents: string[]): Promise<void> {
    const e = await this.findEntityByName(name);
    if (!e) return;
    const remove = new Set(contents);
    const before = e.observations.length;
    e.observations = e.observations.filter((o) => !remove.has(o));
    if (e.observations.length !== before) {
      e.updated = new Date().toISOString();
      await this.writeEntity(e);
    }
  }

  async setContent(name: string, content: string): Promise<void> {
    const e = await this.findEntityByName(name);
    if (!e) throw new Error(`Entity not found: '${name}'`);
    e.content = content;
    e.updated = new Date().toISOString();
    await this.writeEntity(e);
  }

  // ---- Relations ----

  async readRelations(): Promise<Relation[]> {
    try {
      const raw = await fs.readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as { relations?: Relation[] };
      return parsed.relations ?? [];
    } catch {
      return [];
    }
  }

  async writeRelations(relations: Relation[]): Promise<void> {
    const data = { version: 1, relations };
    await fs.writeFile(
      this.indexPath(),
      JSON.stringify(data, null, 2) + "\n"
    );
  }

  async createRelations(
    rels: Relation[],
    opts: { vocabulary?: readonly string[]; strict?: boolean } = {}
  ): Promise<{
    created: Relation[];
    warnings: { relation: Relation; reason: string }[];
  }> {
    if (!rels.length) return { created: [], warnings: [] };
    const allowed = opts.vocabulary ? new Set(opts.vocabulary) : null;
    const warnings: { relation: Relation; reason: string }[] = [];

    if (allowed) {
      const strictHint = opts.strict
        ? ""
        : " The relation was created anyway because the server is running with STRICT_VOCABULARY=0. Restart with the default (strict) to enforce.";
      for (const r of rels) {
        if (!allowed.has(r.relationType)) {
          warnings.push({
            relation: r,
            reason: `'${r.relationType}' is not in the canonical vocabulary.${strictHint}`,
          });
        }
      }
      if (opts.strict && warnings.length) {
        const verbs = warnings.map((w) => `'${w.relation.relationType}'`).join(", ");
        throw new Error(
          `Strict vocabulary check rejected ${warnings.length} relation(s) with non-canonical verb(s): ${verbs}. Use a canonical verb from the 15-verb list, or restart the server with STRICT_VOCABULARY=0 to allow with warnings. Canonical verbs: ${[...allowed].join(", ")}.`
        );
      }
    }

    const existing = await this.readRelations();
    const key = (r: Relation) => `${r.from}\u0000${r.to}\u0000${r.relationType}`;
    const seen = new Set(existing.map(key));
    const created: Relation[] = [];
    for (const r of rels) {
      if (!seen.has(key(r))) {
        existing.push(r);
        seen.add(key(r));
        created.push(r);
      }
    }
    if (created.length) await this.writeRelations(existing);
    return { created, warnings };
  }

  async deleteRelations(rels: Relation[]): Promise<number> {
    if (!rels.length) return 0;
    const existing = await this.readRelations();
    const key = (r: Relation) => `${r.from}\u0000${r.to}\u0000${r.relationType}`;
    const remove = new Set(rels.map(key));
    const filtered = existing.filter((r) => !remove.has(key(r)));
    const removed = existing.length - filtered.length;
    if (removed > 0) await this.writeRelations(filtered);
    return removed;
  }

  // ---- Search / open ----

  async searchNodes(
    query: string,
    tags: string[] = []
  ): Promise<StoredEntity[]> {
    const results = await this.searchNodesDetailed({ query, tags });
    return results.map((r) => r.entity);
  }

  async searchNodesDetailed(opts: {
    query?: string;
    tags?: string[];
    entityTypes?: string[];
    since?: string;
    limit?: number;
    maxMatchesPerEntity?: number;
  }): Promise<SearchNodeResult[]> {
    const all = await this.listAllEntities();
    const query = opts.query ?? "";
    const q = query.trim().toLowerCase();
    const tags = opts.tags ?? [];
    const typeFilter = opts.entityTypes?.length
      ? new Set(opts.entityTypes.map((t) => t.toLowerCase()))
      : null;
    const sinceMs = parseSince(opts.since);
    const maxMatches = Math.max(1, opts.maxMatchesPerEntity ?? 5);

    const results: Array<SearchNodeResult & { score: number; updatedMs: number }> = [];
    for (const e of all) {
      if (tags.length && !tags.every((t) => e.tags.includes(t))) continue;
      if (typeFilter && !typeFilter.has(e.entityType.toLowerCase())) continue;
      if (!entityMatchesSince(e, sinceMs)) continue;

      const matches: SearchNodeMatch[] = [];
      if (q) {
        addTextMatch(matches, "name", e.name, query);
        addTextMatch(matches, "entityType", e.entityType, query);
        for (const tag of e.tags) addTextMatch(matches, "tag", tag, query);
        if (e.gist) addTextMatch(matches, "gist", e.gist, query);
        for (let i = 0; i < e.observations.length; i++) {
          addTextMatch(matches, "observation", e.observations[i], query, i);
        }
        if (e.content) addTextMatch(matches, "content", e.content, query);
        if (!matches.length) continue;
      }

      const limited = matches.slice(0, maxMatches);
      const whyMatched = q
        ? [...new Set(limited.map((m) => m.field))]
        : describeAppliedFilters({ tags, entityTypes: opts.entityTypes, since: opts.since });
      results.push({
        entity: e,
        matches: limited,
        matchedText: limited[0]?.snippet,
        whyMatched,
        score: matches.length ? scoreMatches(matches) : 0,
        updatedMs: entityUpdatedMs(e),
      });
    }

    results.sort((a, b) => {
      if (q && a.score !== b.score) return b.score - a.score;
      if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs;
      return a.entity.name.localeCompare(b.entity.name);
    });

    const limited = opts.limit ? results.slice(0, opts.limit) : results;
    return limited.map(({ score: _score, updatedMs: _updatedMs, ...r }) => r);
  }

  async recentActivity(opts: {
    entityTypes?: string[];
    tags?: string[];
    since?: string;
    limit?: number;
    includeObservations?: boolean;
    maxObservationsPerEntity?: number;
  }): Promise<RecentActivityItem[]> {
    const all = await this.listAllEntities();
    const typeFilter = opts.entityTypes?.length
      ? new Set(opts.entityTypes.map((t) => t.toLowerCase()))
      : null;
    const tags = opts.tags ?? [];
    const sinceMs = parseSince(opts.since);
    const includeObservations = opts.includeObservations ?? true;
    const maxObservations = Math.max(1, opts.maxObservationsPerEntity ?? 5);

    const items: Array<RecentActivityItem & { activityMs: number }> = [];
    for (const e of all) {
      if (tags.length && !tags.every((t) => e.tags.includes(t))) continue;
      if (typeFilter && !typeFilter.has(e.entityType.toLowerCase())) continue;

      const dated = datedObservations(e);
      const latestObservationMs = dated.length
        ? Math.max(...dated.map((o) => Date.parse(o.timestamp)))
        : 0;
      const updatedMs = entityUpdatedMs(e);
      const activityMs = Math.max(updatedMs, latestObservationMs);
      if (sinceMs !== null && activityMs < sinceMs) continue;

      const recentObservations = dated
        .filter((o) => sinceMs === null || Date.parse(o.timestamp) >= sinceMs)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, maxObservations);

      const reasons: string[] = [];
      if (updatedMs && updatedMs === activityMs) reasons.push("entity-updated");
      if (latestObservationMs && latestObservationMs === activityMs) {
        reasons.push("dated-observation");
      }

      items.push({
        entity: e,
        activityAt: activityMs ? new Date(activityMs).toISOString() : e.updated,
        reasons: reasons.length ? reasons : ["entity"],
        recentObservations: includeObservations ? recentObservations : [],
        activityMs,
      });
    }

    items.sort((a, b) => {
      if (a.activityMs !== b.activityMs) return b.activityMs - a.activityMs;
      return a.entity.name.localeCompare(b.entity.name);
    });
    const limited = opts.limit ? items.slice(0, opts.limit) : items;
    return limited.map(({ activityMs: _activityMs, ...item }) => item);
  }

  async openNodes(names: string[]): Promise<StoredEntity[]> {
    const want = new Set(names);
    const all = await this.listAllEntities();
    return all.filter((e) => want.has(e.name));
  }

  // ---- State primitive ----

  // Read entities only from a specific subdirectory (non-recursive). Used by
  // the state/workstream/session-state fast paths.
  private async readEntitiesInSubdir(subdir: string): Promise<StoredEntity[]> {
    const dir = path.join(this.rootDir, subdir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: StoredEntity[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const entity = await this.readEntityFromFile(path.join(dir, e.name));
      if (entity) out.push(entity);
    }
    return out;
  }

  // List all state entities in this workstream. Used by every read/write
  // path so they all see the same set.
  async listStateEntities(): Promise<StoredEntity[]> {
    const entities = await this.readEntitiesInSubdir("states");
    return entities.filter((e) => e.entityType === "state");
  }

  // Return the canonical state entity. Prefers DEFAULT_STATE_NAME; falls
  // back to most-recently-updated. If multiple exist, the caller is
  // responsible for surfacing the conflict.
  async getState(): Promise<{
    state: StoredEntity | null;
    conflicts: string[];
  }> {
    const stateOnly = await this.listStateEntities();
    if (stateOnly.length === 0) return { state: null, conflicts: [] };
    const named = stateOnly.find((e) => e.name === DEFAULT_STATE_NAME);
    const chosen =
      named ??
      [...stateOnly].sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
    const conflicts = stateOnly
      .filter((e) => e.name !== chosen.name)
      .map((e) => e.name);
    return { state: chosen, conflicts };
  }

  // Fast path: workstream entity lives at the root of KNOWLEDGE_DIR.
  async getWorkstreamEntity(): Promise<StoredEntity | null> {
    const entities = await this.readEntitiesInSubdir("");
    return entities.find((e) => e.entityType === "workstream") ?? null;
  }

  // Fast path: session-state lives in <KNOWLEDGE_DIR>/session-states/.
  async getSessionState(): Promise<StoredEntity | null> {
    const entities = await this.readEntitiesInSubdir("session-states");
    const session = entities.filter((e) => e.entityType === "session-state");
    return (
      session.find((e) => e.name === "session-state") ?? session[0] ?? null
    );
  }

  // Upsert the canonical state entity. Each field is rendered as a labeled
  // observation. Existing labeled observations are replaced; other bullets
  // (including agent-added prose-style observations) are preserved. Returns
  // any observations that look state-ish but aren't in canonical form (e.g.
  // legacy "phase: ..." with lowercase, dash-prefixed, or unlabeled prose
  // mentioning phase/next/rollback/validation) so the agent can clean up.
  async setState(opts: {
    name?: string;
    fields: StateFields;
    extraObservations?: string[];
    tags?: string[];
  }): Promise<{
    entity: StoredEntity;
    legacyObservations: string[];
    changedFields: string[];
    unchangedFields: string[];
    appendedObservations: string[];
    skippedDuplicates: string[];
    noOp: boolean;
  }> {
    let entity: StoredEntity | null = null;
    if (opts.name) {
      // Explicit name → write to that entity (create if missing).
      entity = await this.findEntityByName(opts.name);
      if (!entity) {
        entity = await this.createEntity({
          name: opts.name,
          entityType: "state",
          observations: [],
          tags: opts.tags ?? [],
        });
      }
    } else {
      // No explicit name → reuse existing state entity if exactly one exists.
      // 0 → create DEFAULT_STATE_NAME. 2+ → error so the agent picks one.
      const existing = await this.listStateEntities();
      if (existing.length === 0) {
        entity = await this.createEntity({
          name: DEFAULT_STATE_NAME,
          entityType: "state",
          observations: [],
          tags: opts.tags ?? [],
        });
      } else if (existing.length === 1) {
        entity = existing[0];
      } else {
        const names = existing.map((e) => `'${e.name}'`).join(", ");
        throw new Error(
          `Multiple state entities exist in this workstream: ${names}. Pass \`name\` to specify which to update, or delete the duplicates first. To consolidate to one canonical state, delete the others and rename the survivor to '${DEFAULT_STATE_NAME}'.`
        );
      }
    }
    // Tag merge — separate tracking for noOp computation.
    let tagsChanged = false;
    if (opts.tags && opts.tags.length) {
      const before = new Set(entity.tags);
      const merged = new Set([...entity.tags, ...opts.tags]);
      if (merged.size !== before.size) {
        entity.tags = [...merged];
        tagsChanged = true;
      }
    }

    const labels = STATE_FIELDS.map((f) => f.label);
    const isLabeled = (o: string) => labels.some((l) => o.startsWith(`${l}: `));
    const preserved = entity.observations.filter((o) => !isLabeled(o));
    const preservedSet = new Set(preserved);

    // Walk the canonical field list; for each, decide whether the new value
    // differs from the prior (changed/unchanged/missing).
    const labeled: string[] = [];
    const changedFields: string[] = [];
    const unchangedFields: string[] = [];
    for (const f of STATE_FIELDS) {
      const v = opts.fields[f.key];
      const priorObs = entity.observations.find((o) =>
        o.startsWith(`${f.label}: `)
      );
      const priorVal = priorObs ? priorObs.slice(f.label.length + 2) : undefined;
      if (typeof v === "string" && v.trim()) {
        const newVal = v.trim();
        if (newVal === priorVal) {
          unchangedFields.push(f.key);
          labeled.push(priorObs!);
        } else {
          changedFields.push(f.key);
          labeled.push(`${f.label}: ${newVal}`);
        }
      } else if (priorObs) {
        // No new value passed → keep prior verbatim.
        labeled.push(priorObs);
      }
    }

    // Dedupe extraObservations against everything already on the entity.
    const appendedObservations: string[] = [];
    const skippedDuplicates: string[] = [];
    for (const raw of opts.extraObservations ?? []) {
      const s = raw.trim();
      if (!s) continue;
      if (preservedSet.has(s) || labeled.includes(s)) {
        skippedDuplicates.push(s);
      } else {
        appendedObservations.push(s);
        preservedSet.add(s);
      }
    }

    const noOp =
      changedFields.length === 0 &&
      appendedObservations.length === 0 &&
      !tagsChanged;

    if (!noOp) {
      entity.observations = [...labeled, ...preserved, ...appendedObservations];
      entity.updated = new Date().toISOString();
      await this.writeEntity(entity);
    }

    const legacyObservations = preserved.filter(looksLikeStatePhrase);
    return {
      entity,
      legacyObservations,
      changedFields,
      unchangedFields,
      appendedObservations,
      skippedDuplicates,
      noOp,
    };
  }

  // ---- Graph traversal ----

  // BFS from `root` over relations, hop by hop, up to `depth`. Returns the
  // visited entities (with hopFromRoot annotations), the relations traversed,
  // and any dangling references (relation targets/sources without an entity
  // file). Cycles are short-circuited via a visited set.
  async traverse(opts: {
    name: string;
    direction?: "out" | "in" | "both";
    relationTypes?: string[];
    depth?: number;
  }): Promise<{
    root: StoredEntity | null;
    entities: Array<StoredEntity & { hopFromRoot: number }>;
    relations: Array<Relation & { hopFromRoot: number }>;
    maxDepthReached: number;
    truncated: boolean;
    danglingReferences: string[];
  }> {
    const requestedDepth = opts.depth ?? 1;
    const MAX_DEPTH = 5;
    const depth = Math.min(Math.max(requestedDepth, 0), MAX_DEPTH);
    const truncated = requestedDepth > MAX_DEPTH;
    const direction = opts.direction ?? "both";
    const verbFilter = opts.relationTypes
      ? new Set(opts.relationTypes)
      : null;

    const root = await this.findEntityByName(opts.name);
    if (!root) {
      return {
        root: null,
        entities: [],
        relations: [],
        maxDepthReached: 0,
        truncated,
        danglingReferences: [],
      };
    }

    if (depth === 0) {
      return {
        root,
        entities: [],
        relations: [],
        maxDepthReached: 0,
        truncated,
        danglingReferences: [],
      };
    }

    const allRelations = await this.readRelations();
    const allEntities = await this.listAllEntities();
    const entityByName = new Map(allEntities.map((e) => [e.name, e]));

    // Build adjacency. Each entry: from a node, the list of (relation, peerName, hopDirection).
    type Edge = {
      relation: Relation;
      peer: string;
      // direction we'd traverse to reach `peer` from the current node:
      // "out" means relation.from === current && we go to relation.to
      // "in" means relation.to === current && we go to relation.from
      via: "out" | "in";
    };
    const adjacency = new Map<string, Edge[]>();
    const push = (node: string, edge: Edge) => {
      const list = adjacency.get(node) ?? [];
      list.push(edge);
      adjacency.set(node, list);
    };
    for (const r of allRelations) {
      if (verbFilter && !verbFilter.has(r.relationType)) continue;
      // out edge from r.from
      push(r.from, { relation: r, peer: r.to, via: "out" });
      // in edge from r.to
      push(r.to, { relation: r, peer: r.from, via: "in" });
    }

    const visitedEntities = new Map<string, number>(); // name → hop
    const visitedRelations = new Map<string, { rel: Relation; hop: number }>();
    const relKey = (r: Relation) =>
      `${r.from}\u0000${r.to}\u0000${r.relationType}`;
    const danglingSet = new Set<string>();

    let frontier: string[] = [opts.name];
    let maxDepthReached = 0;
    for (let h = 1; h <= depth; h++) {
      const nextFrontier: string[] = [];
      for (const node of frontier) {
        const edges = adjacency.get(node) ?? [];
        for (const e of edges) {
          // Direction filter: an edge is allowed if its `via` matches the
          // requested direction (or direction is "both").
          if (direction !== "both" && e.via !== direction) continue;

          const rk = relKey(e.relation);
          if (!visitedRelations.has(rk)) {
            visitedRelations.set(rk, { rel: e.relation, hop: h });
          }

          if (e.peer === opts.name) continue; // skip back-edges to root for entity collection
          if (visitedEntities.has(e.peer)) continue;

          visitedEntities.set(e.peer, h);
          if (entityByName.has(e.peer)) {
            nextFrontier.push(e.peer);
          } else {
            danglingSet.add(e.peer);
          }
        }
      }
      if (nextFrontier.length || (adjacency.get(frontier[0]) ?? []).length) {
        maxDepthReached = h;
      }
      if (!nextFrontier.length) break;
      frontier = nextFrontier;
    }

    const entities = [...visitedEntities.entries()]
      .filter(([n]) => entityByName.has(n))
      .map(([n, hop]) => ({ ...entityByName.get(n)!, hopFromRoot: hop }))
      .sort((a, b) => a.hopFromRoot - b.hopFromRoot || a.name.localeCompare(b.name));

    const relations = [...visitedRelations.values()]
      .map((v) => ({ ...v.rel, hopFromRoot: v.hop }))
      .sort((a, b) => a.hopFromRoot - b.hopFromRoot);

    return {
      root,
      entities,
      relations,
      maxDepthReached,
      truncated,
      danglingReferences: [...danglingSet].sort(),
    };
  }

  // Merge multiple state entities into one canonical entity. Resolves the
  // "duplicate state" friction surfaced by the 8/10 review. Survivor's
  // labeled observations win; free-form observations from all sources are
  // merged and deduped. Relations referencing deleted entities are repointed
  // at the survivor; resulting self-relations are dropped.
  async consolidateState(opts: {
    keepName?: string;
    renameTo?: string;
  } = {}): Promise<{
    kept: string;
    deleted: string[];
    mergedObservations: number;
    repointedRelations: number;
    skipped: boolean;
  }> {
    const all = await this.listStateEntities();
    if (all.length === 0) {
      throw new Error("No state entities found in this workstream.");
    }
    if (all.length === 1 && !opts.renameTo) {
      return {
        kept: all[0].name,
        deleted: [],
        mergedObservations: 0,
        repointedRelations: 0,
        skipped: true,
      };
    }

    // Pick survivor.
    let survivor: StoredEntity;
    if (opts.keepName) {
      const found = all.find((e) => e.name === opts.keepName);
      if (!found) {
        throw new Error(
          `keepName '${opts.keepName}' is not among existing state entities: ${all
            .map((e) => `'${e.name}'`)
            .join(", ")}`
        );
      }
      survivor = found;
    } else {
      const def = all.find((e) => e.name === DEFAULT_STATE_NAME);
      survivor =
        def ??
        [...all].sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
    }
    const others = all.filter((e) => e.name !== survivor.name);

    // Merge observations: survivor's labeled fields win; collect unique
    // free-form observations from everyone.
    const labels = STATE_FIELDS.map((f) => f.label);
    const isLabeled = (o: string) => labels.some((l) => o.startsWith(`${l}: `));
    const survivorLabeled = survivor.observations.filter(isLabeled);
    const freeForm = new Set(survivor.observations.filter((o) => !isLabeled(o)));
    let mergedObservations = 0;
    for (const other of others) {
      for (const obs of other.observations) {
        if (isLabeled(obs)) continue;
        if (!freeForm.has(obs)) {
          freeForm.add(obs);
          mergedObservations++;
        }
      }
    }
    survivor.observations = [...survivorLabeled, ...freeForm];
    survivor.updated = new Date().toISOString();

    // Apply rename if requested. Move file by deleting old + writing new path.
    let finalName = survivor.name;
    if (opts.renameTo && opts.renameTo !== survivor.name) {
      const oldPath = survivor.filePath;
      survivor.name = opts.renameTo;
      survivor.filePath = path.join(
        this.rootDir,
        "states",
        `${this.slugify(opts.renameTo)}.md`
      );
      await this.writeEntity(survivor);
      try {
        await fs.unlink(oldPath);
      } catch {
        // already moved
      }
      finalName = opts.renameTo;
    } else {
      await this.writeEntity(survivor);
    }

    // Repoint relations from others → survivor; drop resulting self-relations.
    const otherSet = new Set(others.map((e) => e.name));
    const relations = await this.readRelations();
    const repointed: Relation[] = [];
    const seen = new Set<string>();
    let repointedCount = 0;
    for (const r of relations) {
      const fromMatch = otherSet.has(r.from);
      const toMatch = otherSet.has(r.to);
      const newFrom = fromMatch ? finalName : r.from;
      const newTo = toMatch ? finalName : r.to;
      if (fromMatch || toMatch) repointedCount++;
      if (newFrom === newTo) continue;
      const key = `${newFrom}\u0000${newTo}\u0000${r.relationType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repointed.push({ from: newFrom, to: newTo, relationType: r.relationType });
    }
    if (relations.length !== repointed.length || repointedCount > 0) {
      await this.writeRelations(repointed);
    }

    // Delete others. (Their relations are already repointed, so delete won't
    // prune anything we want to keep.)
    const deletedNames: string[] = [];
    for (const o of others) {
      try {
        await fs.unlink(o.filePath);
        deletedNames.push(o.name);
      } catch {
        // already gone
      }
    }

    return {
      kept: finalName,
      deleted: deletedNames,
      mergedObservations,
      repointedRelations: repointedCount,
      skipped: false,
    };
  }

  // Phase-archival consolidation primitive. Pure storage-side: takes a
  // pre-summarized retrospective string and a list of observations to prune,
  // creates the retro entity at retrospectives/<slug>.md, links the source
  // entity to it via `supersedes`, and removes the consumed observations.
  // The LLM call lives in the index.ts tool handler so the store stays
  // dependency-free.
  async archivePhase(opts: {
    sourceEntityName: string;
    retroEntityName: string;
    retroSummary: string;
    observationsToPrune: string[];
    tags?: string[];
  }): Promise<{
    retroEntity: StoredEntity;
    pruned: number;
    relationCreated: boolean;
  }> {
    const source = await this.findEntityByName(opts.sourceEntityName);
    if (!source) {
      throw new Error(
        `Source entity not found: '${opts.sourceEntityName}'`
      );
    }

    // Create retro entity. Idempotent: if it already exists, error so the
    // caller can pick a different name or delete the prior retro first.
    const existingRetro = await this.findEntityByName(opts.retroEntityName);
    if (existingRetro) {
      throw new Error(
        `Retrospective entity '${opts.retroEntityName}' already exists. Choose a different name or delete the prior retro first.`
      );
    }
    const retro = await this.createEntity({
      name: opts.retroEntityName,
      entityType: "retrospective",
      observations: [
        `Archived from: ${opts.sourceEntityName}`,
        `Archived at: ${new Date().toISOString()}`,
      ],
      content: opts.retroSummary,
      tags: opts.tags ?? [],
    });

    // Add supersedes relation: source → retro. Bypasses vocabulary check
    // because supersedes is canonical.
    const { created } = await this.createRelations(
      [
        {
          from: opts.sourceEntityName,
          to: opts.retroEntityName,
          relationType: "supersedes",
        },
      ],
      { vocabulary: DEFAULT_RELATION_VOCABULARY, strict: false }
    );

    // Prune the consumed observations from the source.
    if (opts.observationsToPrune.length > 0) {
      await this.deleteObservations(
        opts.sourceEntityName,
        opts.observationsToPrune
      );
    }

    return {
      retroEntity: retro,
      pruned: opts.observationsToPrune.length,
      relationCreated: created.length > 0,
    };
  }

  // Bootstrap payload for "up next?" — workstream + state + recent
  // session-state observations. Fast path: reads three known subdirs only,
  // not the full tree. Three small directory reads in parallel.
  async bootstrap(opts: { sessionObservationLimit?: number } = {}): Promise<{
    workstream: StoredEntity | null;
    state: StoredEntity | null;
    stateConflicts: string[];
    sessionState: StoredEntity | null;
    recentSessionObservations: string[];
  }> {
    const limit = opts.sessionObservationLimit ?? 10;
    const [workstream, stateResult, sessionState] = await Promise.all([
      this.getWorkstreamEntity(),
      this.getState(),
      this.getSessionState(),
    ]);
    const recentSessionObservations = sessionState
      ? sessionState.observations.slice(-limit)
      : [];
    return {
      workstream,
      state: stateResult.state,
      stateConflicts: stateResult.conflicts,
      sessionState,
      recentSessionObservations,
    };
  }

  async checkVocabulary(declared: string[]): Promise<VocabularyReport> {
    const allowed = new Set(declared);
    const relations = await this.readRelations();
    const groups = new Map<string, Relation[]>();
    for (const r of relations) {
      const list = groups.get(r.relationType) ?? [];
      list.push(r);
      groups.set(r.relationType, list);
    }
    const inUse: VocabularyReport["inUse"] = [];
    const drift: VocabularyReport["drift"] = [];
    for (const [relationType, rels] of groups) {
      const entry = {
        relationType,
        count: rels.length,
        examples: rels.slice(0, 3),
      };
      if (allowed.has(relationType)) inUse.push(entry);
      else drift.push(entry);
    }
    inUse.sort((a, b) => b.count - a.count);
    drift.sort((a, b) => b.count - a.count);
    return {
      declared,
      inUse,
      drift,
      totalRelations: relations.length,
    };
  }

  async readGraph(): Promise<{
    entities: StoredEntity[];
    relations: Relation[];
  }> {
    const [entities, relations] = await Promise.all([
      this.listAllEntities(),
      this.readRelations(),
    ]);
    return { entities, relations };
  }

  // ---- Import legacy markdown ----

  async importMarkdown(opts: {
    srcPaths: string[];
    entityType: string;
    tags?: string[];
    targetPath?: string;
    nameStrategy?: "filename" | "h1";
  }): Promise<{
    imported: string[];
    skipped: { path: string; reason: string }[];
  }> {
    const imported: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const src of opts.srcPaths) {
      try {
        const raw = await fs.readFile(src, "utf8");
        const parsed = matter(raw);
        const baseName = path.basename(src, path.extname(src));
        let name: string;
        if (opts.nameStrategy === "h1") {
          const h1 = /^#\s+(.+)$/m.exec(parsed.content);
          name = h1 ? h1[1].trim() : baseName;
        } else {
          name = baseName;
        }
        const existing = await this.findEntityByName(name);
        if (existing) {
          skipped.push({ path: src, reason: `name '${name}' already exists` });
          continue;
        }
        const bodyWithoutH1 = parsed.content.replace(/^#\s+.+\n+/, "").trim();
        const stored: StoredEntity = {
          name,
          entityType: opts.entityType,
          observations: [],
          content: bodyWithoutH1 || undefined,
          tags: opts.tags ?? [],
          updated: new Date().toISOString(),
          filePath: this.filePathFor({
            name,
            entityType: opts.entityType,
            path: opts.targetPath,
          }),
        };
        const collision = await this.checkSlugCollision(stored.filePath, name);
        if (collision) {
          skipped.push({
            path: src,
            reason: `slug collision with '${collision.name}'`,
          });
          continue;
        }
        await this.writeEntity(stored);
        imported.push(name);
      } catch (e) {
        skipped.push({ path: src, reason: (e as Error).message });
      }
    }
    return { imported, skipped };
  }
}

// The canonical relation vocabulary kept in sync with the AGENTS.md /
// CLAUDE.md files at ~/.codex/AGENTS.md and ~/.claude/CLAUDE.md.
// Update both places when adding a verb.
// Canonical state entity schema (v0). Each field is rendered as a labeled
// observation: "<Label>: <value>". set_state replaces matching observations
// without disturbing other bullets the agent has added.
export const STATE_FIELDS = [
  { key: "phase", label: "Phase" },
  { key: "nextAction", label: "Next Action" },
  { key: "doNotDoYet", label: "Do Not Do Yet" },
  { key: "keyRepos", label: "Key Repos" },
  { key: "liveSourceOfTruth", label: "Live Source Of Truth" },
  { key: "targetSourceOfTruth", label: "Target Source Of Truth" },
  { key: "rollbackUnit", label: "Rollback Unit" },
  { key: "validationSignal", label: "Validation Signal" },
] as const;

export type StateFieldKey = (typeof STATE_FIELDS)[number]["key"];
export type StateFields = Partial<Record<StateFieldKey, string>>;

export const DEFAULT_STATE_NAME = "current-state";

export const DEFAULT_RELATION_VOCABULARY: readonly string[] = [
  "uses",
  "depends-on",
  "must-follow",
  "supersedes",
  "migrated-from",
  "migrates-to",
  "deployed-to",
  "tracking",
  "summarizes",
  "blocks",
  "blocked-by",
  "validates-with",
  "rolls-back-via",
  "writes-to",
  "currently-targets",
  "repeats-from",
];

export interface VocabularyReport {
  declared: string[];
  inUse: { relationType: string; count: number; examples: Relation[] }[];
  drift: { relationType: string; count: number; examples: Relation[] }[];
  totalRelations: number;
}

export interface WorkstreamSummary {
  name: string;
  knowledgeDir: string;
  workstreamFile: string;
  gist: string;
  tags: string[];
  updated: string;
  entityCount: number;
}

// Walk one level deep under `root` for any `<workstream>/knowledge/*.md`
// whose frontmatter declares `type: workstream`. Returns one summary per
// workstream entity found (first match wins per directory). entityCount is
// computed only when `withCounts: true` — otherwise omitted (faster).
export async function listWorkstreams(
  root: string,
  opts: { withCounts?: boolean } = {}
): Promise<WorkstreamSummary[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkstreamSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const knowledgeDir = path.join(root, e.name, "knowledge");
    const summary = await findWorkstreamEntity(knowledgeDir, opts.withCounts);
    if (summary) out.push(summary);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function findWorkstreamEntity(
  knowledgeDir: string,
  withCounts = false
): Promise<WorkstreamSummary | null> {
  let files: import("node:fs").Dirent[];
  try {
    files = await fs.readdir(knowledgeDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith(".md")) continue;
    if (f.name.startsWith("_") || f.name.startsWith(".")) continue;
    const full = path.join(knowledgeDir, f.name);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const fm = matter(raw).data as Record<string, unknown>;
    if (fm.type !== "workstream" || typeof fm.name !== "string") continue;
    const gist = typeof fm.gist === "string" ? fm.gist : "";
    const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : [];
    let updated = "";
    if (typeof fm.updated === "string") updated = fm.updated;
    else if (fm.updated instanceof Date) updated = fm.updated.toISOString();
    const entityCount = withCounts ? await countEntities(knowledgeDir) : -1;
    return {
      name: fm.name,
      knowledgeDir,
      workstreamFile: full,
      gist,
      tags,
      updated,
      entityCount,
    };
  }
  return null;
}

async function countEntities(knowledgeDir: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string) => {
    let es: import("node:fs").Dirent[];
    try {
      es = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const raw = await fs.readFile(full, "utf8");
          const fm = matter(raw).data as Record<string, unknown>;
          if (typeof fm.name === "string" && typeof fm.type === "string") {
            count++;
          }
        } catch {
          // skip
        }
      }
    }
  };
  await walk(knowledgeDir);
  return count;
}

function safeRelativeSubdir(input: string, label: string): string {
  const raw = input.trim();
  if (!raw || raw === ".") return "";
  if (raw.includes("\0")) {
    throw new Error(`Unsafe ${label}: NUL bytes are not allowed.`);
  }
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error(`Unsafe ${label}: absolute paths are not allowed.`);
  }

  const slashPath = raw.replace(/\\/g, "/");
  const parts = slashPath.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error(`Unsafe ${label}: '..' path segments are not allowed.`);
  }

  const normalized = path.posix.normalize(slashPath).replace(/^\/+|\/+$/g, "");
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe ${label}: path escapes KNOWLEDGE_DIR.`);
  }
  return normalized;
}

function assertInsideRoot(rootDir: string, targetPath: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return target;
  }
  throw new Error(`Refusing to write outside KNOWLEDGE_DIR: ${target}`);
}

function parseSince(s: string | undefined): number | null {
  if (!s || !s.trim()) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new Error(
      `Invalid since value '${s}'. Use an ISO timestamp or YYYY-MM-DD.`
    );
  }
  return t;
}

function entityUpdatedMs(e: StoredEntity): number {
  const t = Date.parse(e.updated);
  return Number.isNaN(t) ? 0 : t;
}

function parseObservationDate(text: string): DatedObservation | null {
  const match = /^\[(\d{4}-\d{2}-\d{2})(?:[^\]]*)?\]/.exec(text.trim());
  if (!match) return null;
  const time = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(time)) return null;
  const timestamp = new Date(time).toISOString();
  return {
    text,
    index: -1,
    date: match[1],
    timestamp,
  };
}

function datedObservations(e: StoredEntity): DatedObservation[] {
  const out: DatedObservation[] = [];
  for (let i = 0; i < e.observations.length; i++) {
    const parsed = parseObservationDate(e.observations[i]);
    if (parsed) out.push({ ...parsed, index: i });
  }
  return out;
}

function entityMatchesSince(e: StoredEntity, sinceMs: number | null): boolean {
  if (sinceMs === null) return true;
  if (entityUpdatedMs(e) >= sinceMs) return true;
  return datedObservations(e).some((o) => Date.parse(o.timestamp) >= sinceMs);
}

function addTextMatch(
  matches: SearchNodeMatch[],
  field: SearchMatchField,
  text: string,
  query: string,
  observationIndex?: number
): void {
  const q = query.trim();
  if (!q) return;
  if (!text.toLowerCase().includes(q.toLowerCase())) return;
  matches.push({
    field,
    text,
    snippet: makeSnippet(text, q),
    ...(observationIndex !== undefined ? { observationIndex } : {}),
  });
}

function makeSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const idx = compact.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return compact.slice(0, 180);
  const start = Math.max(0, idx - 60);
  const end = Math.min(compact.length, idx + query.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function scoreMatches(matches: SearchNodeMatch[]): number {
  const weights: Record<SearchMatchField, number> = {
    name: 100,
    entityType: 80,
    tag: 70,
    gist: 60,
    observation: 50,
    content: 40,
  };
  return Math.max(...matches.map((m) => weights[m.field])) + matches.length;
}

function describeAppliedFilters(opts: {
  tags: string[];
  entityTypes?: string[];
  since?: string;
}): string[] {
  const out: string[] = [];
  if (opts.tags.length) out.push("tags");
  if (opts.entityTypes?.length) out.push("entityTypes");
  if (opts.since) out.push("since");
  return out.length ? out : ["all"];
}

// Heuristic: an observation that mentions canonical state vocabulary in any
// form other than `<Label>: value`. Used to surface legacy state notes that
// got left behind after migrating to set_state's labeled format.
const STATE_KEYWORDS = [
  "phase",
  "next action",
  "next step",
  "do not do",
  "rollback",
  "validation",
  "live source",
  "target source",
  "key repos",
];
function looksLikeStatePhrase(s: string): boolean {
  const lower = s.toLowerCase();
  return STATE_KEYWORDS.some((k) => lower.includes(k));
}

function extractObservations(body: string): string[] {
  const startMatch = /^##\s+Observations\s*$/m.exec(body);
  if (!startMatch) return [];
  const after = body.slice(startMatch.index + startMatch[0].length);
  const nextH2 = /^##\s+/m.exec(after);
  const section = nextH2 ? after.slice(0, nextH2.index) : after;
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// `## Content` is always rendered last, so we read to end-of-body. This
// preserves any H2/H3 markdown inside the content itself.
function extractContent(body: string): string | undefined {
  const startMatch = /^##\s+Content\s*$/m.exec(body);
  if (!startMatch) return undefined;
  const after = body.slice(startMatch.index + startMatch[0].length);
  const trimmed = after.trim();
  return trimmed || undefined;
}

function renderBody(e: StoredEntity): string {
  const parts: string[] = [];
  parts.push(`# ${e.name}`);
  parts.push("");
  parts.push("## Observations");
  parts.push("");
  if (e.observations.length === 0) {
    parts.push("_(no observations yet)_");
  } else {
    for (const o of e.observations) parts.push(`- ${o}`);
  }
  if (e.content !== undefined && e.content.trim() !== "") {
    parts.push("");
    parts.push("## Content");
    parts.push("");
    parts.push(e.content.trim());
  }
  parts.push("");
  return parts.join("\n");
}
