# B3D Studio

A browser-based 3D creation app with a professional desktop-style workflow, built with React, TypeScript and Babylon.js.
Runs on desktop browsers and on iPad / iPhone / Android (touch-first controls).

> Independent project. Inspired by professional desktop 3D tools; not affiliated with or endorsed by the Blender Foundation.

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
- Timeline with playhead and playback (keyframes arrive with the animation milestone)

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
