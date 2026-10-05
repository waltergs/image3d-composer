// Minimal Gemini REST client for structured JSON output (models.generateContent).
// No dependencies. `fetch` and `sleep` are injectable so tests never touch the network.

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BAD_FINISH_REASONS = new Set([
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "OTHER",
  "LANGUAGE"
]);

// Ways to ask for schema-constrained JSON, from most to least specific. The client starts with
// the first and only falls back when the API rejects the schema itself (HTTP 400, schema error).
export const SCHEMA_MODES = ["response_schema", "response_json_schema", "prompt_only"];

export class GeminiError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function toUpperCaseTypes(schema) {
  if (Array.isArray(schema)) return schema.map(toUpperCaseTypes);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        key === "type" && typeof value === "string" ? value.toUpperCase() : toUpperCaseTypes(value)
      ])
    );
  }
  return schema;
}

export function textPart(text) {
  return { text };
}

export function inlineImagePart(mimeType, base64) {
  return { inline_data: { mime_type: mimeType, data: base64 } };
}

export function buildRequest({ systemInstruction, parts, schema, mode = SCHEMA_MODES[0] }) {
  const generationConfig = { responseMimeType: "application/json" };
  let instruction = systemInstruction;

  if (mode === "response_schema") {
    generationConfig.responseSchema = toUpperCaseTypes(schema);
  } else if (mode === "response_json_schema") {
    generationConfig.responseJsonSchema = schema;
  } else {
    instruction = `${systemInstruction ?? ""}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`.trim();
  }

  const body = { contents: [{ role: "user", parts }], generationConfig };
  if (instruction) body.systemInstruction = { parts: [{ text: instruction }] };
  return body;
}

export async function callGemini({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  body,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  retries = 3,
  baseDelayMs = 2000,
  timeoutMs = 120000
}) {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const backoff = baseDelayMs * 2 ** attempt;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = new GeminiError(`Network error calling Gemini: ${error.message}`);
      if (attempt < retries) {
        await sleep(backoff);
        continue;
      }
      throw lastError;
    }

    const raw = await response.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = undefined;
    }

    if (response.ok) {
      if (json === undefined) throw new GeminiError("Gemini returned a non-JSON response body.");
      return json;
    }

    const detail = json?.error?.message ?? raw.slice(0, 300);
    const label = json?.error?.status ? ` ${json.error.status}` : "";
    lastError = new GeminiError(`Gemini API ${response.status}${label}: ${detail}`, {
      status: response.status
    });

    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
      continue;
    }
    throw lastError;
  }

  throw lastError;
}

export function extractText(response) {
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) throw new GeminiError(`Gemini blocked the prompt (${blockReason}).`);

  const candidate = response?.candidates?.[0];
  if (!candidate) throw new GeminiError("Gemini returned no candidates.");

  const finish = candidate.finishReason;
  if (finish && BAD_FINISH_REASONS.has(finish)) {
    throw new GeminiError(`Gemini stopped early (finishReason: ${finish}).`);
  }

  const text = (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("");
  if (!text.trim()) throw new GeminiError(`Gemini returned no text (finishReason: ${finish ?? "unknown"}).`);
  return text;
}

export function parseJsonText(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new GeminiError(`Gemini did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

function looksLikeSchemaError(message) {
  return /schema|response_|responsemime|unknown name|invalid json payload|enum|type/i.test(message) &&
    !/api key/i.test(message);
}

// Calls Gemini and returns parsed JSON. `state.modeIndex` remembers which schema mode worked so
// later calls in the same run skip the modes that were rejected.
export async function generateStructured({
  apiKey,
  model,
  systemInstruction,
  parts,
  schema,
  fetchImpl,
  sleep,
  state = { modeIndex: 0 }
}) {
  const last = SCHEMA_MODES.length - 1;
  for (let index = state.modeIndex; index <= last; index += 1) {
    const body = buildRequest({ systemInstruction, parts, schema, mode: SCHEMA_MODES[index] });
    try {
      const response = await callGemini({ apiKey, model, body, fetchImpl, sleep });
      state.modeIndex = index;
      return parseJsonText(extractText(response));
    } catch (error) {
      const canFallBack =
        error instanceof GeminiError && error.status === 400 && looksLikeSchemaError(error.message) && index < last;
      if (!canFallBack) throw error;
    }
  }
  throw new GeminiError("Gemini rejected every structured-output mode.");
}
