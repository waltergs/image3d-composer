// Offline tests: Gemini is mocked, nothing touches the network.
// Run from the repo root:  node --test .claude/scripts/analyze/analyze.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GeminiError,
  SCHEMA_MODES,
  buildRequest,
  callGemini,
  extractText,
  generateStructured,
  parseJsonText
} from "./gemini-client.mjs";
import {
  IMAGE_ANALYSIS_SCHEMA,
  SCENE_FIELDS,
  buildObjectFile,
  loadContractRules,
  mergeAnalyses,
  mergeObjects,
  normalizeAnalysis
} from "./analysis-schema.mjs";
import { confirmObjects, listObjects, runAnalyze } from "./analyze-image.mjs";

const SCRIPT = fileURLToPath(new URL("./analyze-image.mjs", import.meta.url));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const noSleep = async () => {};

const RAW = {
  scene_name: "Test Room",
  short_caption: "A small room with a wooden chair.",
  literal_description: "A small room has a wooden chair near the left wall.",
  environment: "Indoor room with plain walls.",
  visual_style: "photorealistic",
  lighting: "Soft overhead light.",
  atmosphere: "No fog, dust or haze visible.",
  ambient_sound: "Low ventilation hum.",
  objects: [
    {
      id: "Wooden Chair",
      name: "wooden chair",
      description: "Four-legged wooden chair.",
      count_estimate: 2,
      materials: ["wood", "wood"],
      location_in_image: "left foreground",
      generate_as_3d_object: true
    },
    {
      id: "wooden chair",
      name: "Wooden chair (second)",
      description: "Another chair.",
      count_estimate: 1,
      materials: [],
      location_in_image: "",
      generate_as_3d_object: true
    }
  ]
};

const response = (json, status = 200) => () => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(json)
});
const geminiText = (value) => ({
  candidates: [{ content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] }, finishReason: "STOP" }]
});
const apiError = (status, message, retryAfter) => () => ({
  ok: false,
  status,
  headers: { get: (name) => (name === "retry-after" ? retryAfter ?? null : null) },
  text: async () => JSON.stringify({ error: { code: status, message, status: "INVALID_ARGUMENT" } })
});

function mockFetch(handlers) {
  const queue = [...handlers];
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const handler = queue.length > 1 ? queue.shift() : queue[0];
    return handler();
  };
  fn.calls = calls;
  return fn;
}

async function inTempProject(fn) {
  const previous = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), "composer-test-"));
  process.chdir(dir);
  process.env.GEMINI_API_KEY = "test-key-never-real";
  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

async function putImage(world, name, bytes = PNG) {
  const dir = path.join("worlds", world, "source");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
}

// ---------- client ----------

test("buildRequest: schema mode 1 uses uppercase types and no temperature", () => {
  const body = buildRequest({
    systemInstruction: "rules",
    parts: [{ text: "hi" }],
    schema: IMAGE_ANALYSIS_SCHEMA
  });
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
  assert.equal(body.generationConfig.responseSchema.properties.objects.items.type, "OBJECT");
  assert.equal("temperature" in body.generationConfig, false);
  assert.equal(body.systemInstruction.parts[0].text, "rules");
  assert.equal(body.contents[0].role, "user");
});

test("buildRequest: json-schema mode keeps lowercase types; prompt-only embeds the schema", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const second = buildRequest({ systemInstruction: "x", parts: [], schema, mode: SCHEMA_MODES[1] });
  assert.equal(second.generationConfig.responseJsonSchema.type, "object");
  const third = buildRequest({ systemInstruction: "x", parts: [], schema, mode: SCHEMA_MODES[2] });
  assert.equal("responseSchema" in third.generationConfig, false);
  assert.match(third.systemInstruction.parts[0].text, /Return ONLY a JSON object/);
});

