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

export const typeIcon = { cube: Icon.cube, sphere: Icon.sphere, cylinder: Icon.cylinder, plane: Icon.plane } as const;
