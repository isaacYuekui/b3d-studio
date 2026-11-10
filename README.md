# B3D Studio

A browser-based 3D creation app with a professional desktop-style workflow, built with React, TypeScript and Babylon.js.
Runs on desktop browsers and on iPad / iPhone / Android (touch-first controls).

> Independent project. Inspired by professional desktop 3D tools; not affiliated with or endorsed by the Blender Foundation.

## Quality setting (v1.5)

- World panel → **Quality (this device)**: Fast, Balanced (default) or Best. Fast draws at 1× pixels with hard shadows and no ambient occlusion or bloom, about 4× cheaper than Best on the village scene. Best uses up to 2× pixels and 2048 px soft shadows. Saved per device, not in the scene
- Video export always renders at Best

## Camera moves (v1.3)

- **Animation → Camera Move**: Orbit, Dolly In, Flyover, Crane Up. Starts from your current view, circles the selected object (or the point you're looking at) across the whole timeline, eased in and out. Then press play or File → Export Video
- Camera moves fly over trees and houses in their way instead of through them (v1.4)
- `cameraMove` in scripts: `orbit`, `dollyIn`, `dollyOut`, `flyover`, `crane`, `pan`, with distance, height, heading and degrees. Over terrain the camera never dips into a hill

## Time of day and water (v1.2)

- `setTimeOfDay`: sunrise, morning, noon, late afternoon, sunset, dusk, night, overcast, misty. Each sets a matching sky, a sun (or moon) light aimed where that sky's sun is, exposure and distance haze. `heading` turns the sun to any compass direction. Also in the World panel as **Time of day**
- World **Haze**: distance fog that fades far hills and trees into the sky colour
- `addWater`: lakes, rivers and sea with moving ripples and sky reflections
- Roblox export: water becomes real Roblox terrain water (Sea Level numbers in the README), and the README gives Lighting/Atmosphere values matching the time of day
- Fixed: the visible sky didn't turn with World → Rotation (only the lighting did)

## Environments and Roblox export (v1.1)

- `addTerrain`: hills with levelled clearings and paths, blending grass, path and rock textures
- `addPlant` (pine, broadleaf tree, bush, rock, grass tuft) and `scatter` thousands of copies on a terrain, avoiding paths, steep slopes and clearings
- `addBuilding`: houses with gable, hip or flat roofs, windows, doors, chimneys; plaster, brick or wood walls
- **File → Export for Roblox (.zip)**: models in studs, ≤ 20,000 triangles per mesh, scatter copies as real parts, texture tiling baked into UVs; each terrain as a Roblox Terrain heightmap + colormap; a README with the exact Studio settings. See [docs/ROBLOX.md](docs/ROBLOX.md)
- Export GLB now faces the same way in Blender as in B3D (it was turned half a turn)
- New example: *Village valley (Roblox-ready)*

## Realistic people (v1.0)

- `addHuman`: realistic men and women from the MakeHuman CC0 base mesh, morphed to young adults, with its 163-bone skeleton and artist weights, clothes (shirt, trousers, shoes), hair and eyes; colours per outfit
- `playAction`: idle, walk, run, wave, jump, sit, stand; feet stay on the floor; actions chain
- New example: a living room where one person walks in and waves while the other sits down
- MakeHuman assets are CC0 1.0 ([makehumancommunity/makehuman](https://github.com/makehumancommunity/makehuman)); presets are built at build time by `scripts/build-humans.mjs`

## Characters (v0.9)

- Armatures with Blender-style bones, automatic skin weights, Pose Mode (tap a bone, turn it with the gizmo, type rotations), bone keyframes with auto-key
- New example: an original mannequin, box-modelled with `editMesh`, rigged with 19 bones, walking (3 loops) with a tracking camera
- [docs/CHARACTERS.md](docs/CHARACTERS.md): data model and a bone-axis cheat sheet

## Scripted modelling (v0.8)

- Scene scripts can model with Edit Mode operators: `editMesh` selects parts of a mesh by direction, box, sharp edges, nearest point or edge loop, then extrudes, insets, bevels, loop-cuts, moves (with proportional falloff)… ([docs/SCRIPTS.md](docs/SCRIPTS.md))
- New example: a real-size coffee mug and saucer, hollowed, bevelled and subdivided
- `scripts/render-check.mjs` renders any script from the scene camera and four views into one sheet, for checking models
- Close-ups of small, real-size objects no longer clip or stay zoomed out

## Modelling: Edit Mode (v0.7)

- `Tab` (or the Edit Mode button / Modeling tab) edits the selected shape as a polygon mesh with Blender's topology (8-vertex cube, 32 × 16 UV sphere…)
- Vertex / edge / face select (`1` `2` `3`), tap or click to select, Shift or the ⊞ button to add, `⌥`-click for edge loops, `B` box select, `A` all, `⌥A` none, `Ctrl/⌘ I` invert, `L` linked, `⌥Z` X-ray
- Move / rotate / scale the selection with the gizmo, or type its median point in Properties
- Extrude `E`, Inset `I`, Bevel `Ctrl/⌘ B` (with segments for rounded edges), Loop Cut `Ctrl/⌘ R`, Subdivide, Merge `M`, Merge by Distance, Fill `F`, Delete `X`, Duplicate `⇧D`, Recalculate / Flip Normals (`⇧N` / `⌥N`)
- Adjust Last Operation panel: change the extrude distance, bevel width and segments, number of cuts… after the fact (still one undo step)
- Modifiers: Subdivision Surface (`Ctrl/⌘ 1…3`) and Mirror X/Y/Z with clipping, non-destructive, with Apply
- Shade Smooth / Flat; undo restores your selection too

## Animation, video and FilmCraft (v0.6)

- Keyframes: select an object, press `I` (or ◆ Key on the timeline); move to another frame, change it, press `I` again. Once an object is animated, edits at a new frame add a key automatically. `⌥I` deletes a key, `↑ ↓` jump between keys
- Easing per key (linear, ease, ease in, ease out, constant); rotations interpolate per channel like Blender, so a wheel keyed 0° → 3600° spins ten times
- Camera keyframes (◆ Camera) and Camera view playback; scene scripts can key objects and the camera too ([docs/SCRIPTS.md](docs/SCRIPTS.md))
- File > Render Video: MP4 in 16:9, 9:16 or 1:1, rendered frame by frame in the browser (no server, no cost)
- The forest example now drives: the car follows the track, the wheels roll at the matching speed, a tracking camera follows
- [FilmCraft](https://github.com/isaacYuekui/filmcraft), the open-source video editor, is hosted unmodified at `/film/` to cut renders together with music and titles. It is MIT / Apache-2.0 (licences in `public/film/`); refresh it with `node scripts/vendor-film.mjs <filmcraft-repo>` after `cargo xtask web`

## Import your own models (v0.5)

**File > Import 3D Model** (⇧⌘I) takes a `.glb`, a `.gltf`, or a `.zip` of glTF + files (e.g. a Sketchfab download).
Models are stored on the device (IndexedDB), grounded and centred automatically, converted from centimetres or
millimetres when needed, listed under Library > My Models, and embedded in exported project files.
Set the real size in Properties > Model.

## Realism (v0.3)

- Built-in CC0 library from Poly Haven: 60 scanned models, 9 HDRI skies, 18 photo materials ([docs/LIBRARY.md](docs/LIBRARY.md)); browse it with the Library button (⇧L)
- HDRI image-based lighting, photo textures (colour, normal, AO/roughness/metal), ambient occlusion, bloom, exposure
- Assets are downloaded and compressed at build time (`npm run fetch-assets`), not stored in git

## Scene scripts (v0.2)

Describe a scene to Claude, paste the script it writes into **File > Run Scene Script**, and it builds. See [docs/SCRIPTS.md](docs/SCRIPTS.md).

- Primitives: cube, sphere, cylinder, cone, torus, capsule, plane; custom meshes; empties; point, sun and spot lights
- PBR materials (base colour, metallic, roughness, emission, alpha)
- Solid and Rendered shading (Z), with shadows from sun and spot lights
- GLB export that opens in real Blender (File > Import > glTF 2.0)

## V0.1 features

- Interactive 3D viewport: perspective camera, ground grid, coloured X/Y axes, default cube
- Add cube, sphere, cylinder, plane (Blender default sizes, metres, Z up)
- Select by click/tap, in the Outliner, or via context menu — always in sync
- Move / rotate / scale gizmos, plus exact values in the Properties editor (drag a field to scrub, tap to type, simple maths like `2*1.5`)
- Duplicate, delete, hide/reveal, rename, parenting (hierarchy shown in the Outliner)
- Undo / redo (200 steps; a whole field-scrub or gizmo drag is one step)
- Orbit / pan / zoom with mouse, trackpad or touch; preset views (front/right/top…) and frame selected/all
- Context menu (right-click or long-press), Blender-style keyboard shortcuts (press `?` in the app)
- Autosave in the browser, plus export / import of `.b3d.json` project files
- Collapsible, resizable panels on tablet/desktop; bottom-sheet panels on phones
- Timeline with playhead and playback

## Commands

```bash
npm install
npm run dev          # local dev server
npm run typecheck    # TypeScript
npm test             # unit tests (Vitest)
npm run build        # typecheck + production build -> dist/
node tests/e2e/smoke.mjs http://localhost:4173/ test-results   # browser tests (after `npx vite preview`)
```

## Deploying to Cloudflare Pages (free tier)

`wrangler.toml` is configured for a static Pages project serving `dist/`. Two ways:

1. **Git integration (recommended):** in the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git, pick this repo, build command `npm run build`, output directory `dist`. Every push to `main` deploys; every PR gets a preview URL.
2. **CLI:** `npx wrangler pages deploy dist --project-name b3d-studio` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

V0.1 has no server code and makes no paid API calls, so it fits Cloudflare's free tier at $0/month.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.
