// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/render-overview.mjs <trip-directory>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactMetadata, escapeHtml, loadTripDirectory, redactSensitive } from '../lib/artifacts.mjs';
import { coordinateSystemOf, tileSourceFor } from '../lib/tiles.mjs';
import { validateTrip } from '../lib/validation.mjs';

const PALETTE = ['#2563eb', '#7c3aed', '#0891b2', '#d98324', '#0f766e', '#be123c'];
const SEVERITY_ORDER = { blocking: 0, high: 1, medium: 2, low: 3 };

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(Number(value ?? 0) * factor) / factor;
};

const stopName = (trip, id) => (id ? String(trip.stops[id]?.name ?? id) : '—');

function buildDays(trip, routes) {
  // routes 以实体 id（route-<legId>）为键，这里按 legId 建索引
  const routeByLeg = new Map(Object.values(routes ?? {}).map((route) => [route.legId, route]));
  const days = Object.values(trip.days);
  let drivingIndex = 0;
  return days.map((day) => {
    const legs = (day.legIds ?? []).map((legId) => {
      const leg = trip.legs[legId];
      if (!leg) return null;
      const route = routeByLeg.get(legId);
      return {
        id: legId,
        from: stopName(trip, leg.fromStopId),
        to: stopName(trip, leg.toStopId),
        km: round(leg.distanceKm, 0),
        h: round((leg.durationMinutes ?? 0) / 60),
        coords: (route?.geometry ?? [])
          .filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon))
          .map(({ lat, lon }) => [lat, lon])
      };
    }).filter(Boolean);
    const color = legs.length ? PALETTE[drivingIndex++ % PALETTE.length] : '#94a3b8';
    const overnight = day.overnightStopId ?? null;
    return {
      id: day.id,
      date: day.date,
      text: day.sourceText ?? '',
      km: round(legs.reduce((sum, leg) => sum + leg.km, 0), 0),
      h: round(legs.reduce((sum, leg) => sum + leg.h, 0)),
      overnight: overnight ? stopName(trip, overnight) : '—',
      overnightAlt: Number.isFinite(trip.stops[overnight]?.elevationMeters) ? trip.stops[overnight].elevationMeters : null,
      color,
      riskIds: legs.flatMap((leg) => trip.legs[leg.id]?.riskIds ?? []),
      legs
    };
  });
}

function buildRisks(trip) {
  return Object.values(trip.risks)
    .slice()
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
    .map((risk) => ({
      id: risk.id,
      severity: risk.severity,
      confidence: risk.confidence,
      coverage: risk.coverage,
      status: risk.status,
      window: risk.window ?? '',
      unknown: Array.isArray(risk.unknowns) ? risk.unknowns[0] ?? '' : '',
      action: risk.recommendation ?? ''
    }));
}

/** 检查清单全部由数据推导：开放风险、过夜点、固定出发项。 */
function buildChecklist(trip, days) {
  const groups = [];
  const openRisks = Object.values(trip.risks).filter(({ status }) => status !== 'resolved');
  if (openRisks.length > 0) {
    groups.push({
      group: '按风险复核',
      items: openRisks.map((risk) => ({
        riskId: risk.id,
        text: risk.recommendation ? `${risk.id}：${risk.recommendation}` : `${risk.id}：复核证据缺口（${Array.isArray(risk.unknowns) ? risk.unknowns[0] ?? '' : ''}）`
      }))
    });
  }
  const overnight = days.filter((day) => day.overnight !== '—');
  if (overnight.length > 0) {
    groups.push({
      group: '住宿',
      items: overnight.map((day) => ({
        riskId: null,
        text: `确认 ${day.date} ${day.overnight} 的住宿`
      }))
    });
  }
  groups.push({
    group: '出发当日',
    items: [
      { riskId: null, text: '证件：身份证、驾驶证、行驶证（主线行程通常不需要边防证）' },
      { riskId: null, text: '离线地图与联系电话已就绪' },
      { riskId: null, text: '同行人员确认当日集合时间与目的地' }
    ]
  });
  return groups;
}

