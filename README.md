<img width="960" height="540" alt="image3d-composer-1" src="https://github.com/user-attachments/assets/d294e420-eb48-4f00-b6a8-13005442d1a8" />

## image3D Composer
Creates 3D environments, SFX, and meshes from a single image using Claude skills, World Labs, and FAL. 

Can take you from an image to a fully meshed 3D environment in < 5 minutes, great for jumpstarting 3D work. Go full blast.

> Fork of [image-blaster](https://github.com/neilsonnn/image-blaster) by Neilson Koerner-Safrata (MIT).


## Quickstart

1. Open a Terminal, enter `git clone https://github.com/waltergs/image3d-composer`
2. Enter the directory with `cd image3d-composer`
3. Run `claude` (install with `curl -fsSL https://claude.ai/install.sh | bash`)
4. Say hello to Claude, and give them your API key for [World Labs](https://platform.worldlabs.ai/) and [FAL](https://fal.ai/).
5. Put an image into `input/` directory and ask Claude to `compose it and confirm each step with me`.

### Description

By default image3D Composer will use your input image to create:

1. 3D models (`.glb`, `.obj`) of all *dynamic* objects
2. Gaussian splat (`.spz`) of the *static* environment,
3. Ambient looping sound and object specific physics SFX (`.mp3`)

### Extensions

You can embed image3D Composer under the assets of *any game engine, DCC software, or web app*.

1. Unity, Unreal, or Godot game engine
2. Blender, 3DS Max, or Maya or other DCC software
3. Three.js web app or Electron app

## Advanced

IMAGE3D COMPOSER uses a few generation models:

- `marble-1.1` - World Labs Marble model creates the explorable environment.
- `nano-banana` - default image edit preference for source cleanup, clean plates, and object reference images.
- `gpt-image-2` - alternate image edit provider when the edit skill is asked to prefer it.
- `hunyuan-3d` - Hunyuan 3D model creates 3D object models through FAL.
- `elevenlabs-sfx` - ElevenLabs sound effects model creates ambient and object-specific sounds.
- `gemini` - optional image analysis provider (`gemini-3.8-flash` by default, Google AI Studio key) that replaces the agent reading the image.

3D model creation supports these Hunyuan parameters:

- `--face-count <40000-1500000>`: target face count. IMAGE3D COMPOSER defaults to `50000`; Hunyuan's API default is `500000`.
- `--enable-pbr true|false`: enable PBR material generation. Defaults to `true`.
- `--generate-type Normal|LowPoly|Geometry`: `Normal` creates a textured model, `LowPoly` applies polygon reduction, and `Geometry` creates a white geometry-only model. Defaults to `Normal`.
- `--polygon-type triangle|quadrilateral`: polygon type for `LowPoly`. Defaults to `triangle`.

### Image analysis without an agent (Gemini)

The analysis step can run as a plain script with a Google AI Studio key (free tier available), so it does not depend on the agent reading images. Add `GEMINI_API_KEY` to `.env`, then:

```bash
node .claude/scripts/project/project-state.mjs --world my-room --stage-input
node .claude/scripts/analyze/analyze-image.mjs --world my-room
node .claude/scripts/analyze/analyze-image.mjs --world my-room --confirm-objects all
```

It writes the same files as `/composer-uncover`. Use `--dry-run` to preview the request, `--model <id>` to switch models (default `gemini-3.8-flash`), and `--list-objects` before confirming. Free-tier requests may be used by Google to improve its products, so use a paid-tier key for private images. Offline tests: `node --test .claude/scripts/analyze/analyze.test.mjs`.

### Examples

- Video game level concepts? `COMPOSE` it.
- Your childhood bedroom? `COMPOSE` it.
- Need an environment for a robot? `COMPOSE` it.
- A film location scout? `COMPOSE` it.
- An architectural rendering? `COMPOSE` it.

### Development

- remove `/app` from the `.claudeignore` file to give Claude the ability to change the React viewer.
