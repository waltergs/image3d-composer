#!/usr/bin/env node
// Scripted image analysis with Google Gemini (AI Studio key, free tier available).
// Replaces the "agent reads the image" step of /composer-uncover so any agent, or a person, can
// run the pipeline. Writes the same files as the skill:
//   worlds/<slug>/source/<image-name>.json   per-image analysis
//   worlds/<slug>/image.json                  merged scene analysis
//   worlds/<slug>/output/<object-id>/object.json   after --confirm-objects
//
// Usage:
//   node .claude/scripts/analyze/analyze-image.mjs --world <slug> [--image <path>] [--model <id>]
//        [--instructions "<extra guidance>"] [--force] [--merge-only] [--dry-run]
//   node .claude/scripts/analyze/analyze-image.mjs --world <slug> --list-objects
//   node .claude/scripts/analyze/analyze-image.mjs --world <slug> --confirm-objects all|id1,id2
//
// Needs GEMINI_API_KEY (or GOOGLE_API_KEY) in .env. Free-tier requests may be used by Google to
// improve its products: use a paid-tier key for private images.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDir,
  inferMime,
  loadDotEnv,
  one,
  parseArgs,
  pathExists,
  readJson,
  slugify,
  writeJson
} from "../asset-pipeline/fal-queue.mjs";
import { isVisibleFile, parseIndexedName } from "../asset-pipeline/request-metadata.mjs";
import { ensureProjectState } from "../project/project-state.mjs";
import {
  DEFAULT_GEMINI_MODEL,
  GeminiError,
  generateStructured,
  inlineImagePart,
  textPart
} from "./gemini-client.mjs";
import {
  IMAGE_ANALYSIS_SCHEMA,
  SCENE_FIELDS,
  SCENE_SCHEMA,
  buildObjectFile,
  buildSystemInstruction,
  loadContractRules,
  mergeAnalyses,
  normalizeAnalysis
} from "./analysis-schema.mjs";

const GEMINI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);
// Inline requests are capped at 20MB total and base64 adds ~33%.
const MAX_IMAGE_BYTES = 14 * 1024 * 1024;

const toPosix = (value) => value.split(path.sep).join("/");

async function resolveApiKey() {
  await loadDotEnv();
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey and add GEMINI_API_KEY=... to .env"
    );
  }
  return key;
}

function familyKey(fileName) {
  const parsed = parseIndexedName(fileName);
  const slug = parsed ? parsed.slug : path.basename(fileName, path.extname(fileName));
  return slug.replace(/-plate$/, "");
}

// One image per family: the highest index wins (a clean plate replaces its source).
async function listSourceImages(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const families = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !isVisibleFile(entry.name)) continue;
    if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const index = parseIndexedName(entry.name)?.index ?? -1;
    const key = familyKey(entry.name);
    const current = families.get(key);
    if (!current || index > current.index) families.set(key, { index, name: entry.name });
  }
  return [...families.values()].map((item) => path.join(sourceDir, item.name)).sort();
}

async function readAnalysisFiles(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const analyses = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isVisibleFile(entry.name) || path.extname(entry.name).toLowerCase() !== ".json") continue;
    try {
      const json = await readJson(path.join(sourceDir, entry.name));
      if (json && typeof json.scene_name === "string" && Array.isArray(json.objects)) analyses.push(json);
    } catch {
      // Skip unreadable JSON; project-state counts files, validity is checked here.
    }
  }
  return analyses;
}

async function loadImagePart(imagePath) {
  const mime = inferMime(imagePath);
  if (!GEMINI_IMAGE_MIMES.has(mime)) {
    throw new Error(`Unsupported image format for Gemini (${path.extname(imagePath) || "unknown"}). Use PNG, JPEG, WEBP, HEIC or HEIF.`);
  }
  const { size } = await stat(imagePath);
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(size / 1048576).toFixed(1)}MB; the inline limit is about 14MB. Downscale it first.`);
  }
  return inlineImagePart(mime, (await readFile(imagePath)).toString("base64"));
}

function describeError(error) {
  if (!(error instanceof GeminiError)) return error.message;
  if (error.status === 429) {
    return `${error.message}\n  Free-tier quota or rate limit reached. Wait a minute, or try --model gemini-3.5-flash-lite.`;
  }
  if (/api key/i.test(error.message)) {
    return `${error.message}\n  Check GEMINI_API_KEY in .env (create one at https://aistudio.google.com/apikey).`;
  }
  return error.message;
}

