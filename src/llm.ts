// Minimal OpenAI-compatible chat completion client. Used by phase-archival
// consolidation. Configured via env vars; throws clearly if unset.

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function loadLLMConfig(): LLMConfig | { error: string } {
  const baseUrl = process.env.MEMLANE_LLM_BASE_URL;
  const apiKey = process.env.MEMLANE_LLM_API_KEY;
  const model = process.env.MEMLANE_LLM_MODEL || "gpt-4o-mini";
  if (!baseUrl) {
    return {
      error:
        "MEMLANE_LLM_BASE_URL not set. Configure an OpenAI-compatible endpoint (e.g. https://litellm.internal.example/v1) to use LLM-backed tools.",
    };
  }
  if (!apiKey) {
    return {
      error:
        "MEMLANE_LLM_API_KEY not set. Configure an API key (or empty string for open endpoints) to use LLM-backed tools.",
    };
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function loadEmbedConfig(): EmbedConfig | { error: string } {
  const baseUrl =
    process.env.MEMLANE_EMBED_BASE_URL || process.env.MEMLANE_LLM_BASE_URL;
  const apiKey =
    process.env.MEMLANE_EMBED_API_KEY || process.env.MEMLANE_LLM_API_KEY;
  const model =
    process.env.MEMLANE_EMBED_MODEL || "text-embedding-3-small";
  if (!baseUrl) {
    return {
      error:
        "MEMLANE_EMBED_BASE_URL (or MEMLANE_LLM_BASE_URL) not set. Configure an OpenAI-compatible endpoint to use semantic search.",
    };
  }
  if (!apiKey) {
    return {
      error:
        "MEMLANE_EMBED_API_KEY (or MEMLANE_LLM_API_KEY) not set. Configure an API key to use semantic search.",
    };
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

export async function embed(
  cfg: EmbedConfig,
  inputs: string[]
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const url = `${cfg.baseUrl}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Embed request failed: ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 200) : ""}`
    );
  }
  const data = (await res.json()) as {
    data?: { embedding?: number[] }[];
  };
  const out: number[][] = [];
  for (const item of data.data ?? []) {
    if (!Array.isArray(item.embedding)) {
      throw new Error("embed response missing data[].embedding");
    }
    out.push(item.embedding);
  }
  if (out.length !== inputs.length) {
    throw new Error(
      `embed: expected ${inputs.length} vectors, got ${out.length}`
    );
  }
  return out;
}

export async function chat(
  cfg: LLMConfig,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 800,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `LLM request failed: ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 200) : ""}`
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response missing choices[0].message.content");
  }
  return content.trim();
}
