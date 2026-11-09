// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/render-bundle.mjs <trip-directory>
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactMetadata, loadTripDirectory, sha256 } from '../lib/artifacts.mjs';
import { renderMap } from './render-map.mjs';
import { renderOverview } from './render-overview.mjs';
import { renderReports } from './render-report.mjs';

export async function renderBundle(root, { generatedAt = new Date().toISOString() } = {}) {
  await renderReports(root, { generatedAt });
  const map = await renderMap(root, { generatedAt });
  await renderOverview(root, { generatedAt });
  const { trip } = await loadTripDirectory(root);
  // 三个渲染器都成功之后才算数:把这次修订记进 trip.json,state 走到 rendered、artifactRevision 指向当前修订。
  // 之后改动行程而不重新渲染,validate-trip 会以 ARTIFACT_REVISION_STALE 直接拦住。
  await markRendered(root, trip);
  const guidance = `# 行程目录\n\n修订版本：${trip.trip.revision}。生成时间：${generatedAt}。\n\n编辑后请运行 \`node scripts/validate-trip.mjs <this-directory> --json\`。每个驾驶日出发前请重新检查时效性较强的道路和天气证据。\n\n## 分享警告\n\n此目录包含行程时间和位置数据。分享前请删除不必要的文件并检查所有内容。不得在此存储服务提供商凭据和直接身份标识信息。\n`;
  await writeFile(join(root, 'README.md'), guidance, 'utf8');
  const files = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name !== 'manifest.json').map(({ name }) => name).sort();
  const hashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await sha256(join(root, file))])));
  const manifest = {
    ...artifactMetadata(trip, generatedAt),
    capabilities: Object.fromEntries(Object.entries(trip.capabilities).map(([name, value]) => [name, value.status])),
    files: hashes,
    limitations: map.limited ? ['map.html has no road geometry because no verified route was available.'] : []
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** 渲染成功后的回写:artifactRevision 指向当前修订,state 记成 rendered。已经是这样就不改文件。 */
async function markRendered(root, trip) {
  const revision = trip.trip?.revision;
  if (revision === undefined) return;
  if (trip.artifactRevision === revision && trip.trip.state === 'rendered') return;
  trip.artifactRevision = revision;
  trip.trip.state = 'rendered';
  await writeFile(join(root, 'trip.json'), `${JSON.stringify(trip, null, 2)}\n`, 'utf8');
}

export async function main(args = process.argv.slice(2)) {
  const root = resolve(args[0] ?? '.');
  try {
    await renderBundle(root);
    console.log(`Rendered artifact bundle in ${root}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();