#!/usr/bin/env node
/**
 * 把 lulu-road-trip-planner 同步成 Mika 的内置技能。
 *
 * lulu 仓库是唯一事实源:这里只做拷贝、生成清单、做 Mika 构建期会做的那些检查,
 * 不修改 lulu 的任何文件。Mika 一侧只有 `tools/lulu/SKILL.md` 与
 * `tools/lulu/references/mika-adapter.md` 是手写的(宿主适配),其余都是拷贝。
 *
 * 用法:
 *   node tools/lulu/sync.mjs [lulu 仓库根] [--skip-tests]
 *
 * 退出码非零表示没有同步(检查没过时不动目标目录里已有的内容)。
 *
 * 对应方案:lulu-to-mika-plan.md §3。
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIKA_ROOT = resolve(HERE, '../..');
const TARGET = join(MIKA_ROOT, 'core/src/main/resources/skills/roadtrip-review');
const SKILL_NAME = 'roadtrip-review';

/** 要搬的脚本(入口);scripts/lib/* 整体搬。`network` 的要用户在设置里允许脚本联网。 */
const SCRIPTS = [
  'validate-trip.mjs',
  'render-report.mjs',
  'render-map.mjs',
  'render-overview.mjs',
  'render-bundle.mjs',
  'diff-assessments.mjs',
  'fetch-amap-route.mjs',
];
const NEEDS_NETWORK = new Set(['fetch-amap-route.mjs']);

