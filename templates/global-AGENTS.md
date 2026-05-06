# Global agent instructions

## Knowledge MCP — cross-workstream defaults

The `knowledge` MCP server is registered globally. Each workstream has its
own `knowledge/` dir and its own MCP scope — **you cannot see sibling
workstreams' data via MCP tool calls**. The data is just markdown on disk;
read across via `Read` / `Grep` when needed.

### Cross-workstream discovery (on demand, not at startup)

Do **not** auto-load sibling workstreams at session start. When the user
asks about something outside the current workstream:

1. Call `memlane.list_workstreams` for an index of `name`, `gist`,
   `knowledgeDir`, `tags`, `entityCount`.
2. Pick the relevant one based on its gist.
3. Use `Read` / `Grep` directly against `knowledgeDir` to dig in.
4. If you find facts worth carrying back into the current workstream's
   graph, copy them in via `create_entities` / `add_observations` —
   don't leave the agent dependent on cross-reads next time.

### Registering the current workstream

If the current `knowledge/` dir does not yet have a workstream entity,
create one early:

```
create_entities({
  entities: [{
    name: "<workstream-id>",
    entityType: "workstream",
    gist: "<one-line summary of what this workstream is for>",
    tags: ["..."],
  }]
})
```

The file lands at `<KNOWLEDGE_DIR>/<workstream-id>.md` (root, not a subdir)
so `list_workstreams` can find it.

### What MCP is for

- **Decisions** (`entityType: "decision"`) — architectural choices, with
  rationale in `content`. Decisions outlive chat history; record them.
- **Checklists** (`entityType: "checklist"`) — execution plans (cutover,
  rollback, verification). Items are observations; mark progress by
  appending new observations (`✓ step 1 done 2026-05-02`), not by mutating.
- **Risks** (`entityType: "risk"`) — known failure modes with mitigation
  notes. Especially anything multi-system: ALB collisions, secrets drift,
  pipeline writing to old paths, duplicate workers, DNS rollback delay.
- **Pointers** (observations on relevant entities) — repo paths, PR URLs,
  branch names, cluster names, S3 bucket names, doc paths.
- **Migration journal** — verification observations with timestamps.
  *Record that you verified at time T, not what is true forever.*
- **Relations** — the structural value-add over flat markdown. Use them.

### What MCP is NOT for

- **Secrets, tokens, kubeconfigs, passwords.** Pointers only — never values.
- **Proof of live state.** MCP records that you verified; the source of
  truth is `kubectl`, AWS console, the actual system. Re-verify if an
  observation is more than a few days old.
- **The only migration plan.** Local docs / runbooks remain the detailed
  handbook. MCP is the fast recall layer.
- **Large file dumps.** Don't paste entire manifests or pipelines.
  Reference paths instead.

### Post-action discipline

After applying any change (NodePool, Argo app, manifest update, secret
rotation, DNS change), record it in MCP **in the same turn**. Untracked
actions become drift between the graph and reality.

### Reads vs writes — when to mutate the graph

**Lookups must not write.** If the user asks "what's going on?", "up next?",
"where am I?", or any question that doesn't request an action, do not
mutate MCP. Read-style answers come from `bootstrap`, `get_state`,
`open_nodes`, `read_graph`, `search_nodes`, `recent_activity`. Tool calls that mutate
(`create_*`, `add_*`, `set_state`, `update_content`, `delete_*`) belong to
real state changes — applied actions, decisions made, blockers resolved.
Audits like `check_vocabulary` belong at session end or on explicit ask.

If you discover drift while answering a read-style question, surface it in
your reply ("by the way, I noticed X is stale") — but ask before fixing.

### Canonical state entity (first-class)

Each workstream has one canonical state entity (`entityType: "state"`,
default name: `current-state`). It always answers *"what is going on here
right now"* for a memoryless agent. **Use the dedicated tools:**

- `bootstrap` — at session start. Returns workstream + state + recent
  session observations in one call. Cheap. Replaces `read_graph` for
  cold start.
