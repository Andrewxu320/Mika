// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/render-map.mjs <trip-directory>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactMetadata, escapeHtml, loadTripDirectory } from '../lib/artifacts.mjs';
import { bboxOfRoutes, coordinateSystemOf, mercatorX, mercatorY, pickTiles, tileSourceFor, tileUrl } from '../lib/tiles.mjs';
import { validateTrip } from '../lib/validation.mjs';

const VIEW = { width: 1000, height: 600, pad: 40, maxTiles: 16 };

/**
 * 建立投影：优先用瓦片拼图的范围，使底图与轨迹共用同一墨卡托映射；
 * 没有可用底图时退回几何包围盒，保持旧的线框观感。
 */
function buildProjection(routes) {
  const bounds = bboxOfRoutes(routes);
  if (bounds === null) return null;
  const coordinateSystem = coordinateSystemOf(routes);
  const source = tileSourceFor(coordinateSystem);
  const mosaic = source === null ? null : pickTiles(bounds, { maxTiles: VIEW.maxTiles });
  const left = mosaic ? mosaic.origin.x : mercatorX(bounds.minLon);
  const top = mosaic ? mosaic.origin.y : mercatorY(bounds.maxLat);
  const right = mosaic ? mosaic.origin.x + mosaic.span.x : mercatorX(bounds.maxLon);
  const bottom = mosaic ? mosaic.origin.y + mosaic.span.y : mercatorY(bounds.minLat);
  const width = Math.max(right - left, 1e-9);
  const height = Math.max(bottom - top, 1e-9);
  const inner = { w: VIEW.width - VIEW.pad * 2, h: VIEW.height - VIEW.pad * 2 };
  const toX = (mx) => VIEW.pad + ((mx - left) / width) * inner.w;
  const toY = (my) => VIEW.pad + ((my - top) / height) * inner.h;
  const project = (lat, lon) => ({ x: toX(mercatorX(lon)), y: toY(mercatorY(lat)) });
  return { project, toX, toY, mosaic, source, coordinateSystem };
}

/** 静态瓦片网格：只生成 <image>，渲染时不发请求，离线打开自然降级。 */
function renderBasemap(projection) {
  if (projection === null || projection.mosaic === null || projection.source === null) return '';
  const n = 2 ** projection.mosaic.zoom;
  const images = projection.mosaic.tiles.map((tile) => {
    const x0 = projection.toX(tile.x / n);
    const x1 = projection.toX((tile.x + 1) / n);
    const y0 = projection.toY(tile.y / n);
    const y1 = projection.toY((tile.y + 1) / n);
    return `<image href="${escapeHtml(tileUrl(projection.source, tile))}" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" preserveAspectRatio="none"/>`;
  }).join('');
  return `<g class="basemap" aria-hidden="true">${images}</g>`;
}

function projectRoutes(routes, trip) {
  const projection = buildProjection(routes);
  if (projection === null) return { markup: null, projection, hasBasemap: false };
  const paths = Object.values(routes).map((route) => {
    const dayId = trip.legs[route.legId]?.dayId ?? '';
    const alternative = route.alternativeId ? ' class="alternative"' : '';
    const d = (route.geometry ?? [])
      .map(({ lat, lon }) => {
        const point = projection.project(lat, lon);
        return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .join(' L ');
    return `<path${alternative} data-day="${escapeHtml(dayId)}" data-leg="${escapeHtml(route.legId)}" d="M ${d}"><title>${escapeHtml(route.legId)} - ${escapeHtml(route.provider)}</title></path>`;
  }).join('');
  const markers = Object.values(trip.risks)
    .filter(({ location }) => Number.isFinite(location?.lat) && Number.isFinite(location?.lon))
    .map((risk) => {
      const point = projection.project(risk.location.lat, risk.location.lon);
      return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="7"><title>${escapeHtml(risk.id)} - ${escapeHtml(risk.summary ?? risk.status)}</title></circle>`;
    }).join('');
  const basemap = renderBasemap(projection);
  return {
    markup: `<svg viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" aria-label="Verified road route geometry">${basemap}${paths}${markers}</svg>`,
    projection,
    hasBasemap: basemap.length > 0
  };
}

export async function renderMap(root, { generatedAt = new Date().toISOString() } = {}) {
  const bundle = await loadTripDirectory(root);
  const validation = validateTrip(bundle.trip, bundle);
  if (!validation.valid) throw new Error('Trip validation failed; map was not rendered.');
  const template = await readFile(new URL('../templates/map.html', import.meta.url), 'utf8');
  const metadata = artifactMetadata(bundle.trip, generatedAt);
  const { markup, projection, hasBasemap } = projectRoutes(bundle.routes, bundle.trip);
  const dayControls = Object.values(bundle.trip.days).map((day) => `<button type="button" data-day="${escapeHtml(day.id)}">${escapeHtml(day.date)}</button>`);
  const riskControls = Object.values(bundle.trip.risks).map((risk) => `<button type="button" title="${escapeHtml(risk.action ?? 'Review finding')}">Risk: ${escapeHtml(risk.id)}</button>`);
  const alternativeControls = Object.values(bundle.trip.alternatives).map((alternative) => `<button type="button">Plan B: ${escapeHtml(alternative.id)} (${escapeHtml(alternative.verification?.status ?? 'unverified')})</button>`);
  const navigation = Object.values(bundle.trip.stops).filter(({ navigationUrl }) => navigationUrl).map((stop) => `<a rel="noopener noreferrer" href="${escapeHtml(stop.navigationUrl)}">Navigate: ${escapeHtml(stop.name ?? stop.id)}</a>`);
  const controls = [...dayControls, ...riskControls, ...alternativeControls, ...navigation].join('');
  const notice = markup
    ? 'Lines show provider-supplied road geometry over a static basemap, not live navigation. Recheck conditions before departure.'
    : 'Route geometry is unavailable. No straight-line road claim has been drawn; use the itinerary and verify with a routing provider.';
  const basemapNote = hasBasemap
    ? `${projection.source.attribution}；轨迹坐标系 ${projection.coordinateSystem}，与底图同源。瓦片在打开页面时由浏览器按需加载。`
    : (markup ? '未绘制底图：几何坐标系未知或不受支持。' : '');
  const html = template
    .replaceAll('{{TITLE}}', escapeHtml(bundle.trip.trip.title))
    .replace('{{METADATA}}', escapeHtml(`Revision ${metadata.tripRevision} | Rules ${metadata.ruleVersion} | Generated ${metadata.generatedAt}`))
    .replace('{{GATE}}', escapeHtml(bundle.trip.assessment.gate))
    .replace('{{CONTROLS}}', controls)
    .replace('{{MAP}}', markup ?? '<p class="notice">Verified route geometry unavailable.</p>')
    .replace('{{BASEMAP}}', escapeHtml(basemapNote))
    .replace('{{NOTICE}}', escapeHtml(notice));
  await writeFile(join(root, 'map.html'), html, 'utf8');
  return { limited: !markup, basemap: hasBasemap, path: join(root, 'map.html') };
}

export async function main(args = process.argv.slice(2)) {
  const root = resolve(args[0] ?? '.');
  try {
    const result = await renderMap(root);
    console.log(`Rendered ${result.path}${result.limited ? ' (limited: no route geometry)' : ''}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