const errors = [];
const notes = [];
function bad(message) { errors.push(message); }
function ok(message) { notes.push(message); }

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const skipTests = args.includes('--skip-tests');
  const lulu = resolve(args.find((a) => !a.startsWith('-')) ?? join(MIKA_ROOT, '../lulu-road-trip-planner'));

  // 1. 源仓库形状
  for (const need of ['SKILL.md', 'references', 'schemas', 'templates', 'scripts/lib']) {
    if (!(await exists(join(lulu, need)))) bad(`lulu 仓库缺少 ${need}:${lulu}`);
  }
  if (errors.length) return finish();

  // 2. lulu 自己的测试(离线)。红了不许同步:宁可不同步,也不要把坏的脚本打进 APK。
  if (!skipTests) {
    const test = spawnSync('node', ['--import', './tests/helpers/disable-network.mjs', '--test'], {
      cwd: lulu, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (test.status !== 0) {
      bad(`lulu 自己的测试没通过(exit ${test.status}),本次不同步。` +
        ' 如果整份输出都是 spawn EPERM,那是当前沙箱不允许子进程管道,不是代码问题:' +
        '换一台普通机器跑,或确认只差这一项后用 --skip-tests。');
      return finish();
    }
    ok('lulu 测试通过');
  }

  // 3. 先在一处临时目录里拼好,检查全过再换上去:同步失败不留半份
  const staging = `${TARGET}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'references'), { recursive: true });
  await mkdir(join(staging, 'lib'), { recursive: true });
  await mkdir(join(staging, 'schemas'), { recursive: true });
  await mkdir(join(staging, 'templates'), { recursive: true });

  await cp(join(lulu, 'references'), join(staging, 'references'), { recursive: true });
  await cp(join(lulu, 'schemas'), join(staging, 'schemas'), { recursive: true });
  // 模板只要渲染脚本用得到的那两个顶层的;lulu 的 templates/ 里还有给别的宿主用的技能模板,不搬
  for (const template of await readdir(join(lulu, 'templates'), { withFileTypes: true })) {
    if (!template.isFile()) continue;
    await cp(join(lulu, 'templates', template.name), join(staging, 'templates', template.name));
  }
  // 共用代码放 lib/,不放 scripts/:Mika 的脚本清单要求 scripts/ 下只有可运行的入口(其余会被测试拦下)
  await cp(join(lulu, 'scripts/lib'), join(staging, 'lib'), { recursive: true });
  // 上游已经修好 render 系脚本不读 snapshots 的问题(2026-11-06);这里只核对它确实读,不再打补丁
  if (!lf(await readFile(join(staging, 'lib/artifacts.mjs'), 'utf8')).includes("readEntities(join(root, 'snapshots'))")) {
    bad('上游 lib/artifacts.mjs 没有读 snapshots:带 snapshotRef 的行程会在渲染时报断链');
  }

  for (const script of SCRIPTS) {
    const from = join(lulu, 'scripts', script);
    if (!(await exists(from))) { bad(`缺少脚本 scripts/${script}`); continue; }
    await mkdir(join(staging, 'scripts'), { recursive: true });
    let text = transform(lf(await readFile(from, 'utf8')), script);
    // AGP 的 Java 资源合并会丢掉 templates/overview.html 这个名字(同内容换个名字就能进包),
    // 所以随包时改名,并把脚本里的模板路径一起改掉。
    if (script === 'render-overview.mjs') {
      text = patch(text, "new URL('../templates/overview.html', import.meta.url)", "new URL('../templates/overview-page.html', import.meta.url)");
    }
    await writeFile(join(staging, 'scripts', script), text, 'utf8');
  }
  await rename(join(staging, 'templates/overview.html'), join(staging, 'templates/overview-page.html'));
  // 上游是 MIT:随包带上原许可证,并要求保留出处
  await cp(join(lulu, 'LICENSE'), join(staging, 'LICENSE.lulu.md'));

  // 4. 宿主适配与 SKILL.md 来自本目录(手写),不来自 lulu
  await cp(join(HERE, 'SKILL.md'), join(staging, 'SKILL.md'));
  for (const extra of await readdir(join(HERE, 'references'))) {
    await cp(join(HERE, 'references', extra), join(staging, 'references', extra));
  }

  // 5. 清单:run_bundled_script 只认列在这里的脚本
  const manifest = SCRIPTS.map((file) => ({
    file: `scripts/${file}`, runnable: true, ...(NEEDS_NETWORK.has(file) ? { needs: ['net'], network: true } : {}),
  }));
  await writeFile(join(staging, 'scripts/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 6. Mika 构建期会做的检查,这里先跑一遍
  await check(staging);

  if (errors.length) {
    await rm(staging, { recursive: true, force: true });
    return finish();
  }

  // 7. 换上去
  await rm(TARGET, { recursive: true, force: true });
  await cp(staging, TARGET, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  ok(`已同步到 ${relative(MIKA_ROOT, TARGET)}`);
  finish();
}

/** 上游在 Windows 上检出的是 CRLF;随包统一成 LF,补丁也按 LF 匹配。 */
function lf(text) {
  return text.replaceAll('\r\n', '\n');
}

/**
 * 改上游原文里的一处;找不到原文就报错(不同步),不静默跳过——上游改了写法必须立刻看见。
 */
function patch(text, from, to) {
  if (!text.includes(from)) {
    bad(`补丁对不上原文(上游可能改了):${from.split('\n')[0].slice(0, 80)}`);
    return text;
  }
  return text.replace(from, to);
}

/**
 * 随包的脚本带两行头:许可证(上游是 MIT,原文随包放在 LICENSE.lulu.md)与用法。
 * 共用代码从 scripts/lib/ 挪到了 lib/,所以 `./lib/x.mjs` 要改成 `../lib/x.mjs`。
 * 上游有的脚本第 1 行是 shebang:它必须留在第 1 行,否则 Node 按 ESM 加载会直接语法错误。
 */
function transform(text, script) {
  const body = text.replaceAll("from './lib/", "from '../lib/");
  const header = [
    '// SPDX-License-Identifier: MIT',
    `// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/${script} <trip-directory>`,
  ].join('\n');
  const shebang = /^#![^\n]*\n/.exec(body);
  if (shebang) return shebang[0] + header + '\n' + body.slice(shebang[0].length);
  return `${header}\n${body}`;
}

