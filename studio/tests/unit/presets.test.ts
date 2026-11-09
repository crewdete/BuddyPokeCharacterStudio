import { describe, expect, it } from 'vitest';
import { writeAmf3String } from '@original/engine/amf3.js';
import { deflate } from '@original/engine/binary.js';
import { DEFAULT_LOOK_CODE, decodeLook, encodeLook } from '@original/domain/wardrobe.js';
import {
  MAX_CODE_LENGTH, MAX_FILE_BYTES, PRESET_FORMAT, STORAGE_KEY, cleanName, parsePresetFile, presetFileName, readPresets,
  serializePresetFile, uniqueName, validateLookCode, writePresets, type Preset,
} from '../../src/character/presets';

const knownIds = new Set(Object.keys(await decodeLook(DEFAULT_LOOK_CODE)));
/** Encode arbitrary text exactly like a look code (AMF3 string -> zlib -> base64 with '+' as '_'). */
const encodeText = async (text: string) => btoa(String.fromCharCode(...(await deflate(writeAmf3String(text))))).replace(/\+/g, '_');

describe('validateLookCode (original decoder)', () => {
  it('accepts the original default code and full codes', async () => {
    const result = await validateLookCode(DEFAULT_LOOK_CODE, knownIds);
    expect(result.ok).toBe(true);
    const full = await encodeLook({ ...(await decodeLook(DEFAULT_LOOK_CODE)), hrt: 7 });
    expect(await validateLookCode(full, knownIds)).toMatchObject({ ok: true, value: { code: full } });
  });

  it('accepts partial (older) codes and ignores surrounding whitespace / line breaks', async () => {
    const partial = await encodeLook({ hrt: 5, shc: 10 });
    const wrapped = `  ${partial.slice(0, 10)}\n${partial.slice(10)}  `;
    expect(await validateLookCode(wrapped, knownIds)).toMatchObject({ ok: true, value: { code: partial } });
  });

  it.each([
    ['empty', '', 'Paste a look code first.'],
    ['spaces only', '   ', 'Paste a look code first.'],
    ['bad characters', 'hello world!', 'characters'],
    ['not compressed data', 'AAAAAAAA', 'could not be decoded'],
    ['truncated', DEFAULT_LOOK_CODE.slice(0, 40), 'could not be decoded'],
    ['too long', 'A'.repeat(MAX_CODE_LENGTH + 1), 'too long'],
  ])('rejects %s', async (_, input, message) => {
    const result = await validateLookCode(input, knownIds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('rejects decodable data that is not a look', async () => {
    for (const [text, message] of [
      ['not json', 'could not be decoded'],
      ['"just a string"', 'no look data'],
      ['[1,2,3]', 'no look data'],
      ['{"foo":1,"bar":2}', 'no BuddyPoke look data'],
      ['{"hrt":-1}', 'invalid value'],
      ['{"hrt":1.5}', 'invalid value'],
      ['{"hrt":"3"}', 'invalid value'],
    ] as const) {
      const result = await validateLookCode(await encodeText(text), knownIds);
      expect(result, text).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error, text).toContain(message);
    }
  });
});

describe('preset files', () => {
  const code = DEFAULT_LOOK_CODE;
  const file = (data: unknown) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return [text, new TextEncoder().encode(text).length] as const;
  };

  it('round-trips name and code', async () => {
    const text = serializePresetFile({ name: 'Street look', code });
    expect(JSON.parse(text)).toEqual({ format: PRESET_FORMAT, version: 1, name: 'Street look', code });
    expect(await parsePresetFile(...file(text), knownIds)).toEqual({ ok: true, value: { name: 'Street look', code } });
  });

  it('cleans names and defaults a missing one', async () => {
    expect(await parsePresetFile(...file({ format: PRESET_FORMAT, version: 1, name: '  a   b  ', code }), knownIds)).toMatchObject({ value: { name: 'a b' } });
    expect(await parsePresetFile(...file({ format: PRESET_FORMAT, version: 1, code }), knownIds)).toMatchObject({ value: { name: 'Imported preset' } });
  });

  it.each([
    ['empty file', ['', 0], 'empty'],
    ['oversized file', ['{}', MAX_FILE_BYTES + 1], 'too large'],
    ['not JSON', file('not json {'), 'not valid JSON'],
    ['JSON array', file([1, 2]), 'Not a preset file'],
    ['other format', file({ format: 'something-else', version: 1, code }), 'Not a BuddyPoke Studio preset'],
    ['newer version', file({ format: PRESET_FORMAT, version: 99, code }), 'newer version'],
    ['missing code', file({ format: PRESET_FORMAT, version: 1, name: 'x' }), 'no look code'],
    ['invalid code', file({ format: PRESET_FORMAT, version: 1, name: 'x', code: 'zzzz' }), 'look code is invalid'],
  ])('rejects %s', async (_, [text, size], message) => {
    const result = await parsePresetFile(text as string, size as number, knownIds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('builds safe file names', () => {
    expect(presetFileName('Street Look #1')).toBe('street-look-1.buddypoke.json');
    expect(presetFileName('***')).toBe('preset.buddypoke.json');
  });
});

describe('preset storage', () => {
  const preset: Preset = { id: 'a', name: 'A', code: DEFAULT_LOOK_CODE, savedAt: '2026-11-09T00:00:00.000Z' };
  const memory = (initial?: string) => {
    const data = new Map<string, string>(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('round-trips presets', () => {
    const storage = memory();
    expect(writePresets(storage, [preset])).toBe(true);
    expect(readPresets(storage)).toEqual([preset]);
  });

  it('survives missing, corrupted or hand-edited storage', () => {
    expect(readPresets(null)).toEqual([]);
    expect(readPresets(memory())).toEqual([]);
    expect(readPresets(memory('{not json'))).toEqual([]);
    expect(readPresets(memory('{"a":1}'))).toEqual([]);
    expect(readPresets(memory(JSON.stringify([preset, null, 5, { id: 'b', name: 'B' }, { ...preset, id: 'c', code: '' }])))).toEqual([preset]);
    expect(readPresets({ getItem: () => { throw new Error('SecurityError'); } })).toEqual([]);
  });

  it('reports failed writes (blocked or full storage)', () => {
    expect(writePresets(null, [preset])).toBe(false);
    expect(writePresets({ setItem: () => { throw new Error('QuotaExceededError'); } }, [preset])).toBe(false);
  });

  it('names', () => {
    expect(cleanName(`  ${'x'.repeat(80)}  `)).toHaveLength(60);
    expect(uniqueName('A', [preset])).toBe('A (2)');
    expect(uniqueName('A', [preset, { ...preset, id: 'b', name: 'A (2)' }])).toBe('A (3)');
    expect(uniqueName('New', [preset])).toBe('New');
  });
});
