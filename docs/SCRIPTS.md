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
| `setParent`, `rename`, `setVisible`, `delete`, `duplicate` | as named |

Custom meshes: `vertices` are `[x, y, z]` in metres; `faces` list vertex indices counter-clockwise seen from outside (Blender's convention), 3–64 per face. Limits: 200k vertices, 200k faces, 5,000 commands per script.

Lights: point/spot `power` in watts (1000 W is a good start at 4–5 m), sun `power` is strength (2–5). Lights only show in **Rendered** shading (Z). Sun and spot lights cast shadows; point lights don't yet.

Example: [`examples/robot-studio.b3d-script.json`](../examples/robot-studio.b3d-script.json).
