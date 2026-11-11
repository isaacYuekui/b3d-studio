import { describe, expect, it } from 'vitest';
import { LEGACY_FOV, cameraFov, equivalentFocal, lensFov } from '../src/core/lens';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';

describe('camera lens', () => {
  it('matches Blender: 50 mm on a 36 mm sensor is about 39.6° across', () => {
    expect((lensFov(50) * 180) / Math.PI).toBeCloseTo(39.6, 1);
    expect(lensFov(24)).toBeGreaterThan(lensFov(50));
  });

  it('spans the wider side (Sensor Fit: Auto); no lens keeps the original view', () => {
    expect(cameraFov({ focal: 35 }, 16 / 9)).toEqual({ fov: lensFov(35), horizontal: true });
    expect(cameraFov({ focal: 35 }, 3 / 4)).toEqual({ fov: lensFov(35), horizontal: false });
    expect(cameraFov(undefined, 16 / 9)).toEqual({ fov: LEGACY_FOV, horizontal: false });
    expect(cameraFov({ dof: true }, 16 / 9)).toEqual({ fov: LEGACY_FOV, horizontal: false });
    // the original view is about a 24 mm lens in 16:9
    expect(equivalentFocal(undefined, 16 / 9)).toBeCloseTo(23.9, 0);
    expect(equivalentFocal({ focal: 85 }, 1)).toBe(85);
  });

  it('setLens merges settings, null clears one, and the doc round-trips', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'setLens', lens: { focal: 85, dof: true, fStop: 1.4 } })).doc;
    expect(doc.lens).toEqual({ focal: 85, dof: true, fStop: 1.4 });
    doc = applyCommand(doc, validateCommand({ type: 'setLens', lens: { focus: 3, fStop: null } })).doc;
    expect(doc.lens).toEqual({ focal: 85, dof: true, focus: 3 });
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).lens).toEqual(doc.lens);
    doc = applyCommand(doc, validateCommand({ type: 'setLens', lens: { focal: null, dof: null, focus: null } })).doc;
    expect(doc.lens).toBeUndefined();
    expect(() => validateCommand({ type: 'setLens', lens: { focal: 0 } })).toThrow(/focal/);
    expect(() => validateCommand({ type: 'setLens', lens: { zoom: 2 } })).toThrow(/no setting/);
  });
});
