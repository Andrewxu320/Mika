// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/diff-assessments.mjs <trip-directory>
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { diffSnapshots } from '../lib/snapshots.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length < 2) {
    console.error('Usage: node scripts/diff-assessments.mjs <previous.json> <current.json>');
    return 2;
  }
  try {
    const [previous, current] = await Promise.all(args.slice(0, 2).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    console.log(JSON.stringify(diffSnapshots(previous, current), null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();