test("callGemini retries 429 honoring Retry-After, then succeeds", async () => {
  const sleeps = [];
  const fetchImpl = mockFetch([apiError(429, "quota", "7"), response({ ok: true })]);
  const result = await callGemini({
    apiKey: "k", body: {}, fetchImpl, sleep: async (ms) => sleeps.push(ms)
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [7000]);
  assert.match(fetchImpl.calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(fetchImpl.calls[0].init.headers["x-goog-api-key"], "k");
});

test("callGemini does not retry a 400 and never leaks the key in the message", async () => {
  const fetchImpl = mockFetch([apiError(400, "API key not valid. Please pass a valid API key.")]);
  await assert.rejects(
    () => callGemini({ apiKey: "super-secret", body: {}, fetchImpl, sleep: noSleep }),
    (error) => error instanceof GeminiError && error.status === 400 && !error.message.includes("super-secret")
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("extractText rejects blocked prompts, empty candidates and early stops", () => {
  assert.throws(() => extractText({ promptFeedback: { blockReason: "SAFETY" } }), /blocked/);
  assert.throws(() => extractText({ candidates: [] }), /no candidates/);
  assert.throws(
    () => extractText({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }] }),
    /MAX_TOKENS/
  );
  assert.equal(extractText(geminiText("hello")), "hello");
});

test("parseJsonText strips markdown fences and reports bad JSON", () => {
  assert.deepEqual(parseJsonText('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonText("not json"), /valid JSON/);
});

test("generateStructured falls back on schema errors but not on a bad API key", async () => {
  const schemaRejected = apiError(400, 'Invalid JSON payload received. Unknown name "responseSchema"');
  const fetchImpl = mockFetch([schemaRejected, response(geminiText({ ok: 1 }))]);
  const state = { modeIndex: 0 };
  const result = await generateStructured({
    apiKey: "k", model: "m", systemInstruction: "s", parts: [], schema: { type: "object" }, fetchImpl, sleep: noSleep, state
  });
  assert.deepEqual(result, { ok: 1 });
  assert.equal(state.modeIndex, 1);
  assert.equal("responseJsonSchema" in fetchImpl.calls[1].body.generationConfig, true);

  const badKey = mockFetch([apiError(400, "API key not valid. Please pass a valid API key.")]);
  await assert.rejects(
    () => generateStructured({ apiKey: "k", parts: [], schema: { type: "object" }, fetchImpl: badKey, sleep: noSleep }),
    /API key not valid/
  );
  assert.equal(badKey.calls.length, 1);
});

// ---------- schema / contract ----------

test("normalizeAnalysis matches the flat contract and dedupes object ids", () => {
  const out = normalizeAnalysis(RAW, { world: "room", imagePath: "worlds/room/source/0-room.png" });
  assert.deepEqual(Object.keys(out), ["schema_version", "world", "source_images", ...SCENE_FIELDS, "objects"]);
  assert.deepEqual(out.objects.map((o) => o.id), ["wooden-chair", "wooden-chair-2"]);
  assert.deepEqual(out.objects[0].materials, ["wood"]);
  assert.deepEqual(out.objects[0].evidence, [{ image: "worlds/room/source/0-room.png", location_in_image: "left foreground" }]);
  assert.deepEqual(out.objects[1].evidence, []);
  assert.equal("images" in out, false);
});

test("normalizeAnalysis rejects missing scene fields", () => {
  assert.throws(() => normalizeAnalysis({ ...RAW, lighting: "" }, { world: "w", imagePath: "p" }), /lighting/);
  assert.throws(() => normalizeAnalysis(null, { world: "w", imagePath: "p" }), /JSON object/);
});

test("mergeObjects unions evidence, materials and sources by id or name", () => {
  const a = [{ id: "lamp", name: "lamp", description: "d", count_estimate: 1, materials: ["metal"], source_images: ["a.png"], evidence: [{ image: "a.png", location_in_image: "left" }], generate_as_3d_object: true }];
  const b = [{ id: "desk-lamp", name: "Lamp", description: "d2", count_estimate: 3, materials: ["glass"], source_images: ["b.png"], evidence: [{ image: "b.png", location_in_image: "right" }], generate_as_3d_object: true }];
  const [merged, ...rest] = mergeObjects([a, b]);
  assert.equal(rest.length, 0);
  assert.equal(merged.count_estimate, 3);
  assert.deepEqual(merged.materials, ["metal", "glass"]);
  assert.deepEqual(merged.source_images, ["a.png", "b.png"]);
  assert.equal(merged.evidence.length, 2);
});

test("mergeAnalyses uses synthesis for multi-image worlds and the first image otherwise", () => {
  const one = normalizeAnalysis(RAW, { world: "w", imagePath: "a.png" });
  const two = normalizeAnalysis({ ...RAW, scene_name: "Other" }, { world: "w", imagePath: "b.png" });
  const synthesis = Object.fromEntries(SCENE_FIELDS.map((f) => [f, `merged ${f}`]));
  assert.equal(mergeAnalyses([one, two], { world: "w", synthesis }).scene_name, "merged scene_name");
  assert.equal(mergeAnalyses([one, two], { world: "w" }).scene_name, "Test Room");
  assert.deepEqual(mergeAnalyses([one, two], { world: "w" }).source_images, ["a.png", "b.png"]);
});

test("buildObjectFile follows the object.json shape from the skill", () => {
  const object = normalizeAnalysis(RAW, { world: "room", imagePath: "p.png" }).objects[0];
  const file = buildObjectFile(object, { world: "room", workingDir: "worlds/room/output/wooden-chair", now: new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(Object.keys(file), ["schema_version", "world", "object", "updated_at"]);
  assert.deepEqual(Object.keys(file.object), ["id", "name", "description", "materials", "source_images", "evidence", "generate_as_3d_object", "working_dir"]);
  assert.equal(file.updated_at, "2026-01-01T00:00:00.000Z");
});

test("loadContractRules reads the rules from COMPOSER.md", async () => {
  const rules = await loadContractRules();
  assert.match(rules, /technical scene survey/);
  assert.doesNotMatch(rules, /\r/);
});

// ---------- end to end (mocked Gemini) ----------

test("runAnalyze writes per-image JSON and image.json, reuses analysis, redoes with force", async () => {
  await inTempProject(async () => {
    await putImage("room", "0-room.png");
    const fetchImpl = mockFetch([response(geminiText(RAW))]);

    const first = await runAnalyze({ world: "room", fetchImpl, sleep: noSleep });
    assert.equal(first.analyzed.length, 1);
    assert.equal(first.failed.length, 0);
    assert.equal(fetchImpl.calls.length, 1);

    const sent = fetchImpl.calls[0].body.contents[0].parts;
    assert.equal(sent[0].inline_data.mime_type, "image/png");
    assert.equal(sent[0].inline_data.data, PNG.toString("base64"));
    assert.match(sent[1].text, /worlds\/room\/source\/0-room\.png/);

    const perImage = JSON.parse(await readFile("worlds/room/source/0-room.json", "utf8"));
    const root = JSON.parse(await readFile("worlds/room/image.json", "utf8"));
    assert.deepEqual(Object.keys(perImage), ["schema_version", "world", "source_images", ...SCENE_FIELDS, "objects"]);
    assert.deepEqual(root, perImage);
    assert.deepEqual(first.objects.map((o) => o.id), ["wooden-chair", "wooden-chair-2"]);

    const second = await runAnalyze({ world: "room", fetchImpl, sleep: noSleep });
    assert.equal(second.skipped.length, 1);
    assert.equal(fetchImpl.calls.length, 1);

    await runAnalyze({ world: "room", force: true, instructions: "ignore the rug", fetchImpl, sleep: noSleep });
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[1].body.contents[0].parts[1].text, /ignore the rug/);
  });
});

test("runAnalyze picks the newest image of a family and skips unsupported formats", async () => {
  await inTempProject(async () => {
    await putImage("room", "0-room.png");
    await putImage("room", "1-room-plate.png");
    await putImage("room", "0-anim.gif", Buffer.from("GIF89a"));
    const fetchImpl = mockFetch([response(geminiText(RAW))]);
    const out = await runAnalyze({ world: "room", fetchImpl, sleep: noSleep });
    const names = out.analyzed.map((item) => path.basename(item.image)).sort();
    assert.deepEqual(names, ["1-room-plate.png"]);
    assert.equal(out.failed.length, 1);
    assert.match(out.failed[0].error, /Unsupported image format/);
  });
});

test("runAnalyze with several families asks Gemini for a shared scene, and falls back if that fails", async () => {
  await inTempProject(async () => {
    await putImage("lab", "0-front.png");
    await putImage("lab", "0-back.png");
    const synthesis = Object.fromEntries(SCENE_FIELDS.map((f) => [f, `shared ${f}`]));
    const fetchImpl = mockFetch([
      response(geminiText({ ...RAW, scene_name: "Back" })),
      response(geminiText({ ...RAW, scene_name: "Front" })),
      response(geminiText(synthesis))
    ]);
    const out = await runAnalyze({ world: "lab", fetchImpl, sleep: noSleep });
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(out.scene_name, "shared scene_name");
    assert.equal(JSON.parse(await readFile("worlds/lab/image.json", "utf8")).source_images.length, 2);

    const failing = mockFetch([apiError(400, "boom")]);
    const merged = await runAnalyze({ world: "lab", mergeOnly: true, fetchImpl: failing, sleep: noSleep });
    assert.match(merged.warning, /Could not synthesize/);
    assert.ok(merged.scene_name);
  });
});

test("--dry-run needs no key, makes no request and writes nothing", async () => {
  await inTempProject(async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    await putImage("room", "0-room.png");
    const fetchImpl = mockFetch([response({})]);
    const out = await runAnalyze({ world: "room", dryRun: true, fetchImpl });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(out.analyzed[0].dry_run, true);
    const files = await readdir("worlds/room/source");
    assert.deepEqual(files, ["0-room.png"]);
  });
});

test("a missing key fails with instructions, an out-of-folder image is refused", async () => {
  await inTempProject(async () => {
    await putImage("room", "0-room.png");
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    await assert.rejects(() => runAnalyze({ world: "room" }), /aistudio\.google\.com\/apikey/);

    process.env.GEMINI_API_KEY = "k";
    await writeFile("outside.png", PNG);
    const out = await runAnalyze({ world: "room", images: ["outside.png"], fetchImpl: mockFetch([response(geminiText(RAW))]), sleep: noSleep });
    assert.match(out.failed[0].error, /must be inside/);
  });
});

test("listObjects and confirmObjects write object.json files", async () => {
  await inTempProject(async () => {
    await putImage("room", "0-room.png");
    await runAnalyze({ world: "room", fetchImpl: mockFetch([response(geminiText(RAW))]), sleep: noSleep });

    assert.deepEqual((await listObjects("room")).map((o) => o.id), ["wooden-chair", "wooden-chair-2"]);
    const result = await confirmObjects({ world: "room", selection: "wooden-chair" });
    assert.deepEqual(result.written, ["worlds/room/output/wooden-chair/object.json"]);

    const file = JSON.parse(await readFile("worlds/room/output/wooden-chair/object.json", "utf8"));
    assert.equal(file.object.working_dir, "worlds/room/output/wooden-chair");
    await assert.rejects(() => confirmObjects({ world: "room", selection: "sofa" }), /Unknown object id\(s\): sofa/);

    const all = await confirmObjects({ world: "room", selection: "all" });
    assert.equal(all.written.length, 2);
  });
});

test("CLI entry point runs when invoked directly and prints usage without --world", () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: node \.claude\/scripts\/analyze\/analyze-image\.mjs/);
});
