// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/render-report.mjs <trip-directory>
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactMetadata, escapeMarkdown, loadTripDirectory, redactSensitive } from '../lib/artifacts.mjs';
import { validateTrip } from '../lib/validation.mjs';

function header(title, metadata) {
  return `# ${escapeMarkdown(title)}\n\n> 架构版本 ${metadata.schemaVersion} | 行程修订版本 ${metadata.tripRevision} | 规则版本 ${metadata.ruleVersion} | 生成时间 ${metadata.generatedAt}`;
}

export function renderRouteReview(rawTrip, generatedAt) {
  const trip = redactSensitive(rawTrip);
  const metadata = artifactMetadata(trip, generatedAt);
  const risks = Object.values(trip.risks);
  const blocking = risks.filter(({ severity, status }) => severity === 'blocking' && status !== 'resolved');
  const attention = risks.filter(({ severity, status }) => severity === 'attention' && status !== 'resolved');
  // coverage 为空(或没记)也是缺口:没记录的覆盖等于不知道,不能只数 limited/unknown/none
  const gaps = risks.filter(({ coverage }) => coverage === null || coverage === undefined || ['limited', 'unknown', 'none'].includes(coverage));
  const unknowns = trip.unknowns.map(({ path, reason }) => `- ${escapeMarkdown(path)}: ${escapeMarkdown(reason)}`);
  const findings = risks.map((risk) => `- **${escapeMarkdown(risk.id)}** (${escapeMarkdown(risk.severity)}/${escapeMarkdown(risk.confidence)}): ${escapeMarkdown(risk.summary ?? risk.status)}${risk.action ? ` 操作建议：${escapeMarkdown(risk.action)}` : ''}`);

  return `${header(`${trip.trip.title} 路线审查`, metadata)}

## 执行门槛：${trip.assessment.gate}

| 阻断项 | 关注项 | 证据缺口 |
| ---: | ---: | ---: |
| ${blocking.length} | ${attention.length} | ${gaps.length} |

## 优先发现

${findings.join('\n') || '- 已检查的来源中未记录任何发现，但这并不能证明行程安全。'}

## 证据覆盖

${Object.entries(trip.capabilities).map(([name, capability]) => `- ${escapeMarkdown(name)}: **${escapeMarkdown(capability.status)}**${capability.limitations.length ? ` - ${escapeMarkdown(capability.limitations.join('; '))}` : ''}`).join('\n')}

## 未知项

${unknowns.join('\n') || '- 无记录。'}

## 建议操作

${blocking.length ? '- 出发前解决阻断项，或接受经过验证的备选方案。' : '- 临近出发时重新检查时效性较强的道路和天气证据。'}
- 向运营管理部门和导航服务提供商确认导航信息及通行限制。

> 本报告仅用于辅助规划，不构成安全保证。时间和位置数据仍属敏感信息；分享前请仔细检查。
`;
}

export function renderItinerary(rawTrip, generatedAt) {
  const trip = redactSensitive(rawTrip);
  const metadata = artifactMetadata(trip, generatedAt);
  const sections = Object.values(trip.days).map((day) => {
    const legs = (day.legIds ?? []).map((legId) => {
      const leg = trip.legs[legId];
      const from = trip.stops[leg.fromStopId]?.name ?? leg.fromStopId;
      const to = trip.stops[leg.toStopId]?.name ?? leg.toStopId;
      const risks = (leg.riskIds ?? []).map((id) => id).join(', ') || '无记录';
      return `- ${escapeMarkdown(leg.id)}: ${escapeMarkdown(from)} -> ${escapeMarkdown(to)}；${leg.distanceKm ?? '未知'} km；${leg.durationMinutes ?? '未知'} 分钟；风险：${escapeMarkdown(risks)}`;
    });
    return `## ${escapeMarkdown(day.id)} - ${escapeMarkdown(day.date)}\n\n${legs.join('\n')}\n\n当日合计：${day.distanceKm ?? '未知'} km / ${day.durationMinutes ?? '未知'} 分钟。住宿点：${escapeMarkdown(day.overnightStopId ?? '未知')}。`;
  });
  const accepted = Object.values(trip.alternatives).filter(({ accepted }) => accepted).map(({ id }) => `- ${escapeMarkdown(id)}`);
  return `${header(`${trip.trip.title} 行程安排`, metadata)}\n\n${sections.join('\n\n')}\n\n## 已接受的备选方案\n\n${accepted.join('\n') || '- 无。'}\n\n> 每个驾驶日出发前请核实最新路况。时间和位置数据仍属敏感信息。\n`;
}

export async function renderReports(root, { generatedAt = new Date().toISOString() } = {}) {
  const bundle = await loadTripDirectory(root);
  const validation = validateTrip(bundle.trip, bundle);
  await writeFile(join(root, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  if (!validation.valid) throw new Error('Trip validation failed; see validation.json.');
  await Promise.all([
    writeFile(join(root, 'route-review.md'), renderRouteReview(bundle.trip, generatedAt), 'utf8'),
    writeFile(join(root, 'itinerary.md'), renderItinerary(bundle.trip, generatedAt), 'utf8')
  ]);
  return bundle;
}

export async function main(args = process.argv.slice(2)) {
  const root = resolve(args[0] ?? '.');
  try {
    await renderReports(root);
    console.log(`Rendered route-review.md and itinerary.md in ${root}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();