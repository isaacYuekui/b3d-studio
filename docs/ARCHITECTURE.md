# B3D Studio — Architecture

## The one rule

**The scene is plain data, and it only changes through validated commands.**

```
 UI (React)  ─┐
 Shortcuts   ─┤                 ┌──────────────┐        ┌────────────────────┐
 Gizmo drags ─┼──► Command ───► │ applyCommand │ ─────► │ SceneDoc (immutable)│ ──► Viewport (Babylon) mirrors it
 File import ─┤   (JSON)        │  pure, tested│        └────────────────────┘ ──► Outliner / Properties render it
 Claude (v-) ─┘                 └──────────────┘               │
                                                               └──► history stack (undo/redo), autosave
```

Why: undo/redo is free (snapshots of immutable docs), every edit is testable without a browser, and the future AI operator
gets a safe surface — Claude emits JSON commands that pass the same validator as imported files. No AI-generated code is ever executed.

## Layout

| Path | Role |
|---|---|
| `src/core/types.ts` | Scene model: objects, transforms (Blender conventions: metres, **Z up**, Euler XYZ degrees) |
| `src/core/commands.ts` | Command union, pure `applyCommand`, validators for untrusted input |
| `src/core/store.ts` | App store: doc, selection, tool, history, live preview (`preview` / `commitPreview`) |
| `src/core/serialize.ts` | Project file format (`b3d-studio-project` v1), browser autosave |
| `src/core/serialize.ts` → `parseScript` | Scene scripts: validated command batches, one undo step (docs/SCRIPTS.md) |
| `src/engine/geometry.ts` | Custom mesh data → Babylon vertex data (winding verified by test) |
| `src/core/aiTools.ts` | Claude tool schemas mapped 1:1 to commands; scene summary for prompts (not wired up yet) |
| `src/engine/coords.ts` | Blender (right-handed, Z-up) ↔ Babylon (left-handed, Y-up) conversion — unit tested |
| `src/engine/Viewport.ts` | Babylon scene: mesh sync, picking, gizmos, camera, view presets |
| `src/ui/actions.ts` | Action registry shared by menus, shortcuts and context menus |
| `src/ui/*.tsx` | Top bar, tool shelf, viewport overlay, Outliner, Properties, Timeline, menus, help |
| `tests/` | Vitest unit tests; `tests/e2e/smoke.mjs` real-browser test (desktop, iPad, phone) |

## Key decisions

- **Babylon deep imports** (`@babylonjs/core/Meshes/meshBuilder` etc.) instead of the package root, to keep the bundle down (≈390 KB gzip main chunk).
- **Pixel ratio capped at 2** on high-DPI screens: big fill-rate saving on iPads and phones.
- **Picking only on tap**, not on pointer move, to save CPU on mobile.
- **Left-drag orbits, right-click is the context menu**, middle or Ctrl/⌘+drag pans. This differs from Blender (middle-drag orbit) because it works identically on trackpads and touch screens.
- **Single selection** in V0.1. The command layer already takes id lists, so multi-select is a UI change, not a model change.
- **Parenting keeps local transforms** (like Blender's "parent without inverse"). A "keep transform" option comes with the matrix utilities in the modeling milestone.

## Security model for the AI operator (planned)

1. Browser → Cloudflare Worker: prompt + `summarizeScene(doc)`.
2. Worker holds the Claude API key as an encrypted secret (`wrangler secret put`), calls the Messages API with `AI_TOOLS`, rate-limits per user.
3. Worker returns tool calls only. Browser converts each with `toolCallToCommandInput` → `validateCommand` → `store.dispatch`.
4. Invalid calls are rejected and reported; valid ones are ordinary undoable steps.

## Roadmap

| Milestone | Scope |
|---|---|
| v0.2 Scene builder ✅ | Scene scripts, more primitives, custom meshes, PBR materials, lights, shadows, Solid/Rendered shading, GLB export |
| v0.3 Modeling | Edit mode: vertex/edge/face select, extrude, inset, loop cut, bevel; subdivision surface |
| v0.4 Animation | Keyframes on transforms, dope sheet in the timeline, camera objects |
| v0.5 AI operator | Cloudflare Worker + Claude tools above; "studio lighting", "orbit camera" style commands |
| later | Modifiers & subdivision, UV editor, sculpting, shader/geometry nodes, rigging, physics |