function buildKpis(days, trip) {
  const driving = days.filter((day) => day.legs.length > 0);
  const totalKm = round(driving.reduce((sum, day) => sum + day.km, 0), 0);
  const totalH = round(driving.reduce((sum, day) => sum + day.h, 0));
  const longest = driving.reduce((best, day) => (day.km > (best?.km ?? 0) ? day : best), null);
  const openRisks = Object.values(trip.risks).filter(({ status }) => status !== 'resolved').length;
  return [
    { v: `${totalKm} km`, l: '自驾总里程' },
    { v: `${totalH} h`, l: '累计驾驶时长' },
    { v: `${driving.length} 天`, l: '驾驶日' },
    { v: longest ? `${longest.km} km` : '—', l: longest ? `最长单日（${longest.date}）` : '无驾驶日' },
    { v: `${openRisks} 项`, l: '未关闭风险' }
  ];
}

function buildCapabilities(trip) {
  return Object.entries(trip.capabilities ?? {}).map(([name, value]) => ({
    name,
    status: value.status,
    limitations: Array.isArray(value.limitations) ? value.limitations : []
  }));
}

function renderOverviewHtml(trip, routes, metadata) {
  const days = buildDays(trip, routes);
  const risks = buildRisks(trip);
  const payload = redactSensitive({
    days,
    risks,
    kpis: buildKpis(days, trip),
    checklist: buildChecklist(trip, days),
    unknowns: trip.unknowns ?? [],
    capabilities: buildCapabilities(trip)
  });
  const source = tileSourceFor(coordinateSystemOf(routes));
  const driving = days.filter((day) => day.legs.length > 0);
  const meta = [
    `${trip.trip.startDate} → ${trip.trip.endDate}`,
    `${trip.participants?.count ?? '?'} 人`,
    trip.vehicle?.type ?? '车辆待定'
  ].join(' · ');
  const footer = [
    `行程修订 ${escapeHtml(metadata.tripRevision)} · 规则 ${escapeHtml(metadata.ruleVersion)} · 生成 ${escapeHtml(metadata.generatedAt)}。`,
    source
      ? `${escapeHtml(source.attribution)}；路线几何坐标系 ${escapeHtml(coordinateSystemOf(routes))}，底图与轨迹同源。底图与地图库在打开页面时由浏览器加载，离线时地图区域降级为文字说明。`
      : '未绘制底图：道路几何缺失或坐标系未知。',
    '海拔与用时为参考值；驾驶时长来自提供商标注的路程估算，未含观景停留、检查站排队与施工等待。',
    '<b>本页用于辅助规划，不构成安全保证。</b>页面包含具体日期与位置，分享前请检查。'
  ].join('<br>');
  return { payload, source, meta, footer, drivingDays: driving.length };
}

export async function renderOverview(root, { generatedAt = new Date().toISOString() } = {}) {
  const bundle = await loadTripDirectory(root);
  const validation = validateTrip(bundle.trip, bundle);
  if (!validation.valid) throw new Error('Trip validation failed; overview page was not rendered.');
  const template = await readFile(new URL('../templates/overview-page.html', import.meta.url), 'utf8');
  const metadata = artifactMetadata(bundle.trip, generatedAt);
  const { payload, source, meta, footer } = renderOverviewHtml(bundle.trip, bundle.routes, metadata);
  const json = JSON.stringify(payload).replaceAll('</', '<\\/');
  const html = template
    .replaceAll('{{TITLE}}', escapeHtml(bundle.trip.trip.title))
    .replaceAll('{{META}}', escapeHtml(meta))
    .replaceAll('{{REVISION}}', escapeHtml(`修订 ${metadata.tripRevision}`))
    .replaceAll('{{GATE}}', escapeHtml(bundle.trip.assessment.gate))
    .replaceAll('{{RISK_COUNT}}', String(Object.keys(bundle.trip.risks).length))
    .replaceAll('{{UNKNOWN_COUNT}}', String((bundle.trip.unknowns ?? []).length))
    .replaceAll('{{FOOTER}}', footer)
    .replaceAll('{{TILE_URL}}', JSON.stringify(source?.urlTemplate ?? null))
    .replaceAll('{{TILE_ATTR}}', JSON.stringify(source?.attribution ?? ''))
    .replaceAll('{{TILE_SUBDOMAINS}}', JSON.stringify(source?.subdomains ?? []))
    .replace('{{PAYLOAD}}', json);
  const path = join(root, '行程总览.html');
  await writeFile(path, html, 'utf8');
  return { path, limited: source === null, bytes: Buffer.byteLength(html) };
}

export async function main(args = process.argv.slice(2)) {
  const root = resolve(args[0] ?? '.');
  try {
    const result = await renderOverview(root);
    console.log(`Rendered ${result.path}${result.limited ? ' (limited: no basemap source)' : ''}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