async function analyzeOneImage({ imagePath, world, model, instructions, rules, apiKey, fetchImpl, sleep, state, dryRun }) {
  const relative = toPosix(imagePath);
  const parts = [
    await loadImagePart(imagePath),
    textPart(
      `Source image: ${relative}\nAnalyze this image following the rules.${instructions ? `\nAdditional guidance from the user: ${instructions}` : ""}`
    )
  ];
  const systemInstruction = buildSystemInstruction(rules);

  if (dryRun) {
    return {
      dry_run: true,
      model,
      image: relative,
      image_bytes: parts[0].inline_data.data.length,
      system_instruction_chars: systemInstruction.length,
      schema_properties: Object.keys(IMAGE_ANALYSIS_SCHEMA.properties)
    };
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await generateStructured({
        apiKey,
        model,
        systemInstruction,
        parts,
        schema: IMAGE_ANALYSIS_SCHEMA,
        fetchImpl,
        sleep,
        state
      });
      return normalizeAnalysis(raw, { world, imagePath: relative });
    } catch (error) {
      lastError = error;
      // Only malformed model output is worth a second try; API/network errors already retried.
      const retryable = error instanceof GeminiError ? /valid JSON/.test(error.message) : /^Analysis /.test(error.message);
      if (!retryable) break;
    }
  }
  throw lastError;
}

async function synthesizeScene({ analyses, model, apiKey, fetchImpl, sleep, state }) {
  const records = analyses.map((analysis) =>
    Object.fromEntries(SCENE_FIELDS.map((field) => [field, analysis[field]]))
  );
  return generateStructured({
    apiKey,
    model,
    systemInstruction:
      "Merge several literal scene analyses of the same world into one. Synthesize one shared scene_name, short_caption and " +
      "literal_description, and merge environment, visual_style, lighting, atmosphere and ambient_sound from common or " +
      "representative visible traits. Keep literal, factual language; no narrative or editorial framing.",
    parts: [textPart(JSON.stringify(records, null, 2))],
    schema: SCENE_SCHEMA,
    fetchImpl,
    sleep,
    state
  });
}

export async function runAnalyze(options) {
  await loadDotEnv(); // so GEMINI_MODEL in .env is honored below
  const {
    world: rawWorld,
    images = [],
    model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    instructions,
    force = false,
    mergeOnly = false,
    dryRun = false,
    fetchImpl,
    sleep
  } = options;
  const world = slugify(rawWorld || "");
  if (!world) throw new Error("--world <slug> is required.");

  const project = await ensureProjectState({ slug: world, write: true });
  const sourceDir = project.paths.source;
  const imageJsonPath = project.paths.image;
  const summary = { world, model, analyzed: [], skipped: [], failed: [] };

  if (!mergeOnly) {
    const selected = images.length ? images.map((image) => path.normalize(image)) : await listSourceImages(sourceDir);
    if (!selected.length) {
      throw new Error(`No source images found in ${toPosix(sourceDir)}. Put images in input/ and run project-state.mjs --world ${world} --stage-input.`);
    }

    const apiKey = dryRun ? undefined : await resolveApiKey();
    const rules = await loadContractRules();
    const state = { modeIndex: 0 };

    for (const imagePath of selected) {
      const relative = toPosix(imagePath);
      if (path.dirname(path.resolve(imagePath)) !== path.resolve(sourceDir)) {
        summary.failed.push({ image: relative, error: `Image must be inside ${toPosix(sourceDir)}.` });
        continue;
      }
      const analysisPath = path.join(sourceDir, `${path.basename(imagePath, path.extname(imagePath))}.json`);
      if (!force && !dryRun && (await pathExists(analysisPath))) {
        summary.skipped.push({ image: relative, reason: "analysis exists (use --force to redo)" });
        continue;
      }

      try {
        const result = await analyzeOneImage({
          imagePath, world, model, instructions, rules, apiKey, fetchImpl, sleep, state, dryRun
        });
        if (dryRun) {
          summary.analyzed.push(result);
        } else {
          await writeJson(analysisPath, result);
          summary.analyzed.push({ image: relative, analysis: toPosix(analysisPath), objects: result.objects.length });
        }
      } catch (error) {
        summary.failed.push({ image: relative, error: describeError(error) });
      }
    }
  }

  if (dryRun) return summary;

  const analyses = await readAnalysisFiles(sourceDir);
  if (!analyses.length) {
    summary.image_json = null;
    return summary;
  }

  let synthesis;
  if (analyses.length > 1) {
    try {
      synthesis = await synthesizeScene({
        analyses, model, apiKey: await resolveApiKey(), fetchImpl, sleep, state: { modeIndex: 0 }
      });
    } catch (error) {
      summary.warning = `Could not synthesize a shared scene description (${describeError(error)}); used the first image's text.`;
    }
  }

  const merged = mergeAnalyses(analyses, { world, synthesis });
  await writeJson(imageJsonPath, merged);
  summary.image_json = toPosix(imageJsonPath);
  summary.scene_name = merged.scene_name;
  summary.objects = merged.objects.map(({ id, name, count_estimate }) => ({ id, name, count_estimate }));
  return summary;
}

