import { useState } from 'react';

/** Newest first. The first entry is the current version. */
const CHANGES: { v: string; items: string[] }[] = [
  { v: '3.8', items: ['Giant wave / tsunami on water (Water tab), carrying floating boats (example: Tsunami harbour)'] },
  { v: '3.7', items: ['Camera shake (Scene tab): impact, explosion, earthquake', 'Float on water (Physics tab): boats bob with the waves'] },
  { v: '3.6', items: ['Ocean waves: Add → Water / Ocean, wave height and Storm in the Water tab', 'Explosion and Dust cloud particle presets'] },
  { v: '3.5', items: ['Fire and smoke particles (presets in Physics → Particles), plus wind (example: Campfire)'] },
  { v: '3.4', items: ['Particles: Physics tab → Particles — sparks, fountains, rain, snow, debris (example: Particle night)'] },
  { v: '3.3', items: ['Cell Fracture: Physics tab → Fracture breaks an object into rigid pieces (example: Wall breach)', 'Convex hull collision shape; faster physics'] },
  { v: '3.2', items: ['Wireframe shading (⇧ Z or the first shading button): every edge, see-through'] },
  { v: '3.1', items: ['Properties tabs like Blender: Scene, Object, Modifiers, Physics, Text / Light, Material'] },
  { v: '3.0', items: ['Rigid body physics: Physics tab → Rigid body, then Bake physics (example: Physics playground)'] },
  { v: '2.9', items: ['3D text: Add → Text, with three fonts'] },
  { v: '2.8', items: ['Graph Editor (〰 Graph in the Timeline): curves you can drag'] },
  { v: '2.7', items: ['Camera lens and depth of field (Scene tab → Camera)'] },
  { v: '2.6', items: ['Edit Mode: Dissolve, Connect (J), Bridge Edge Loops, Smooth, To Sphere, Triangulate…'] },
  { v: '2.5', items: ['Modifiers: Array, Solidify, Displace (example: Modifier garden)'] },
  { v: '2.4', items: ['Sculpt Mode: Draw, Smooth, Inflate, Grab, Flatten'] },
  { v: '2.3', items: ['Materials: clearcoat, glass, sheen, skin and procedural patterns'] },
];
export const APP_VERSION = CHANGES[0].v;
const KEY = 'b3d.seenVersion';

const newer = (a: string, b: string) => {
  const [x1, y1] = a.split('.').map(Number), [x2, y2] = b.split('.').map(Number);
  return x1 !== x2 ? x1 > x2 : y1 > y2;
};

/** What changed since this device last opened the app (not shown to brand-new users or in tests). */
export function WhatsNew({ hasSavedWork }: { hasSavedWork: boolean }) {
  const [since] = useState<string | null>(() => {
    try {
      const params = new URLSearchParams(location.search);
      if (params.has('whatsnew')) return params.get('whatsnew') || '0.0';
      if (params.has('debug')) return null;
      const seen = localStorage.getItem(KEY);
      if (!seen) {
        localStorage.setItem(KEY, APP_VERSION);
        return hasSavedWork ? '2.2' : null; // came from before this panel existed
      }
      return newer(APP_VERSION, seen) ? seen : null;
    } catch {
      return null;
    }
  });
  const [open, setOpen] = useState(since !== null);
  if (!open || since === null) return null;
  const list = CHANGES.filter((c) => newer(c.v, since));
  if (!list.length) return null;
  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(KEY, APP_VERSION);
    } catch {
      /* fine */
    }
  };
  return (
    <div className="whatsnew" role="dialog" aria-label="What's new" data-testid="whatsnew">
      <div className="whatsnew-head">
        <b>New in B3D Studio</b>
        <button className="whatsnew-x" aria-label="Close" onClick={close}>✕</button>
      </div>
      <ul>
        {list.slice(0, 8).map((c) => (
          <li key={c.v}>
            <span className="muted">v{c.v}</span> {c.items.join(' · ')}
          </li>
        ))}
      </ul>
      <button className="btn primary" onClick={close}>Got it</button>
    </div>
  );
}
