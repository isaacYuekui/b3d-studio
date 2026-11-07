// Tool definitions for the future Claude AI operator.
//
// Flow (planned, not active in V0.1 — no API calls, no cost):
//   1. Browser sends the user's prompt + a compact scene summary to a Cloudflare Worker.
//   2. The Worker (holding the API key as a secret) calls the Claude API with these tools.
//   3. Claude replies with tool calls (JSON). The Worker returns them untouched.
//   4. The browser runs every call through validateCommand() and dispatches it to the store.
// Claude never sends JavaScript, and nothing it returns is executed except validated commands.
// Every AI change is a normal undoable command.

import type { SceneDoc } from './types';

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } as const;
const material = {
  type: 'object',
  properties: { baseColor: color, metallic: { type: 'number' }, roughness: { type: 'number' }, emission: color, emissionStrength: { type: 'number' }, alpha: { type: 'number' } },
} as const;
const light = {
  type: 'object',
  properties: { type: { type: 'string', enum: ['point', 'sun', 'spot'] }, color, power: { type: 'number' }, spotAngle: { type: 'number' }, shadows: { type: 'boolean' } },
} as const;

export const AI_TOOLS = [
  {
    name: 'add',
    description: 'Add an object: a primitive, custom mesh, light or empty. Units are metres, Z is up, rotation in degrees (Blender conventions). Give an id to reference it later (e.g. as parentId).',
    input_schema: {
      type: 'object',
      properties: {
        primitive: { type: 'string', enum: ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'mesh', 'light', 'empty'] },
        id: { type: 'string' },
        name: { type: 'string' },
        color,
        material,
        light,
        params: { type: 'object', properties: { segments: { type: 'integer' }, radiusTop: { type: 'number' }, radiusBottom: { type: 'number' }, majorRadius: { type: 'number' }, minorRadius: { type: 'number' } } },
        mesh: { type: 'object', properties: { vertices: { type: 'array', items: vec3 }, faces: { type: 'array', items: { type: 'array', items: { type: 'integer' } } }, smooth: { type: 'boolean' } } },
        parentId: { type: ['string', 'null'] },
        transform: { type: 'object', properties: { position: vec3, rotation: vec3, scale: vec3 } },
      },
      required: ['primitive'],
    },
  },
  {
    name: 'transform',
    description: 'Set location, rotation (degrees) and/or scale of an object.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, position: vec3, rotation: vec3, scale: vec3 }, required: ['id'] },
  },
  { name: 'delete', description: 'Delete objects and their children.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'duplicate', description: 'Duplicate objects with their children.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'rename', description: 'Rename an object.', input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } },
  { name: 'setParent', description: 'Parent an object to another (or null to unparent).', input_schema: { type: 'object', properties: { id: { type: 'string' }, parentId: { type: ['string', 'null'] } }, required: ['id', 'parentId'] } },
  { name: 'setColor', description: 'Set an object viewport colour.', input_schema: { type: 'object', properties: { id: { type: 'string' }, color }, required: ['id', 'color'] } },
  { name: 'setMaterial', description: 'Change material values (PBR: base colour, metallic, roughness, emission, alpha).', input_schema: { type: 'object', properties: { id: { type: 'string' }, material }, required: ['id', 'material'] } },
  { name: 'setLight', description: 'Change a light (type, colour, power in watts or sun strength, spot angle, shadows).', input_schema: { type: 'object', properties: { id: { type: 'string' }, light }, required: ['id', 'light'] } },
  { name: 'setVisible', description: 'Show or hide an object.', input_schema: { type: 'object', properties: { id: { type: 'string' }, visible: { type: 'boolean' } }, required: ['id', 'visible'] } },
] as const;

/** Convert a Claude tool call into raw command input for validateCommand(). */
export function toolCallToCommandInput(name: string, input: unknown): unknown {
  return typeof input === 'object' && input !== null ? { ...(input as object), type: name } : { type: name };
}

/** Compact scene description sent as context with each prompt (keeps tokens low). */
export function summarizeScene(doc: SceneDoc): string {
  return doc.order
    .map((id) => {
      const o = doc.objects[id];
      const t = o.transform;
      return `${id} "${o.name}" ${o.type} parent=${o.parentId ?? '-'} loc=${t.position.join(',')} rot=${t.rotation.join(',')} scale=${t.scale.join(',')} base=${o.material.baseColor}${o.light ? ` light=${o.light.type}/${o.light.power}` : ''}${o.visible ? '' : ' hidden'}`;
    })
    .join('\n');
}
