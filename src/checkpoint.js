// Atomic checkpoint persistence. A checkpoint is only trusted after the
// collector re-verifies that its block hash is still canonical.
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serialize, deserialize } from './state.js';

// Overlapping saves must never share a temporary file.
const tmpName = path => `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
// Windows refuses a rename onto a file another rename is replacing (EPERM,
// EBUSY, EACCES) for a moment; retry briefly. Elsewhere the first try succeeds.
async function replace(tmp, path) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(tmp, path); } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 5));
    }
  }
}

export async function saveCheckpoint(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try { await writeFile(tmp, serialize(state)); await replace(tmp, path); }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}

export async function loadCheckpoint(path, target) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return deserialize(text, target);
}

// Small text files (index aggregates) with the same atomic-rename discipline.
export async function saveText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try { await writeFile(tmp, text); await replace(tmp, path); }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}
export async function loadText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