export async function listObjects(worldInput) {
  const world = slugify(worldInput || "");
  const imageJsonPath = path.join("worlds", world, "image.json");
  if (!(await pathExists(imageJsonPath))) {
    throw new Error(`worlds/${world}/image.json not found. Run the analysis first.`);
  }
  const image = await readJson(imageJsonPath);
  return image.objects.map(({ id, name, count_estimate, description }) => ({ id, name, count_estimate, description }));
}

export async function confirmObjects({ world: worldInput, selection, now }) {
  const world = slugify(worldInput || "");
  const imageJsonPath = path.join("worlds", world, "image.json");
  if (!(await pathExists(imageJsonPath))) {
    throw new Error(`worlds/${world}/image.json not found. Run the analysis first.`);
  }
  const image = await readJson(imageJsonPath);
  const available = new Map(image.objects.map((object) => [object.id, object]));
  const wanted =
    selection === "all"
      ? [...available.keys()]
      : String(selection).split(",").map((id) => slugify(id.trim())).filter(Boolean);
  const unknown = wanted.filter((id) => !available.has(id));
  if (unknown.length) {
    throw new Error(`Unknown object id(s): ${unknown.join(", ")}. Available: ${[...available.keys()].join(", ")}`);
  }

  const written = [];
  for (const id of wanted) {
    const objectDir = path.join("worlds", world, "output", id);
    await ensureDir(objectDir);
    const file = path.join(objectDir, "object.json");
    await writeJson(file, buildObjectFile(available.get(id), { world, workingDir: toPosix(objectDir), now }));
    written.push(toPosix(file));
  }
  return { world, confirmed: wanted, written };
}

async function main() {
  const { flags } = parseArgs();
  const world = one(flags, "world") || one(flags, "slug");
  if (!world) {
    console.error("Usage: node .claude/scripts/analyze/analyze-image.mjs --world <slug> [--image <path>] [--model <id>] [--instructions <text>] [--force] [--merge-only] [--dry-run]\n       ... --world <slug> --list-objects\n       ... --world <slug> --confirm-objects all|id1,id2");
    process.exit(2);
  }

  if (flags["list-objects"]) {
    console.log(JSON.stringify(await listObjects(world), null, 2));
    return;
  }
  if (flags["confirm-objects"]) {
    console.log(JSON.stringify(await confirmObjects({ world, selection: one(flags, "confirm-objects") }), null, 2));
    return;
  }

  const images = flags.image === undefined ? [] : [].concat(flags.image).filter((value) => value !== true);
  const summary = await runAnalyze({
    world,
    images,
    model: one(flags, "model"),
    instructions: one(flags, "instructions"),
    force: Boolean(flags.force),
    mergeOnly: Boolean(flags["merge-only"]),
    dryRun: Boolean(flags["dry-run"])
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exit(1);
}

// pathToFileURL keeps this check correct on Windows too (argv[1] is a drive path there).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
