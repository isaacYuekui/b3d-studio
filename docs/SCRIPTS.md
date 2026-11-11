# Scene scripts

The "describe it, Claude builds it" workflow. Claude writes a script in chat; you paste it into **File > Run Scene Script** (or the script button on the tool shelf). The whole script is validated first and runs as **one undo step**; if any command is invalid, nothing changes and the error names the command.

```json
{
  "format": "b3d-studio-script",
  "version": 1,
  "title": "Robot in the studio",
  "commands": [
    { "type": "add", "primitive": "empty", "id": "robot", "name": "Robot" },
    { "type": "add", "primitive": "capsule", "parentId": "robot",
      "transform": { "position": [0, 0, 1.6], "scale": [1.3, 1, 0.75] },
      "material": { "baseColor": "#e8662a", "metallic": 0.6, "roughness": 0.35 } },
    { "type": "add", "primitive": "light", "light": { "type": "sun", "power": 3 },
      "transform": { "position": [4, -5, 8], "rotation": [45, 0, 35] } }
  ]
}
```

Conventions: metres, **Z up**, rotations in degrees (Blender's).

| Command | Fields |
|---|---|
| `add` | `primitive`: cube, sphere, cylinder, cone, torus, capsule, plane, mesh, light, empty · `id` (optional, for later references) · `name` · `parentId` · `transform` {position, rotation, scale} · `material` · `params` {segments, radiusTop, radiusBottom, majorRadius, minorRadius} · `mesh` {vertices, faces, smooth} · `light` {type, color, power, spotAngle, shadows} |
| `transform` | `id`, `position` / `rotation` / `scale` |
| `setMaterial` | `id`, `material` {baseColor, metallic, roughness, emission, emissionStrength, alpha} |
| `setLight` | `id`, `light` {…} |
| `setWorld` | `world` {hdri, strength, rotation, background: color/hdri/blurred, color, exposure, bloom, ao} |
| `setCamera` | `position`, `target` (Blender coordinates). The scene opens at this shot after a script runs; key 0 returns to it |
| `setMesh` | `id`, `mesh` {vertices, faces, smooth}. A primitive becomes an editable mesh |
| `convertToMesh` | `id`: turn a primitive into its polygon mesh |
| `setModifiers` | `id`, `modifiers` {`mirror`: {x, y, z, clip, merge} or null, `subdivision`: {levels 0..4} or null} |
| `applyModifiers` | `id`: bake the modifiers into the mesh |
| `setAnimation` | `fps`, `start`, `end` (frames; end > start) |
| `setKeyframe` | `id`, `frame`, `transform` {position, rotation°, scale} (omit to key the current pose), `easing`: linear / ease / easeIn / easeOut / constant (applies from this key to the next) |
| `deleteKeyframe` | `id`, `frame` |
| `setCameraKey` | `frame`, `position`, `target`, `easing` |
| `deleteCameraKey` | `frame` |
| `clearAnimation` | `id` (or `null` for everything) |

Keys hold the full transform in the object's parent space. Rotation interpolates per channel in degrees, so `[0, 3600, 0]` is ten turns. To roll a wheel, key a spin empty from 0 to `distance / radius × 57.3` degrees with linear easing (see `examples/generators/forest_supercar.py`).
| `setParent`, `rename`, `setVisible`, `delete`, `duplicate` | as named |

## Realistic scenes (v0.3)

Use the CC0 library (ids and real-world sizes in [LIBRARY.md](LIBRARY.md)):

```json
{ "type": "setWorld", "world": { "hdri": "brown_photostudio_02", "background": "blurred", "ao": true } },
{ "type": "add", "primitive": "model", "asset": "WoodenTable_01" },
{ "type": "add", "primitive": "model", "asset": "ceramic_vase_01", "transform": { "position": [-0.45, 0.08, 0.549] } },
{ "type": "add", "primitive": "mesh", "mesh": { "vertices": [[-3,-2.5,0],[3,-2.5,0],[3,2.5,0],[-3,2.5,0]], "faces": [[0,1,2,3]], "smooth": true },
  "material": { "texture": "brown_planks_05", "textureScale": 1, "baseColor": "#ffffff" } }
```

- Models sit with their origin at the base; when LIBRARY.md lists a negative `bottom`, lift the model by that amount.
- `texture` + `textureScale`: on custom meshes the texture repeats `textureScale` times per metre; on primitives, per face. Use `baseColor: "#ffffff"` for the photo's true colours.
- With a texture, metallic and roughness come from the texture's maps.
- HDRI, background, bloom and ambient occlusion show in **Rendered** shading.

Custom meshes: `vertices` are `[x, y, z]` in metres; `faces` list vertex indices counter-clockwise seen from outside (Blender's convention), 3–64 per face. Limits: 200k vertices, 200k faces, 5,000 commands per script.

Lights: point/spot `power` in watts (1000 W is a good start at 4–5 m), sun `power` is strength (2–5). Lights only show in **Rendered** shading (Z). Sun and spot lights cast shadows; point lights don't yet.

Examples: [`robot-studio`](../examples/robot-studio.b3d-script.json) (stylized), [`still-life`](../examples/still-life.b3d-script.json) (realistic).

## Modelling with `editMesh` (v0.8)

`editMesh` models the way a person does in Edit Mode: each step selects part of the mesh
with a query, then runs an operator. A primitive becomes an editable mesh first (Blender
topology: 8-vertex cube, 32-sided cylinder, 32 × 16 UV sphere, 48 × 12 torus). Coordinates
are the object's local metres, Z up. Steps run in order; if one fails, the whole script is
rejected and the error names the step.

```json
{ "type": "editMesh", "id": "mug", "steps": [
  { "op": "scale", "select": { "all": true }, "by": [0.042, 0.042, 0.05], "about": [0, 0, 0] },
  { "op": "inset", "select": { "normal": [0, 0, 1], "angle": 5 }, "thickness": 0.0045 },
  { "op": "extrude", "select": { "last": true }, "offset": -0.088 },
  { "op": "bevel", "select": { "mode": "edge", "box": { "min": [-1, -1, 0.0995], "max": [1, 1, 0.1005] } }, "width": 0.0012, "segments": 2 },
  { "op": "smooth" }
] }
```

**Select queries** (fields combine with AND; `mode` is vert / edge / face, defaulting to what the op needs):

| Field | Picks |
|---|---|
| `all: true` | everything |
| `last: true` | what the previous step produced (extrude → extrude again) |
| `normal: [x,y,z]`, `angle` (°, default 30) | faces facing that way (edges / verts of those faces in other modes) |
| `box: {min, max}` | elements whose vertices are all inside |
| `sharp: degrees` | edges where faces meet at more than that angle |
| `nearest: [x,y,z]` | the one face / edge / vertex closest to a point |
| `loop: true` | extend selected edges to their edge loops |
| `linked: true` | grow to whole connected pieces |
| `indices: [...]` | raw face / vertex numbers or edge keys `"a_b"` |

**Ops**: `extrude {offset}` · `inset {thickness, depth, individual}` · `bevel {width, segments}` ·
`loopcut {cuts, factor}` (through the first selected edge) · `subdivide` · `delete` · `merge` ·
`mergeDistance {distance}` · `fill` · `flip` · `recalc` · `duplicate` · `move {by | along: "normal", distance}` ·
`scale {by: number | [x,y,z], about}` · `rotate {by: [x°,y°,z°], about}` · `smooth {smooth}` · `select`.
`move`, `scale` and `rotate` take `radius` for proportional editing (nearby vertices follow with a smooth falloff).

Add `setModifiers` with `subdivision: {levels: 2}` after modelling for smooth, rounded results;
bevels and loop cuts near edges keep them crisp. `examples/generators/coffee_mug.py` is a full example.
Check models with `node scripts/render-check.mjs <script.json> <sheet.png> --focus id1,id2`.

## Characters (v0.9)

`add` with `"primitive": "armature"` and `"armature": {"bones": [...]}`, then `setSkin`,
`setPose`, `setPoseKey`, `deletePoseKey`, `clearPoseKeys`, `setArmature`. Bone axes and a full
cheat sheet: [CHARACTERS.md](CHARACTERS.md). Example: `examples/generators/character.py`
(box-modelled body + 19-bone rig + walk cycle).

## Realistic people (v1.0)

`addHuman {id, preset: "male"|"female", name?, transform?, outfit?}` and
`playAction {id, action, start, cycles?, speed?, travel?}`. Details and an example:
[CHARACTERS.md](CHARACTERS.md#realistic-people-v10).

## Environments (v1.1)

```json
{"type":"addTerrain","id":"land","size":[160,160],"resolution":160,"height":16,"seed":11,"rim":14,
 "flats":[{"center":[0,0],"radius":20,"height":3}],
 "paths":[{"points":[[-80,-30],[0,0],[80,44]],"width":3.4}]}
{"type":"addPlant","id":"pine","kind":"pine","seed":2}
{"type":"scatter","id":"pines","source":"pine","on":"land","count":260,"seed":5,"scale":[0.7,1.3],
 "spacing":3,"maxSlope":32,"avoidPaths":true,"clump":0.6,"avoid":[{"center":[0,0],"radius":30}]}
{"type":"addBuilding","id":"h1","width":8,"depth":6,"floors":2,"roof":"gable","seed":1,
 "style":{"walls":"brick","roofColor":"#7b4a35"},"transform":{"position":[-10,-12,3],"rotation":[0,0,12]}}
```

- `addTerrain` — `size` [x, y] m, `resolution` (grid cells on the long side, 4–256), `height` m,
  `seed`, optional `scale`, `roughness`, `ridges`, `rim` (raised edges), `flats` (level discs;
  `height` sets the level, so buildings can stand at a known z), `paths` (levelled, painted),
  `layers` (three library textures: grass, path, rock), `scales`, `position`, `tint`.
- `addPlant` — `kind`: `pine`, `tree`, `bush`, `rock`, `grass`; `seed`, optional `height`,
  `transform`, `colors`. Creates an empty with `-wood` / `-leaves` meshes.
- `scatter` — copies of a library model (`asset`) or of a scene object (`source`, e.g. an
  `addPlant`; hidden by default, `"hideSource": false` keeps it) on terrain `on`: `count`,
  `seed`, `scale` [min, max], `spacing`, `maxSlope`°, `avoidPaths`, `avoid` discs, `area`,
  `sink`, `clump` (0–1).
- `addBuilding` — `width`, `depth`, `floors`, `roof` (`gable` | `hip` | `flat`), `floorHeight`,
  `roofPitch`, `chimney`, `seed`, `style` {`walls`: plaster | brick | wood, `wallColor`,
  `roofColor`, `trimColor`, `doorColor`}, `transform`. Stands on its z, front faces −Y.

Everything here exports to Roblox: see [ROBLOX.md](ROBLOX.md).

## Time of day, haze and water (v1.2)

```json
{"type":"setTimeOfDay","time":"sunset","heading":240}
{"type":"addWater","id":"lake","size":[44,40],"level":0.3,"position":[-6,-40]}
{"type":"setWorld","world":{"fog":300,"fogColor":"#c9ccd2"}}
```

- `setTimeOfDay` — `time`: `sunrise`, `morning`, `noon`, `afternoon`, `sunset`, `dusk`, `night`,
  `overcast`, `misty`. Sets the sky (a matched Poly Haven set), exposure, bloom and haze, and adds
  or updates one sun light aimed where that sky's sun is (hidden for dusk / overcast / misty).
  `heading` (degrees, 0 = +X, 90 = +Y) turns the whole sky so the sun shines from there; later
  times keep the same heading. Optional `fog` overrides the haze distance.
- `world.fog` — haze: the distance in metres at which things are half hidden (0 = off);
  `world.fogColor`. Rendered view only.
- `addWater` — `size` [x, y] m, `level` (water height z), optional `position` [x, y], `color`,
  `clarity` (0–1), `waves` (ripple size in m), `speed` (m/s). For a lake, lower the ground under it
  with an `addTerrain` flat (`"height": -1.5`) and keep scatter out with an `avoid` disc.

## Camera moves (v1.3)

```json
{"type":"cameraMove","move":"orbit","target":[0,-12,4],"start":1,"end":240,"distance":30,"height":12,"heading":290,"degrees":140}
{"type":"cameraMove","move":"flyover","on":"h1","start":241,"end":360,"distance":40}
```

- `move`: `orbit` (circle the target by `degrees`), `dollyIn` / `dollyOut` (push in / pull back
  along `heading`), `flyover` (straight pass over the target from the `heading` side), `crane`
  (rise from near the ground), `pan` (camera still, view sweeps `degrees`).
- `target` [x, y, z] or `on` (an object id); `start` / `end` frames (default: the timeline);
  `distance` (horizontal, m), `height` (above the target, m), `heading` (degrees; 0 = +X,
  270 = front / −Y), `degrees`, `smooth` (ease in and out, default true).
- It replaces camera keys between `start` and `end`, keeps the others, extends the timeline if
  needed, sets the scene camera to the first frame, and stays at least 2 m above any terrain.
- Clearance (v1.4): the path rises smoothly over trees, rocks, houses and every scatter copy it
  would otherwise pass through or graze (1.5 m above them). The object being filmed is not
  counted, so close orbits stay close. `"clearance": false` turns it off.

### Following a person (v1.7)

```json
{"type":"walkPath","id":"ana","points":[[-26,-9],[-12,-3.5],[0,0],[10,4.5]],"start":1}
{"type":"cameraMove","move":"follow","on":"ana","start":1,"end":560}
```

- `follow`: behind and slightly to the right of the subject, looking 2 m ahead of them at chest
  height. `track`: beside them (`"degrees": -90` puts the camera on the left).
- `distance` (default 4 m for follow, 5 m for track) and `height` (default 1.6 m).
- The camera eases towards where it should be each frame, so turns feel natural. `on` is
  required. Obstacle clearance doesn't apply, because these are ground-level shots.

## Hard-surface modelling (v2.0)

```json
{"type":"setModifiers","id":"plate","modifiers":{"bevel":{"width":0.03,"segments":2,"angle":30},"subdivision":{"levels":2,"sharpAngle":30}}}
{"type":"boolean","id":"plate","cutter":"slot","op":"difference"}
```

- **Bevel modifier** — `width` (m), `segments` (1–6), `angle` (°; only edges sharper than this are
  bevelled, like Blender's *Limit Method: Angle*). Order in the stack: Mirror → Bevel → Subdivision.
- **Subdivision `sharpAngle`** — edges sharper than this stay crisp (creased) while the rest rounds
  off: curved armour, car panels, product shapes. Without it, subdivision rounds everything.
- **`boolean`** — `op`: `difference` (cut), `union` (join), `intersect` (keep the overlap). Works on
  closed solids (shapes, meshes). The result is applied to `id` (its modifiers are baked first);
  the cutter is hidden unless `"keepCutter": true`. Use it for panel lines, vents, windows, holes.
  In the app: select an object → Shape → Boolean → pick the other object → Apply boolean.
