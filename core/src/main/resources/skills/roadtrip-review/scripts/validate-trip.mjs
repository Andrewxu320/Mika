// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/validate-trip.mjs <trip-directory>
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDiagnostics } from '../lib/diagnostics.mjs';
import { validateTrip } from '../lib/validation.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readEntityDirectory(path) {
  try {
    const files = (await readdir(path)).filter((file) => extname(file) === '.json');
    const entries = await Promise.all(files.map(async (file) => {
      const value = await readJson(join(path, file));
      return [value.id ?? basename(file, '.json'), value];
    }));
    return Object.fromEntries(entries);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function validatePath(inputPath) {
  const resolved = resolve(inputPath);
  const tripPath = extname(resolved) === '.json' ? resolved : join(resolved, 'trip.json');
  const root = dirname(tripPath);
  const [trip, routes, evidence, snapshots] = await Promise.all([
    readJson(tripPath),
    readEntityDirectory(join(root, 'routes')),
    readEntityDirectory(join(root, 'evidence')),
    readEntityDirectory(join(root, 'snapshots'))
  ]);
  return validateTrip(trip, { routes, evidence, snapshots });
}

export async function main(args = process.argv.slice(2)) {
  const json = args.includes('--json');
  const input = args.find((arg) => !arg.startsWith('-'));
  if (!input) {
    console.error('Usage: node scripts/validate-trip.mjs <trip.json|trip-directory> [--json]');
    return 2;
  }
  try {
    const result = await validatePath(input);
    console.log(json ? JSON.stringify(result, null, 2) : formatDiagnostics(result));
    return result.valid ? 0 : 1;
  } catch (error) {
    console.error(`ERROR INPUT_READ /: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}