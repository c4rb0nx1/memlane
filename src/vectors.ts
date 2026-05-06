// Lightweight vector index, file-backed JSON. Sufficient for workstream-scale
// memlane stores (50-1000 entities × few observations each). Loaded fully on
// every query — at ~5-10MB it costs ~50ms even with naive cosine top-K.
// Swap for sqlite-vec if scale ever pushes past ~10k vectors.
//
// File location: <KNOWLEDGE_DIR>/_vectors.json (workstream-local; rebuild
// reproduces it from disk).

import fs from "node:fs/promises";
import path from "node:path";

export interface VectorRecord {
  id: string;                   // unique within the index
  source: "entity" | "observation";
  entityName: string;
  entityType: string;
  text: string;                 // what was embedded
  vec: number[];                // embedding
  updated: string;              // entity's updated timestamp at index time
  filePath: string;             // entity file path (relative to KNOWLEDGE_DIR)
}

export interface IndexFile {
  version: 1;
  model: string;
  dimension: number;
  builtAt: string;
  records: VectorRecord[];
}

export interface IndexStatus {
  exists: boolean;
  totalVectors: number;
  entityCount: number;
  observationCount: number;
  model?: string;
  dimension?: number;
  builtAt?: string;
  filePath: string;
}

export class VectorIndex {
  constructor(private readonly indexPath: string) {}

  async read(): Promise<IndexFile | null> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      return JSON.parse(raw) as IndexFile;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(file: IndexFile): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(file) + "\n");
  }

  async status(): Promise<IndexStatus> {
    const f = await this.read();
    if (!f) {
      return {
        exists: false,
        totalVectors: 0,
        entityCount: 0,
        observationCount: 0,
        filePath: this.indexPath,
      };
    }
    let entityCount = 0;
    let observationCount = 0;
    for (const r of f.records) {
      if (r.source === "entity") entityCount++;
      else observationCount++;
    }
    return {
      exists: true,
      totalVectors: f.records.length,
      entityCount,
      observationCount,
      model: f.model,
      dimension: f.dimension,
      builtAt: f.builtAt,
      filePath: this.indexPath,
    };
  }

  async search(
    queryVec: number[],
    k: number,
    opts: { entityTypes?: string[]; sourceFilter?: VectorRecord["source"] } = {}
  ): Promise<Array<VectorRecord & { similarity: number }>> {
    const f = await this.read();
    if (!f || f.records.length === 0) return [];
    const types = opts.entityTypes ? new Set(opts.entityTypes) : null;
    const scored: Array<VectorRecord & { similarity: number }> = [];
    for (const r of f.records) {
      if (opts.sourceFilter && r.source !== opts.sourceFilter) continue;
      if (types && !types.has(r.entityType)) continue;
      scored.push({ ...r, similarity: cosine(queryVec, r.vec) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
