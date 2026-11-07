import { describe, expect, it } from 'vitest';
import { AI_TOOLS, summarizeScene, toolCallToCommandInput } from '../src/core/aiTools';
import { validateCommand, CommandError } from '../src/core/commands';
import { Store } from '../src/core/store';

describe('AI operator tool layer', () => {
  it('every tool name is a command the validator understands', () => {
    const samples: Record<string, unknown> = {
      add: { primitive: 'cube' }, transform: { id: 'a', position: [0, 0, 1] }, delete: { ids: ['a'] }, duplicate: { ids: ['a'] },
      rename: { id: 'a', name: 'Car' }, setParent: { id: 'a', parentId: null }, setColor: { id: 'a', color: '#101010' }, setVisible: { id: 'a', visible: false },
    };
    for (const t of AI_TOOLS) expect(validateCommand(toolCallToCommandInput(t.name, samples[t.name])).type).toBe(t.name);
  });

  it('a hostile tool call cannot smuggle in other command types or code', () => {
    expect(() => validateCommand(toolCallToCommandInput('runScript', { code: 'fetch("x")' }))).toThrow(CommandError);
    // the tool name always wins over a "type" field inside the input
    expect(validateCommand(toolCallToCommandInput('rename', { type: 'replaceScene', id: 'a', name: 'x' })).type).toBe('rename');
  });

  it('summarizes the scene compactly', () => {
    const s = new Store();
    expect(summarizeScene(s.getState().doc)).toMatch(/"Cube" cube parent=- loc=0,0,0/);
  });
});