async function walk(dir, base = dir) {  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/** 与 Mika 的 KnowledgeIndex 同口径:名字、描述、正文引用、附件存在、不提别的条目、不留本机路径。 */
async function check(dir) {
  const skill = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const head = skill.split('---')[1] ?? '';
  const name = /^name:\s*(\S+)/m.exec(head)?.[1];
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim();
  if (name !== SKILL_NAME) bad(`SKILL.md 的 name 必须是 ${SKILL_NAME},现在是 ${name}`);
  if (!description) bad('SKILL.md 缺少 description');
  else if ([...description].length > 60) bad(`description 超过 60 字(${[...description].length})`);

  const files = new Set(await walk(dir));
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join(dir, file), 'utf8');
    if (text.includes('/Users/')) bad(`${file}: 出现本机路径`);
    for (const match of text.matchAll(/\b(?:app|site|skill):[a-z0-9][a-z0-9.-]*/g)) {
      bad(`${file}: 提到 ${match[0]};这两个列表必须是空的,条目引用会让构建失败`);
    }
    for (const match of text.matchAll(/references\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-]/g)) {
      if (!files.has(match[0])) bad(`${file}: 引用 ${match[0]} 不存在`);
    }
  }

  // 清单与脚本文件一一对应;BundledScriptsManifestTest 也会查
  const manifest = JSON.parse(await readFile(join(dir, 'scripts/manifest.json'), 'utf8'));
  for (const entry of manifest) {
    if (!files.has(entry.file)) { bad(`manifest 里的 ${entry.file} 不存在`); continue; }
    const text = await readFile(join(dir, entry.file), 'utf8');
    if (!text.split('\n').slice(0, 3).join('\n').includes('SPDX-License-Identifier:')) bad(`${entry.file}: 缺 SPDX 许可证头`);
    if (!text.includes('Usage:')) bad(`${entry.file}: 缺 Usage:`);
    // shebang 只能在第 1 行:放在许可证头后面会让 Node 直接拒绝加载
    if (text.includes('#!') && !text.startsWith('#!')) bad(`${entry.file}: shebang 不在第 1 行,Node 会报语法错误`);
    if (text.includes("from './lib/")) bad(`${entry.file}: 还在从 scripts/lib 取共用代码`);
    if (text.includes("from '../lib/") && !files.has('lib/validation.mjs')) bad(`${entry.file}: 引用了 lib/,但 lib/ 没搬过来`);
    const net = (entry.needs ?? []).includes('net');
    if (net !== (entry.network === true)) bad(`${entry.file}: needs 里的 net 要和 network 一致`);
  }
  for (const file of files) {
    if (!file.startsWith('scripts/') || !file.endsWith('.mjs')) continue;
    if (!manifest.some((e) => e.file === file)) bad(`${file} 没列进 manifest`);
  }
  // 两处补丁的结果:模板改了名、渲染脚本跟着改、渲染前的校验能看到快照
  if (!files.has('templates/overview-page.html')) bad('缺少 templates/overview-page.html(改名后的总览模板)');
  if (files.has('templates/overview.html')) bad('templates/overview.html 还在:AGP 会把它丢掉,应当已改名');
  if (!(await readFile(join(dir, 'scripts/render-overview.mjs'), 'utf8')).includes("'../templates/overview-page.html'")) {
    bad('render-overview.mjs 没指向改名后的模板');
  }
  if (!(await readFile(join(dir, 'lib/artifacts.mjs'), 'utf8')).includes("readEntities(join(root, 'snapshots'))")) {
    bad('lib/artifacts.mjs 没有读 snapshots:带 snapshotRef 的行程会渲染失败');
  }
  ok(`检查通过:${files.size} 个文件,${manifest.length} 个可运行脚本`);
}

function finish() {
  for (const note of notes) console.log(`  ${note}`);
  if (errors.length) {
    console.error('\n没有同步:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  }
}

await main();
