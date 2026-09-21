// Atomic checkpoint persistence. A checkpoint is only trusted after the
// collector re-verifies that its block hash is still canonical.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serialize, deserialize } from './state.js';

export async function saveCheckpoint(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, serialize(state));
  await rename(tmp, path);
}

export async function loadCheckpoint(path, target) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return deserialize(text, target);
}