- `get_state` — anytime you need the current picture without other noise.
- `set_state` — only when state actually changes (phase advance, next
  action done, blocker resolved). Pass only the fields that changed;
  others keep their prior values.
- `reflect` — single self-edit primitive when you've learned something mid-session and want to update the graph cleanly. `action: "add"` appends an observation, `"update"` atomically replaces one with another (with reason captured), `"forget"` removes one, `"link"` / `"unlink"` add or remove a relation. Use this for natural self-curation; the granular tools (`add_observations`, `delete_observations`, `create_relations`, `delete_relations`) stay available when you want them.

- `recent_activity` — read-only timeline of recently touched entities, combining entity `updated` timestamps with date-prefixed observations. Use after a pause or handoff to see what changed lately without embeddings.

- `search_nodes` — no-vector substring search across name/type/tags/gist/observations/content. Use `tags`, `entityTypes`, `since`, and `limit` filters when you remember exact words; inspect `matchedText` / `matches` before opening full nodes.

- `semantic_search` — find what something is *about* even when you don't remember the words. Embeds the query and returns top-K nearest entities/observations. Use when substring search via `search_nodes` returns nothing relevant. Requires the index to be built (run `rebuild_index` after a batch of writes) and embedder env vars (`MEMLANE_EMBED_BASE_URL` + `MEMLANE_EMBED_API_KEY`, or `MEMLANE_LLM_*` shared with the chat config).

- `rebuild_index` — re-embed all entities + observations into `<KNOWLEDGE_DIR>/_vectors.json`. Cheap when KNOWLEDGE_DIR is small. Run after a batch of writes if `semantic_search` matters.

- `index_status` — whether the index exists, vector count, model, build time, model-mismatch flag.

- `consolidate_phase` — LLM-summarize a chunk of an entity's observations into a retrospective entity. Use at phase-completion (set_state moved to a new phase, prior phase's observations are now noise) or for recurring-operation retros (the cluster-upgrade-every-6-months pattern: each cycle's observations consolidate into a retro entity, the next cycle's state links back via `repeats-from` so a fresh agent can read prior retros via `neighbors`). Requires `MEMLANE_LLM_BASE_URL` + `MEMLANE_LLM_API_KEY` server env. Source observations are pruned by default; pass `prune: false` to dry-run.

- `health` — operational visibility. Returns `{ok, messages, knowledgeDir, telemetry}` where telemetry includes per-tool call counts, error counts, total/max latency. Call when something feels off, when the user asks "is memlane working?", or before relying on a recent write you're not sure landed. If `ok: false`, `messages` explains why and the agent should warn the user before proceeding.

- `doctor` — deeper read-only consistency audit for the graph itself. Checks invalid entity markdown, duplicate names/slug collisions, canonical state/workstream presence, dangling or non-canonical relations, and vector-index freshness/model mismatch. Use before high-risk migration work or when you need to know whether Memlane's memory graph is trustworthy. If `ok: false`, fix explicitly via the suggested tools; `doctor` does not auto-repair.

- `consolidate_state` — repair when multiple state entities exist
  (you'll see `conflicts` / `conflictWarning` in `get_state` or
  `bootstrap`). Merges all state entities into one survivor: labeled
  fields from the survivor win, free-form observations from all sources
  merge and dedupe, relations repoint at the survivor, self-relations
  drop. Pass `keepName` to choose the survivor; `renameTo: "current-state"`
  to canonicalize the name. Destructive — use only when duplicates are
  unintended (typically from pre-fix legacy entities).

### Navigating the relation graph

Relations are useful only if you query them. Use `neighbors` to traverse:

```
neighbors({
  name: "current-state",
  direction: "both",          // out | in | both — default: both
  relationTypes: ["blocked-by", "blocks"],   // optional filter
  depth: 1,                   // default: 1, max: 5
})
```

