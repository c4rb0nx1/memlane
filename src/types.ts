import { z } from "zod";

export const entityShape = {
  name: z.string().min(1).describe("Unique entity name. Canonical identifier."),
  entityType: z
    .string()
    .min(1)
    .describe(
      "Type/category, e.g. 'pipeline', 'decision', 'session-state'. Default subdir is the type plus 's'."
    ),
  observations: z
    .array(z.string())
    .default([])
    .describe("Atomic facts, one per bullet."),
  content: z
    .string()
    .optional()
    .describe(
      "Optional free-form prose (migration plans, handoff docs, troubleshooting guides)."
    ),
  gist: z
    .string()
    .optional()
    .describe(
      "Optional one-line summary, primarily used by entities of type 'workstream' for the cross-workstream registry."
    ),
  tags: z
    .array(z.string())
    .default([])
    .describe("Optional tags for filtering."),
  path: z
    .string()
    .optional()
    .describe(
      "Optional safe relative subdirectory under KNOWLEDGE_DIR. Absolute paths and '..' segments are rejected. Overrides type-based routing."
    ),
};

export const EntityInputSchema = z.object(entityShape);
export type EntityInput = z.infer<typeof EntityInputSchema>;

export const relationShape = {
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z
    .string()
    .min(1)
    .describe("Active-voice verb phrase, e.g. 'uses', 'depends-on', 'supersedes'."),
};

export const RelationSchema = z.object(relationShape);
export type Relation = z.infer<typeof RelationSchema>;

export interface StoredEntity {
  name: string;
  entityType: string;
  observations: string[];
  content?: string;
  gist?: string;
  tags: string[];
  updated: string;
  filePath: string;
}
