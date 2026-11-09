// Look-code validation, presets and preset files.
// A preset is just a name plus an ORIGINAL BuddyPoke look code, so presets stay interchangeable with
// BuddyRevival (?buddy=<code>, the original code box) and with old BuddyPoke codes.
// Pure module (no DOM): storage is injected, decoding uses the original decodeLook.
import { decodeLook, type Look } from '@original/domain/wardrobe.js';

export const MAX_CODE_LENGTH = 4096;
export const MAX_FILE_BYTES = 64 * 1024;
export const PRESET_FORMAT = 'buddypoke-studio-preset';
export const PRESET_VERSION = 1;
export const STORAGE_KEY = 'buddypoke-studio:presets';

export interface Preset {
  id: string;
  name: string;
  code: string;
  savedAt: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const CODE_CHARS = /^[A-Za-z0-9_/=+\s]+$/;

/**
 * Validate a look code with the original decoder. Accepts any code the original app would wear
 * correctly: it must decode (base64 -> zlib -> AMF3 string -> JSON object) and contain at least one
 * known wardrobe id with non-negative integer values. Codes may omit ids (older codes); the original
 * wearCode() fills them from the default look.
 */
export async function validateLookCode(input: string, knownIds: ReadonlySet<string>): Promise<Result<{ code: string; look: Look }>> {
  const code = input.trim().replace(/\s+/g, '');
  if (!code) return { ok: false, error: 'Paste a look code first.' };
  if (code.length > MAX_CODE_LENGTH) return { ok: false, error: `Look code is too long (max ${MAX_CODE_LENGTH} characters).` };
  if (!CODE_CHARS.test(code)) return { ok: false, error: 'Not a look code: it contains characters a look code never has.' };
  let look: unknown;
  try {
    look = await decodeLook(code);
  } catch {
    return { ok: false, error: 'Not a valid look code: it could not be decoded.' };
  }
  if (!look || typeof look !== 'object' || Array.isArray(look)) return { ok: false, error: 'Not a valid look code: it holds no look data.' };
  const entries = Object.entries(look as Record<string, unknown>);
  const known = entries.filter(([id]) => knownIds.has(id));
  if (!known.length) return { ok: false, error: 'This code holds no BuddyPoke look data.' };
  const bad = known.find(([, value]) => !Number.isInteger(value) || (value as number) < 0);
  if (bad) return { ok: false, error: `Not a valid look code: "${bad[0]}" has an invalid value.` };
  return { ok: true, value: { code, look: look as Look } };
}

export const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 60);

export function serializePresetFile(preset: Pick<Preset, 'name' | 'code'>): string {
  return `${JSON.stringify({ format: PRESET_FORMAT, version: PRESET_VERSION, name: preset.name, code: preset.code }, null, 2)}\n`;
}

export const presetFileName = (name: string) =>
  `${cleanName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'}.buddypoke.json`;

/** Parse and validate an exported preset file. Never throws. */
export async function parsePresetFile(text: string, byteLength: number, knownIds: ReadonlySet<string>): Promise<Result<{ name: string; code: string }>> {
  if (byteLength === 0) return { ok: false, error: 'The file is empty.' };
  if (byteLength > MAX_FILE_BYTES) return { ok: false, error: 'The file is too large to be a preset.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a preset file: it is not valid JSON.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Not a preset file.' };
  const file = data as Record<string, unknown>;
  if (file.format !== PRESET_FORMAT) return { ok: false, error: 'Not a BuddyPoke Studio preset file.' };
  if (typeof file.version !== 'number' || file.version > PRESET_VERSION) return { ok: false, error: 'This preset file was made by a newer version of the studio.' };
  if (typeof file.code !== 'string') return { ok: false, error: 'The preset file has no look code.' };
  const name = typeof file.name === 'string' ? cleanName(file.name) : '';
  const checked = await validateLookCode(file.code, knownIds);
  if (!checked.ok) return { ok: false, error: `The preset file's look code is invalid. ${checked.error}` };
  return { ok: true, value: { name: name || 'Imported preset', code: checked.value.code } };
}

/** Read presets from storage, dropping anything malformed (storage may be blocked or edited by hand). */
export function readPresets(storage: Pick<Storage, 'getItem'> | null): Preset[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (p): p is Preset =>
        !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.code === 'string' &&
        p.code.length > 0 && p.code.length <= MAX_CODE_LENGTH && typeof p.savedAt === 'string',
    );
  } catch {
    return [];
  }
}

/** Write presets; returns false when storage is unavailable or full. */
export function writePresets(storage: Pick<Storage, 'setItem'> | null, presets: Preset[]): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(presets));
    return !!storage;
  } catch {
    return false;
  }
}

/** Unique display name: "Name", "Name (2)", ... */
export function uniqueName(name: string, presets: Preset[]): string {
  const taken = new Set(presets.map(p => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}
