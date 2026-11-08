# Characters: armatures, skinning, Pose Mode

## Realistic people (v1.0)

```json
{ "type": "addHuman", "id": "leo", "preset": "male", "name": "Leo",
  "transform": { "position": [2, 0, 0], "rotation": [0, 0, -90] },
  "outfit": { "skin": "#8d5a3b", "shirt": "#d8d4cb", "pants": "#3a3f47", "shoes": "#2a1d14", "hair": "#1c1410", "eyes": "#4a3020" } }
{ "type": "playAction", "id": "leo", "action": "walk", "start": 1, "cycles": 2 }
{ "type": "playAction", "id": "leo", "action": "wave", "start": 70, "cycles": 3, "travel": false }
```

- Presets `male` / `female`: the MakeHuman base mesh (CC0) morphed with its young-adult targets,
  its 163-bone default skeleton with the artist-painted weights, garments (shirt, trousers, shoes)
  made from body regions so they bend exactly with the skin, a hair cap, and eyes on the eye
  bones. Set any garment or the hair to `null` to leave it off. Built by `scripts/build-humans.mjs`.
- Characters face −Y; `rotation[2]` turns them (−90 faces −X, 90 faces +X).
- `playAction` actions: `idle`, `walk` (1.45 m per cycle), `run` (3.3 m), `wave`, `jump`, `sit`
  (sits down from standing: put a seat behind them), `stand`. Options: `cycles`, `speed`,
  `travel: false` to stay in place. Feet are kept on the floor automatically. Actions key the
  whole body, so they chain: play one after another and the next starts where the last ended.
  Turn a character between actions with an ordinary `setKeyframe` on its rotation.
- The relaxed standing pose is applied on creation.


B3D Studio's rigging follows Blender's conventions so poses read the same way.

## Data

- An **armature** object (`"primitive": "armature"`) holds bones in its local space:
  `{ "name", "parent", "head": [x,y,z], "tail": [x,y,z], "roll"?, "deform"? }`.
  A bone's local **Y axis runs head → tail**; X and Z come from the smallest rotation that
  takes +Y onto the bone, then `roll` (degrees) twists around Y. `deform: false` marks
  control bones that don't move the mesh.
- A **skinned mesh** has `"skin": {"armature": id}` (`setSkin`). Weights are automatic:
  inverse distance to each deforming bone's segment in the rest pose, the nearest bones
  within 1.5× of the closest, top 4, normalised. Parent the mesh to the armature so it
  follows the armature's own movement.
- A **pose** is per bone: `rotation` (Euler XYZ degrees, X applied first, about the bone's
  rest axes as moved by its parent) and optional `location` (metres, bone axes).
- **Animation**: `setPoseKey {id, bone, frame, rotation, location?, easing?}`; keys live in
  `animation.poses[armatureId][bone]`. Root motion is an ordinary object keyframe on the armature.

## Axis cheat sheet (bones built like `examples/generators/character.py`)

| Bone | Rest direction | Rotation that… |
|---|---|---|
| thigh / shin (pointing down, −Z) | X = world X | **X −** swings the leg forward, **X +** bends the knee |
| foot (pointing forward, −Y) | X ≈ world X | **X +** lifts the toes |
| upper arm .L (+X) / .R (−X) | X = world −Y (.L) / +Y (.R) | **X −70…−80** lowers a T-pose arm to the side; then **Y** swings it (.L: − forward, .R: + forward) |
| forearm | as the upper arm | **Z** bends the elbow (.L: − forward, .R: + forward) |
| hips / spine / chest / neck / head (up, +Z) | X = world X, Z = world −Y | **X +** leans forward, **Y** twists, **Z** tilts sideways |

## Pose Mode (app)

Select the armature (or the character) and press **Tab** (or Ctrl/⌘ Tab, or Properties ›
Armature › Pose Mode). Tap a bone or pick it in the bone list, turn it with the gizmo or type
its rotation, press **I** to keyframe it. Animated bones auto-key when changed.

## Render check

`node scripts/render-check.mjs examples/character-walk.b3d-script.json sheet.png --focus body`
