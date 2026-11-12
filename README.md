# B3D Studio

A browser-based 3D creation app with a professional desktop-style workflow, built with React, TypeScript and Babylon.js.
Runs on desktop browsers and on iPad / iPhone / Android (touch-first controls).

> Independent project. Inspired by professional desktop 3D tools; not affiliated with or endorsed by the Blender Foundation.

## Curves and Follow Path (v3.20)

- **Add → Curve**: Bezier, Circle and Path. A curve is a smooth line through its points (auto handles), drawn as a round tube; set **Bevel depth**, **Resolution**, **Sides** and **Cyclic** on the Data tab, or **Convert to Mesh**
- **Edit Mode** on a curve: move points, **E** adds a point at the selected end, Subdivide puts points between selected ones, X deletes points
- **Object → Follow Path**: anything moves along a curve between two frames, turning to face the way it goes (a car on a road, a bird around a loop)
- **Scene → Camera → Follow path**: a fly-through camera that looks along the path or at a target
- Scripts: `setFollow`, `setCameraFollow`, `editCurve`; a curve is a mesh with points and no faces plus `modifiers.curve`

## Shader Editor (v3.19)

- **Node materials** like Blender's Shader Editor (Timeline → **⬡ Shader**, then **Use Nodes**): a **Principled BSDF** fed by **Pattern Texture** (noise, voronoi, checker, bricks, wood, marble, gradient, windows), **Image Texture** (your pictures or library textures), **RGB**, **Value**, **Mix Color** (mix, multiply, add, subtract, screen, overlay, darken, lighten), **Color Ramp**, **Math**, **Invert Color** and **Bump** (→ Normal)
- Drag from an output dot to an input dot to connect; drag a connected input away to disconnect; drag titles to move nodes; X / Delete removes the selected node; pinch or scroll to zoom, drag the background to pan
- Works per material slot; the graph is baked into the material's colour, roughness/metal, emission and normal maps, so node materials render, export and record videos like any other
- Scripts: `material.nodes` = `{nodes: [{id, type, x, y, props}], links: [{from, out, to, in}]}`

## Image textures and UV unwrap (v3.18)

- **Your own pictures as textures**: Material → Texture → **Upload an image…** (photos are shrunk to 2048 px and kept on the device; *Your images* lists them; project files carry them along)
- **Smart UV Project** (U in Edit Mode, Mesh / Object → UV): each side becomes a flat island at true size, packed into the square — the picture then follows the model instead of being projected in metres
- **UV Editor** (Timeline → **▦ UV**): the UV map over your image; in Edit Mode tap faces to select them, drag an island to move it, and Scale / Rotate 90° / **Fit to image** with the buttons — the model updates live
- UV maps survive moving vertices and Subdivision; tools that rebuild faces (extrude, bevel…) drop it, like a stretched map in Blender you re-unwrap; **Clear UV Map** goes back to box projection
- Scripts: `unwrap`, `clearUv`, and `mesh.uv` (per face, one [u, v] per corner)

## Collections (v3.17)

- **Outliner collections** like Blender: **+** on the Scene Collection row makes one; tap a collection to make it active — new objects go into it
- **M** (or Object → Move to Collection) moves the selected object, with its children, to a collection or a new one
- Each collection has an **eye** (hide in the viewport — also switches off its physics, force fields and particles) and a **camera** (leave out of rendered videos but keep in the viewport)
- Long-press / right-click a collection: Select objects, Rename (or double-click), Delete keeping the objects, Delete with objects
- Scripts: `addCollection`, `setCollection`, `removeCollection`, `moveToCollection`, and `collection` on `add`

## Sound effects (v3.16)

