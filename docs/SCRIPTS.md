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
