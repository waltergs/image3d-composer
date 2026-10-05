// Response schema + normalization for image analysis. Output must match the flat JSON contract in
// .claude/skills/composer-uncover/COMPOSER.md (same shape for per-image JSON and root image.json).

import { readFile } from "node:fs/promises";
import { slugify } from "../asset-pipeline/fal-queue.mjs";

export const SCENE_FIELDS = [
  "scene_name",
  "short_caption",
  "literal_description",
  "environment",
  "visual_style",
  "lighting",
  "atmosphere",
  "ambient_sound"
];

const text = (description) => ({ type: "string", description });

const SCENE_PROPERTIES = {
  scene_name: text("Short human-readable scene name."),
  short_caption: text("About 10 words, literal and factual."),
  literal_description: text("Factual visible description only. No narrative or editorial language."),
  environment: text("Physical setting and visible environmental conditions only."),
  visual_style: text("Concise visual/rendering labels only."),
  lighting: text("Visible direction, softness, temperature, contrast, shadow quality."),
  atmosphere: text("Visible fog, dust, haze, smoke, glow, weather, particles, or state none visible."),
  ambient_sound: text("Positive description of audible ambience from visible sound sources only.")
};

export const SCENE_SCHEMA = {
  type: "object",
  properties: SCENE_PROPERTIES,
  required: SCENE_FIELDS
};

export const IMAGE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    ...SCENE_PROPERTIES,
    objects: {
      type: "array",
      description: "Single, cleanly segmentable objects only. No compound assets.",
      items: {
        type: "object",
        properties: {
          id: text("Stable lowercase-hyphen slug for the object."),
          name: text("Short object name."),
          description: text("Literal description: shape, material, color, proportions."),
          count_estimate: { type: "integer", description: "Visible count of this same object, at least 1." },
          materials: { type: "array", items: { type: "string" } },
          location_in_image: text("Where the object appears in the image."),
          generate_as_3d_object: { type: "boolean", description: "True if it makes sense as a standalone 3D asset." }
        },
        required: [
          "id",
          "name",
          "description",
          "count_estimate",
          "materials",
          "location_in_image",
          "generate_as_3d_object"
        ]
      }
    }
  },
  required: [...SCENE_FIELDS, "objects"]
};

const FALLBACK_RULES = `Describe the image like a technical scene survey. Prefer concrete visible evidence over interpretation.
Do not use narrative phrases such as "feels like", "hints at", "suggests", "mysterious". If unsure, describe only what is certain.
Objects: only single rigid or mostly rigid items that can be cleanly segmented as standalone assets. Never group different items
or create compound assets. Avoid sky, fog, terrain, walls, floors, ceilings and whole buildings. Deduplicate repeated objects with count_estimate.`;

const CONTRACT_URL = new URL("../../skills/composer-uncover/COMPOSER.md", import.meta.url);

