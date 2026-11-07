// Small inline SVG icon set (original drawings, no third-party assets).
import type { ReactNode } from 'react';

const S = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const Icon = {
  select: () => <S><path d="M5 3l10 6-4.5 1.2L13 16l-2 1-2.6-5.6L5 14z" /></S>,
  move: () => <S><path d="M10 2v16M2 10h16M10 2 8 4.5M10 2l2 2.5M10 18l-2-2.5M10 18l2-2.5M2 10l2.5-2M2 10l2.5 2M18 10l-2.5-2M18 10l-2.5 2" /></S>,
  rotate: () => <S><path d="M16 10a6 6 0 1 1-2-4.5" /><path d="M14.5 2.5V6H11" /></S>,
  scale: () => <S><rect x="3" y="9" width="8" height="8" /><path d="M9 3h8v8M17 3l-7 7" /></S>,
  cube: () => <S><path d="M10 2.5 17 6.5v7L10 17.5 3 13.5v-7zM3 6.5l7 4 7-4M10 10.5v7" /></S>,
  sphere: () => <S><circle cx="10" cy="10" r="7" /><ellipse cx="10" cy="10" rx="7" ry="2.6" /></S>,
  cylinder: () => <S><ellipse cx="10" cy="4.5" rx="6" ry="2" /><path d="M4 4.5v11c0 1.1 2.7 2 6 2s6-.9 6-2v-11" /></S>,
  plane: () => <S><path d="M2 12.5 8 7h10l-6 5.5z" /></S>,
  cone: () => <S><path d="M10 2.5 4 15.5M10 2.5l6 13" /><ellipse cx="10" cy="15.5" rx="6" ry="2" /></S>,
  torus: () => <S><ellipse cx="10" cy="10" rx="7.5" ry="4" /><ellipse cx="10" cy="9.6" rx="3" ry="1.3" /></S>,
  capsule: () => <S><rect x="6" y="2.5" width="8" height="15" rx="4" /></S>,
  mesh: () => <S><path d="M3 15 7 4l6 3 4 9zM7 4l2 12M13 7l-4 9M3 15l14 1" /></S>,
  model: () => <S><path d="M4 7.5 10 4l6 3.5v6L10 17l-6-3.5z" /><path d="M10 10.5v6.5M4 7.5l6 3 6-3" /><circle cx="10" cy="10.5" r="1.2" fill="currentColor" /></S>,
  library: () => <S><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></S>,
  light: () => <S><circle cx="10" cy="8" r="4.5" /><path d="M8 14h4M8.5 17h3M10 1v1.5M3.5 3.5l1 1M16.5 3.5l-1 1" /></S>,
  empty: () => <S><path d="M10 3v14M3 10h14M5.5 5.5l9 9M14.5 5.5l-9 9" /></S>,
  script: () => <S><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9.5l-1.5 1.5 1.5 1.5M12.5 9.5l1.5 1.5-1.5 1.5M10.8 9l-1.6 5" /></S>,
  render: () => <S><circle cx="10" cy="10" r="7" /><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor" /></S>,
  solid: () => <S><circle cx="10" cy="10" r="7" fill="currentColor" fillOpacity=".35" /></S>,
  eye: () => <S><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" /><circle cx="10" cy="10" r="2.3" /></S>,
  eyeOff: () => <S><path d="M3 3l14 14M8.2 5a8 8 0 0 1 1.8-.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.4 3M5.4 6.6A14 14 0 0 0 2 10s3 5.5 8 5.5a7 7 0 0 0 3.4-.9" /></S>,
  frame: () => <S><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /><circle cx="10" cy="10" r="2.5" /></S>,
  views: () => <S><path d="M10 3v7l6 3.5M10 10l-6 3.5" /><circle cx="10" cy="10" r="7.5" /></S>,
  plus: () => <S><path d="M10 4v12M4 10h12" /></S>,
  dup: () => <S><rect x="6" y="6" width="10" height="10" rx="1" /><path d="M4 13V4h9" /></S>,
  trash: () => <S><path d="M4 6h12M8 6V4h4v2M5.5 6l1 11h7l1-11" /></S>,
  play: () => <S><path d="M6 4l10 6-10 6z" fill="currentColor" /></S>,
  pause: () => <S><path d="M6 4h3v12H6zM11 4h3v12h-3z" fill="currentColor" /></S>,
  first: () => <S><path d="M5 4v12M15 4 7 10l8 6z" /></S>,
  last: () => <S><path d="M15 4v12M5 4l8 6-8 6z" /></S>,
  chevron: ({ open }: { open: boolean }) => (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}>
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  menu: () => <S><path d="M3 5h14M3 10h14M3 15h14" /></S>,
};

export const typeIcon: Record<import('../core/types').ObjectType, () => ReturnType<typeof Icon.cube>> = {
  cube: Icon.cube, sphere: Icon.sphere, cylinder: Icon.cylinder, cone: Icon.cone, torus: Icon.torus, capsule: Icon.capsule,
  plane: Icon.plane, mesh: Icon.mesh, model: Icon.model, light: Icon.light, empty: Icon.empty,
};