- **Render video** now adds a **soundtrack made from the scene**, like a Foley artist watching the cut: explosion fields boom (with debris landing after), camera shakes rumble, a giant wave roars louder as it reaches the camera, fire crackles, a flying meteor whooshes, rain hisses, stormy seas wash, and baked physics pieces crash where they land
- The dialog lists what it will hear; **Save sound (.wav)** gives the soundtrack on its own for editing apps (and for browsers that can't put sound in the MP4 — Safari needs iOS / iPadOS / macOS 26 or newer for that)
- Synthesised on the device (no sound files, no servers), the same every time for the same scene
- Physics fix: broken pieces settling in a pile no longer get flung into the air now and then (contact kicks are capped; force fields still blast at full strength)
- New example: **Volcano eruption** — a night eruption above a village with lit windows: lava channels glowing on the cone (one mesh, rock + lava material slots), a tremor, a blast with a light flash, a fire fountain, lava bombs and an ash column — and its own rumble, boom and fire sounds when rendered

## Material slots (v3.15)

- **Several materials on one mesh**, like Blender: Material tab → **Slots** (Main, Slot 2, Slot 3… up to 9); **+** adds a slot, each slot is a full material (colour, texture, pattern, glow…)
- In **Edit Mode**, select faces and press **Assign** (or **Select** to pick a slot's faces); faces keep their materials through extrude, inset, bevel, subdivide, modifiers and booleans
- **Join** keeps each object's material as a slot; **Separate** keeps them on both parts
- **Cell Fracture / Quick Explode**: the broken surfaces inside get their own rough material, so a smashed building shows broken wall inside instead of windows

## Wave spray (v3.14)

- **Water → Giant wave → Add spray on the crest**: white spray and mist thrown up and forward off the top of the tsunami as it runs in (Physics → Particles → *Wave spray*, or "Emit from: Giant wave crest" on any water with a giant wave)
- *Tsunami harbour* now has spray on the wave

## Night lights (v3.13)

- **Glow** on procedural patterns (Material → Pattern): colour A areas give off light — on the **Windows** pattern, about half the windows light up (warm lamps, some cooler, some blinds half down), each building a different mix
- **Add → Town** at dusk or night lights the windows by itself (`lights` in scripts)
- **Force Field → Light flash**: an explosion lights up everything around it, then flickers out over about two seconds (on by default for the Explosion preset and Quick Explode)
- *Meteor strike* now has lit windows, a glowing meteor and a blast flash

## Town generator (v3.12)

- **Add → Town**: **Village** (houses with tiled hip roofs), **Town** (blocks with flat roofs) or **City** (towers) on a street grid, with an asphalt ground — each building a real-size mesh with a new **Windows** facade pattern (also in Material → Pattern), so it reads as a building from a distance
- Every building is its own object: Quick Explode, Cell Fracture, physics and force fields work on them (roofs come down too). The *Meteor strike* and *Tsunami harbour* examples now use generated towns

## Quick Effects (v3.11)

- **Object → Quick Effects** (also in the long-press menu), like Blender's: **Quick Explode** (breaks the object into pieces, blasts them apart at the current frame with a fireball and camera shake, adds a floor if needed, bakes — one undo removes it all), **Quick Fire**, **Quick Smoke**, **Quick Float** (adds a sea if there's none)

## Animated rigid bodies (v3.10)

- Physics → Rigid body → Passive → **Animated (follows its keys)**: a keyframed object (wrecking ball, bulldozer, meteor) that smashes into active objects during the bake, like Blender's Animated option

## Force fields (v3.9)

- **Add → Force Field**: Explosion, Push, Wind, Tornado — an empty with Blender-style force field settings in its Physics tab: **Force** (away from the centre, or pulling with negative strength), **Wind** (along the empty's Z axis), **Vortex** (swirl), strength, reach and an optional frame window
- Fields push rigid bodies when you **Bake physics** — an Explosion for 2 frames throws fractured pieces outwards
- New example: *Meteor strike* — a burning meteor, fireball, dust cloud, a town blown apart and camera shake

## Tsunami / giant wave (v3.8)

- Water tab → **Giant wave (tsunami)**: one wall of water (height, speed, length, start frame) runs across the sea in the wave direction, lifting and carrying everything that floats. Run the water on under the land and the wave floods over the shore
- New example: *Tsunami harbour* — boats lifted and swept to the quay while the camera shakes
- Water is a surface, not a fluid simulation: no splashing or breaking, and floating objects pass through buildings

## Camera shake and floating (v3.7)

- **Scene → Camera shake**: Impact, Explosion, Earthquake or Rumble at the current frame — a sharp jolt that dies away, seen through the scene camera and in videos (like a Noise modifier on the camera in Blender's Graph Editor)
- **Physics → Float on water**: boats, buoys and debris bob and tilt with the ocean waves under them; children (a cabin, a mast) follow. The *Storm at the lighthouse* example now has a boat

## Ocean waves and explosions (v3.6)

- **Add → Water / Ocean**: a 40 m sea with real waves. Water tab: **Calm / Choppy / Rough / Storm**, wave height, wave size, direction — the surface itself moves frame by frame, like Blender's Ocean modifier (simplified: no foam or spray)
- New example: *Storm at the lighthouse* — rough sea, rain blown sideways, a sweeping lamp
- Particle presets **Explosion** (a fire burst) and **Dust cloud** start at the current frame — combine with Cell Fracture and physics for blasts

## Fire and smoke (v3.5)

- Particle shapes **Fire** (glowing puffs that start white-hot, turn orange then dark red and fade) and **Smoke** (soft grey puffs that grow and thin out), with presets in Physics → Particles. They always face the camera
- **Wind** (X / Y, m/s²) pushes particles sideways — smoke drifting, slanted rain. Negative gravity makes particles rise
- New example: *Campfire*. It's a sprite effect, not a fluid simulation like Blender's Mantaflow — it reads well in shorts but won't swirl around objects

## Particles (v3.4)

- Physics tab → **Particles** (Blender's Particles, Emitter type): an object emits up to 20,000 small spheres, cubes, drops or flakes from its surface over a frame range — speed along the surface, random speed, gravity, lifetime, size, colour, glow, land-on-the-ground, hide the emitter in renders
- One-tap presets: **Sparks, Fountain, Rain, Snow, Debris**. A moving emitter leaves a trail
- Worked out exactly for every frame — no baking; scrubbing, playing and video all match. New example: *Particle night*
- Not yet: collisions with objects (only the ground at height 0), instancing your own objects, smoke and fire

## Cell Fracture (v3.3)

- Physics tab → **Fracture → Break into pieces** (8 / 16 / 32 / 64): the object is split into random Voronoi chunks, each an active rigid body with a **convex hull** shape — Blender's Cell Fracture add-on plus rigid bodies in one step. Add something to hit it and **Bake physics**
- New collision shape **Convex hull** (Blender's default) for any rigid body; convex collisions are now about 20× faster
- New example: *Wall breach* — a fractured brick wall smashed by a wrecking ball

## Wireframe shading (v3.2)

- **Wireframe** (first shading button, ⇧ Z): every polygon edge of shapes and meshes, see-through, selected object in orange — like Blender's wireframe mode. Library models show their triangles
- A small **What's new** card lists new features once after an update

## Properties tabs (v3.1)

- Properties is split into tabs like Blender's Properties editor: **Scene** (camera lens, physics, world), **Object** (transform, animation, parent), **Modifiers**, **Physics**, **Text / Light / Model / Armature** (the object's own data) and **Material**. Only the tabs an object has are shown; the last one you used stays open as you select other objects

## Rigid body physics (v3.0)

- Properties → **Physics → Rigid body** (like Blender's Physics tab): **Active** objects fall and collide, **Passive** ones (floors, walls, ramps) stay put. Shape (auto / box / sphere / cylinder), mass, friction, bounciness
- **Bake physics** (Physics panel or Animation menu) simulates the animation range and saves it as keyframes, so it plays, scrubs, shows in the Graph Editor and renders to video. **Free bake** removes them
- New example: *Physics playground* — a wrecking ball, a plank tower, crates on a ramp and bouncy balls
- Simplified shapes (boxes, spheres, cylinders — not exact mesh collisions); parented objects aren't simulated. Engine: cannon-es (MIT), loaded only when you bake

## 3D text (v2.9)

- **Add → Text**: standing 3D letters (Blender's Text object). In Properties → Text: type the words (several lines are fine), pick a font — Sans (Inter Bold), Serif (Playfair Display Bold) or Display (Bebas Neue) — size, thickness and alignment
- Works with materials, modifiers (Bevel rounds the letter edges) and animation, so it's ready for video titles
- Edit Mode or Sculpt turns it into a plain mesh, like Blender's Convert to Mesh. Fonts cover Latin letters, digits and punctuation for now
- Fonts are bundled with the app under the SIL Open Font License

## Graph Editor (v2.8)

- **〰 Graph** (Timeline): the selected object's animation as curves — Location, Rotation, Scale X/Y/Z in red/green/blue, like Blender's F-curves. With nothing selected it shows the camera's (position and target)
- Drag a key ● **up/down** to change that channel's value, **sideways** to retime the key; or tap it and type the value. **Interpolation** per key: Constant, Linear, Bézier (ease in & out), Ease in, Ease out
- **Normalize** fits metres, degrees and scale on one graph; tap channel names to show or hide curves (only the ones that move show at first)
- Keys hold every channel together, so retiming moves the whole key (Blender can move one channel's key alone); no Bézier handles yet

## Camera lens (v2.7)

- **Camera** panel (Properties with nothing selected): focal length — 18, 24, 35, 50 (normal), 85, 135 mm or any value — like Blender's camera, on a 36 mm sensor
- **Depth of field**: f-stop (f/1.4 … f/11) and focus — on the camera's target (follows camera moves) or a set distance. Shows in Camera view with Rendered shading, and in videos

## More Edit Mode tools (v2.6)

- **Dissolve** (Mesh menu, Ctrl/⌘ X): removes vertices, edges or faces without leaving a hole — faces merge into one
- **Connect Vertex Path** (J): cut a face between two selected vertices. **Bridge Edge Loops**: join two holes with a band of faces, or select two faces to punch a tunnel through
- **Deform**: Smooth Vertices, Shrink/Fatten (⌥ S), To Sphere (⇧ ⌥ S). **Faces**: Poke, Triangulate (Ctrl/⌘ T), Tris to Quads (⌥ J)
- Every tool has its settings in the Adjust Last Operation panel, and works in scripts (`editMesh`)

## More modifiers (v2.5)

- Shape panel: **Array** (×2 to ×10, direction, gap, count), **Solidify** (thickness for flat surfaces), **Displace** (noise bumps; Low / Medium / High, bump size, New pattern)
- Stack order: Mirror → Array → Solidify → Bevel → Subdivision → Displace. **Apply modifiers** bakes them in

## Sculpt Mode (v2.4)

- Select a model → **Sculpt** (top bar). Brushes: **Draw** (build up; **Invert** digs in), **Smooth**, **Inflate**, **Grab**, **Flatten**, with Size, Strength and **X symmetry**
- Drag on the model to sculpt; drag off it (or use two fingers) to turn the view, like Nomad Sculpt. Each stroke is one undo step
- **Add detail** subdivides the model for finer sculpting (up to about 240,000 faces, to stay smooth on a tablet)
- Not yet: dynamic topology, masks, multires. Skinned characters can't be sculpted

## Materials (v2.3)

- **More: clearcoat, glass, sheen, skin…** in the Material panel, matching Blender's Principled BSDF: Clearcoat (car paint), Transmission + IOR (glass, water), Sheen (velvet, cloth), Subsurface (skin, wax, leaves), Anisotropy (brushed metal)
- One-tap presets: Car paint, Glass, Brushed metal, Velvet, Skin, Plain
- **Pattern** (procedural textures, like Blender's texture nodes): Noise, Voronoi, Checker, Bricks, Wood, Marble, Gradient, with two colours, scale and bump. They tile seamlessly and need no downloads
- New example: *Materials showcase*

## Edit tools (v2.2)

- **Snapping** (magnet button, ⇧ Tab): moves in 0.25 m steps, rotations in 15°, scale in 0.1, in Object and Edit Mode
- **Proportional editing** (circle button in Edit Mode, O): nearby vertices follow the selection with a smooth falloff, up to the radius you set. Good for shaping terrain-like surfaces, cloth folds and organic bumps
- **Separate** (Mesh menu, P): selected faces become their own object. **Object → Separate by Loose Parts** splits every disconnected piece
- **Join** (Shape panel): pulls another object into this one, keeping each shape as it is, like Blender's Ctrl J

## Dope Sheet (v2.1)

- Timeline → **◆◆ Dope Sheet**: every keyframe in the scene, one row each for Summary, Camera, every animated object and every armature's pose
- Tap a ◆ to select it (turn on **＋ Add** to pick several, or **All**), then drag it sideways to retime. Moved keys replace keys already on their new frame, like Blender. A Summary ◆ moves everything keyed on that frame
- Buttons: Easing (linear, ease in and out, hold…), **Copy to playhead**, ±1 frame, **Slower ×2** / **Faster ×½**, **Delete**. Each edit is one undo step

## Hard-surface modelling (v2.0)

- **Bevel modifier**: rounds every edge sharper than 30° so parts catch the light (1, 3 or 8 cm, 1–3 segments)
- **Subdivision → Keep sharp edges**: curved but crisp shapes (armour, cars) instead of blobs
- **Boolean** (Cut / Union / Intersect) with any other solid, for panel lines, vents, windows and holes. Uses manifold-3d (Apache-2.0), loaded only when you first use it

## Scout mech example (v1.9)

- Script → **Scout mech (modelled)**: an original 4 m hard-surface mech ("Kestrel") built from about 110 bevelled armour parts on a jointed hierarchy (hips, knees, ankles, shoulders, elbows, wrists, waist, neck, head), so you can pose it by rotating the joint empties. Studio lights and a 10-second turntable orbit. Generator: `examples/generators/scout_mech.py`

## Village walk example (v1.8)

- Script → **Village walk (video)**: two villagers walk the paths at late afternoon, a follow camera trails one of them, then a crane shot rises over the village (25 s at 24 fps). Tap it, then File → Export Video

## Follow camera (v1.7)

- `cameraMove` with `"move":"follow"` (third-person, behind the person) or `"track"` (side shot alongside them), `"on": "<person id>"`. The camera lags a touch like a real operator. Pair it with `walkPath` for walk-through videos

## People walk paths (v1.6)

- `walkPath`: a person walks (or runs) along a list of points, turning smoothly at corners, with feet following the terrain up and down hills. The timeline grows to fit the walk

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