Returns the connected subgraph: visited entities (annotated with
`hopFromRoot`), the relations traversed, dangling references (relation
targets without an entity file). Cycles are handled.

Common queries:

- *"What blocks the cutover?"* →
  `neighbors({name: "cutover-plan", relationTypes: ["blocked-by"]})`
- *"What does current-state validate-with?"* →
  `neighbors({name: "current-state", relationTypes: ["validates-with"], direction: "out"})`
- *"Show me everything currently-targeting old-eu-cluster"* →
  `neighbors({name: "old-eu-cluster", relationTypes: ["currently-targets"], direction: "in"})`
- *"Cluster of related work around the EU plan, two hops"* →
  `neighbors({name: "eu-plan", depth: 2})`

`bootstrap` includes the state entity's 1-hop neighborhood by default
(`stateNeighbors`), so cold-start orientation already shows what's
related — you only need `neighbors` for ad-hoc deeper queries or filters.

Schema (v0 — fields may evolve):

- **phase** — what stage the work is in
- **nextAction** — one concrete next step (single string, not a list)
- **doNotDoYet** — work that is tempting but blocked or out of scope
- **keyRepos** — pointers to the active code
- **liveSourceOfTruth** — current production / authoritative system
- **targetSourceOfTruth** — where it's moving (if a migration)
- **rollbackUnit** — the smallest revertable change
- **validationSignal** — what tells you it's working

Distinct from `session-state`:

- `session-state` = what *I* (this agent) was doing — task-level, short-lived
- `state` (current-state) = what *this workstream* currently is — phase-level, durable

### Freshness convention

Migration state goes stale fast. When recording a fact verified against
ground truth (a `kubectl get`, an AWS console check, a pipeline run), prefix
the observation with the date: `[2026-05-02] EU pipeline matrix green`.
This makes recency visible to a memoryless agent reading later. For state
fields managed by `set_state`, the entity's `updated` timestamp tracks
last-write; the agent should re-verify before relying on values older than
~7 days for live infra.

### Relation vocabulary

Use only these `relationType` values. The server runs in strict mode by
default — non-canonical verbs cause `create_relations` to error and the
relation is not written. If a verb you need genuinely doesn't exist in the
list, ask the user before inventing; the canonical list is updated by
editing `DEFAULT_RELATION_VOCABULARY` in source, not by writing rogue
relations. To loosen enforcement temporarily (e.g. during exploration),
the server can be started with `STRICT_VOCABULARY=0` — relations then
write with warnings instead of rejecting. At session end, call
`memlane.check_vocabulary` to surface any drift accumulated during
loose-mode runs.

- `uses` — A consumes B's interface or output
- `depends-on` — A cannot run without B (causal)
- `must-follow` — A is sequenced after B (workflow ordering, not causal)
- `supersedes` — A replaces B (B is deprecated)
- `migrated-from` — A was previously B
- `migrates-to` — A is moving to B (inverse of `migrated-from`)
- `deployed-to` — A runs in B
- `tracking` — A is monitoring or referencing B for state
- `summarizes` — A is a summary of B (state entities → detail entities)
- `blocks` / `blocked-by` — A prevents progress on B (and inverse)
- `validates-with` — A is verified by B (test, check, audit)
- `rolls-back-via` — A's rollback path is B
- `writes-to` — A produces output in B (bucket, repo, manifest path)
- `currently-targets` — A is currently pointed at B (cluster, env, branch)
- `repeats-from` — A is the next instance of a recurring operation; B is the prior instance (e.g. `cluster-upgrade-2026-q3 repeats-from cluster-upgrade-2026-q1`)

Aliased / rejected (do **not** use these — map to the canonical verb):

- `runs-on` → use `deployed-to`
- `creates` → use `writes-to` (for output) or `supersedes` (for replacement)

### Stale-state handling

If you discover an observation is outdated, **don't delete it** — append
a new observation that supersedes it (`[2026-05-02 supersedes earlier
'cluster X' note: now cluster Y]`). History matters for migrations.
