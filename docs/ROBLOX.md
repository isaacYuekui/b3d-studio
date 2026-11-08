# Roblox export

**File → Export for Roblox (.zip)** exports the selected object (and its children), or the
whole scene when nothing is selected. Roblox Studio runs on Windows and Mac; the zip is made on
any device (iPad included) and opened on the computer that runs Studio.

## What is in the zip

| File | What it is |
| --- | --- |
| `models.glb` | Everything except terrain: houses, plants, scatter copies (one part each, sharing meshes), imported models. |
| `<terrain>_heightmap.png`, `<terrain>_colormap.png` | Each terrain as Roblox Terrain: grey heights, and colours from Roblox's colormap key (grass → Grass, paths → Ground, cliffs → Rock). |
| `terrain_mesh_optional.glb` | The same terrain as plain meshes, if you'd rather not use Roblox Terrain. |
| `README.txt` | The steps below with this scene's exact numbers. |

What the export does for Roblox:

- **Units:** scaled from metres to studs (1 stud = 0.28 m, Roblox's official unit), so the
  importer's default *Scale Unit: Studs* is right.
- **Triangle limit:** any mesh over 20,000 triangles is split into spatial chunks.
- **Instances:** scatter copies (GPU instancing, which Roblox doesn't read) become separate parts.
- **Textures:** tiling is baked into the UVs (Roblox ignores glTF texture transforms); colour and
  roughness maps become JPEG, normal maps PNG, all at most 1024 px.
- **Orientation:** the front of the scene (−Y in B3D) faces the same way in Studio. The models and
  the terrain line up around the origin.

## In Roblox Studio

1. **Models:** Home → Import 3D → `models.glb`. Keep *Scale Unit: Studs*, turn on
   *Insert Using Scene Position* and *Anchored*, then Import.
2. **Terrain:** Home → Terrain Editor → Import. Pick the heightmap and the colormap, type the
   size and position from `README.txt`, and generate.
3. **Look:** Lighting → Technology *Future*; add an Atmosphere and a Sky; Terrain decoration on
   for swaying grass.

## Known limits

- The heightmap's orientation in Studio follows Roblox's usual image layout (columns → +X,
  rows → +Z). If the terrain comes in mirrored or turned relative to the models, use
  `terrain_mesh_optional.glb` instead, which is always aligned.
- Roblox voxel terrain is 4 studs (1.1 m) per voxel, so small bumps smooth out; scatter `sink`
  hides gaps under rocks and trees.
- Skinned people (`addHuman`) are not converted to Roblox R15 avatars; export them as static models.
- Large scenes import as hundreds of parts. That is normal for Roblox; the importer reuses
  the meshes they share.