function markdownSection(markdown, title) {
  const match = markdown.match(new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return match ? match[1].trim() : "";
}

// The contract file stays the single source of truth: edit COMPOSER.md and every provider follows.
export async function loadContractRules() {
  let markdown;
  try {
    markdown = await readFile(CONTRACT_URL, "utf8");
  } catch {
    return FALLBACK_RULES;
  }
  markdown = markdown.replace(/\r\n/g, "\n");
  const rules = markdownSection(markdown, "Literal Description Rules");
  const fields = markdownSection(markdown, "Field Guidance");
  if (!rules) return FALLBACK_RULES;
  return `${rules}\n\nField guidance:\n${fields}`.trim();
}

export function buildSystemInstruction(rules) {
  return `You analyze one source image for an image-to-3D pipeline and return a JSON object.
Return only the fields in the response schema; the caller adds provenance fields (world, source_images, schema_version).

${rules}`;
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function uniqueStrings(values) {
  return [...new Set(values.filter(isNonEmptyString).map((value) => value.trim()))];
}

export function normalizeAnalysis(raw, { world, imagePath }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Analysis must be a JSON object.");
  }
  const missing = SCENE_FIELDS.filter((field) => !isNonEmptyString(raw[field]));
  if (missing.length) throw new Error(`Analysis is missing or has empty field(s): ${missing.join(", ")}`);

  const used = new Map();
  const objects = [];
  for (const candidate of Array.isArray(raw.objects) ? raw.objects : []) {
    if (!candidate || !isNonEmptyString(candidate.name)) continue;
    const baseId = slugify(candidate.id || candidate.name) || "object";
    const count = (used.get(baseId) ?? 0) + 1;
    used.set(baseId, count);
    const location = isNonEmptyString(candidate.location_in_image) ? candidate.location_in_image.trim() : undefined;

    objects.push({
      id: count === 1 ? baseId : `${baseId}-${count}`,
      name: candidate.name.trim(),
      description: isNonEmptyString(candidate.description) ? candidate.description.trim() : "",
      count_estimate: Number.isInteger(candidate.count_estimate) && candidate.count_estimate > 0 ? candidate.count_estimate : 1,
      materials: uniqueStrings(Array.isArray(candidate.materials) ? candidate.materials : []),
      source_images: [imagePath],
      evidence: location ? [{ image: imagePath, location_in_image: location }] : [],
      generate_as_3d_object: candidate.generate_as_3d_object !== false
    });
  }

  return {
    schema_version: 1,
    world,
    source_images: [imagePath],
    ...Object.fromEntries(SCENE_FIELDS.map((field) => [field, raw[field].trim()])),
    objects
  };
}

function evidenceKey(entry) {
  return `${entry.image}::${entry.location_in_image}`;
}

export function mergeObjects(objectLists) {
  const merged = [];
  const byKey = new Map();

  for (const object of objectLists.flat()) {
    const keys = [slugify(object.id), slugify(object.name)].filter(Boolean);
    const existing = keys.map((key) => byKey.get(key)).find(Boolean);

    if (!existing) {
      const copy = {
        ...object,
        materials: [...(object.materials ?? [])],
        source_images: [...(object.source_images ?? [])],
        evidence: [...(object.evidence ?? [])]
      };
      merged.push(copy);
      for (const key of keys) byKey.set(key, copy);
      continue;
    }

    existing.count_estimate = Math.max(existing.count_estimate ?? 1, object.count_estimate ?? 1);
    existing.materials = uniqueStrings([...existing.materials, ...(object.materials ?? [])]);
    existing.source_images = uniqueStrings([...existing.source_images, ...(object.source_images ?? [])]);
    const seen = new Set(existing.evidence.map(evidenceKey));
    for (const entry of object.evidence ?? []) {
      if (!seen.has(evidenceKey(entry))) existing.evidence.push(entry);
    }
    for (const key of keys) byKey.set(key, existing);
  }

  return merged;
}

// `synthesis` carries the shared scene text for multi-image worlds (one Gemini text call).
// With a single analysis it is not needed; without it the first analysis' text is used.
export function mergeAnalyses(analyses, { world, synthesis } = {}) {
  if (!analyses.length) throw new Error("No image analyses to merge.");
  const sceneSource =
    analyses.length > 1 && synthesis && SCENE_FIELDS.every((field) => isNonEmptyString(synthesis[field]))
      ? synthesis
      : analyses[0];

  return {
    schema_version: 1,
    world,
    source_images: uniqueStrings(analyses.flatMap((analysis) => analysis.source_images ?? [])),
    ...Object.fromEntries(SCENE_FIELDS.map((field) => [field, sceneSource[field]])),
    objects: mergeObjects(analyses.map((analysis) => analysis.objects ?? []))
  };
}

export function buildObjectFile(object, { world, workingDir, now = new Date() }) {
  return {
    schema_version: 1,
    world,
    object: {
      id: object.id,
      name: object.name,
      description: object.description,
      materials: object.materials ?? [],
      source_images: object.source_images ?? [],
      evidence: object.evidence ?? [],
      generate_as_3d_object: object.generate_as_3d_object !== false,
      working_dir: workingDir
    },
    updated_at: now.toISOString()
  };
}
