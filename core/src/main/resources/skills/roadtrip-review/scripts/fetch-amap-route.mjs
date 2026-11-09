#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Vendored from lulu-road-trip-planner (MIT; see LICENSE.lulu.md). Usage: node scripts/fetch-amap-route.mjs <trip-directory>
/**
 * 通过高德 Web 服务 API（REST，v5 驾车）取道路几何，写入 <trip>/routes/<routeId>.json。
 *
 * 为什么不用 MCP：`mcp__amap__maps_direction_driving` 只返回距离、时长与分段道路名，
 * `paths[].path` 是空串，steps 里也没有 polyline。同一 Key 直接调 REST 并带
 * `show_fields=polyline` 时，同样的路线能拿到完整形状点（成都→康定实测 2658 点）。
 *
 * 用法：
 *   node scripts/fetch-amap-route.mjs <trip-directory> [--leg <id>]... [--force] [--apply] [--geocode] [--json]
 *
 *   --leg <id>   只取指定路段（可重复）；默认取 trip.json 里所有端点坐标齐全的路段
 *   --force      覆盖已存在的 routes/<routeId>.json
 *   --apply      同时回写 leg 的 distanceKm / durationMinutes / routeRef，重算当天合计，
 *                并生成一条新修订（trip.revision 前移，artifactRevision 置空）
 *   --geocode    location 为 null 的停靠点用高德地理编码补坐标；每一条都校验级别、同名歧义与相邻距离，
 *                拿不准就跳过并说明原因，绝不硬填。补上的坐标写进 stop.location（source: amap-geocode）
 *   --json       机器可读输出
 *
 * Key 解析顺序（任一即停，绝不打印 key）：
 *   1. 环境变量 AMAP_KEY
 *   2. 环境变量 AMAP_MAPS_API_KEY
 *   3. $DSH_HOME/profiles/<profile>/cordis.patch.yml 里的 mcp.amap.com/mcp?key=...
 *
 * 坐标系：高德返回 GCJ-02，route.coordinateSystem 如实写 GCJ-02，不做 WGS84 转换。
 * 海拔：没有数据源，elevationsMeters 写 null（schema 允许）。
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDER = 'amap-web-service-v5';
const ENDPOINT = 'https://restapi.amap.com/v5/direction/driving';
const GEOCODE_ENDPOINT = 'https://restapi.amap.com/v3/geocode/geo';
const KEY_PATTERN = /mcp\.amap\.com\/mcp\?key=([A-Za-z0-9]+)/;
/** 地理编码认可的行政区级别;兴趣点、门牌号、道路这些不当作停靠点坐标。 */
const ADMIN_LEVELS = new Set(['国家', '省', '市', '区县', '开发区', '乡镇']);
/** 补出来的坐标必须落在已有停靠点这么大的范围内,否则多半是同名异地(高德 `新都桥` 会给到浙江的兴趣点)。 */
const MAX_NEIGHBOUR_KM = 600;
/** 两次地理编码之间的间隔:高德个人 Key 每秒只放几个请求,连发会回 status=0。 */
const GEOCODE_GAP_MS = 500;

/** 把毫秒/秒换算成保留三位小数的公里数。 */
function toKm(meters) {
  return Number((Number(meters) / 1000).toFixed(3));
}

/** 高德坐标串 "lon,lat;lon,lat..." 转成 schema 的 {lat, lon}，去掉相邻重复点。 */
export function parsePolyline(polyline, points) {
  for (const pair of String(polyline).split(';')) {
    const [lon, lat] = pair.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const last = points.at(-1);
    if (last && last.lat === lat && last.lon === lon) continue;
    points.push({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
  }
  return points;
}

/** 依次尝试环境变量与 DSH profile 配置，返回 { key, source }；找不到返回 null。 */
export async function resolveKey() {
  for (const name of ['AMAP_KEY', 'AMAP_MAPS_API_KEY']) {
    const value = process.env[name];
    if (value && value.trim()) return { key: value.trim(), source: `env:${name}` };
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilesDir = join(home, 'profiles');
  let profiles = [];
  try {
    profiles = await readdir(profilesDir);
  } catch {
    return null;
  }
  for (const profile of profiles) {
    const file = join(profilesDir, profile, 'cordis.patch.yml');
    try {
      const match = (await readFile(file, 'utf8')).match(KEY_PATTERN);
      if (match) return { key: match[1], source: file };
    } catch {
      continue;
    }
  }
  return null;
}

/** 两个坐标之间的球面距离（公里）；只用来判断「是不是离得太远」。 */
export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 高德返回的一条地理编码里的坐标；没有坐标（城市级常给空串）为 null。 */
function pointOf(candidate) {
  if (typeof candidate?.location !== 'string') return null;
  const [lon, lat] = candidate.location.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}

/**
 * 从地理编码的候选里挑一个能用的坐标。拿不准就返回原因，绝不硬填：
 *  - 返回的地址里要出现查询词（否则就不是同一个地方）；
 *  - 优先行政区级别，兴趣点/门牌号只有在对得上名字时才考虑；
 *  - 候选跨省说明有同名地点，交给用户确认；
 *  - 给了相邻停靠点时，候选必须在 [MAX_NEIGHBOUR_KM] 之内（`新都桥` 会被解析到浙江的兴趣点）。
 */
export function chooseGeocode(candidates, { name, neighbours = [] } = {}) {
  const list = (candidates ?? []).map((candidate) => ({ candidate, point: pointOf(candidate) })).filter((item) => item.point);
  if (list.length === 0) return { ok: false, reason: '没有返回可用坐标' };
  const want = String(name ?? '').replace(/\s+/g, '');
  const named = list.filter(({ candidate: c }) => {
    const address = String(c.formatted_address ?? '').replace(/\s+/g, '');
    return address.includes(want) || [c.province, c.city, c.district].some((v) => String(v ?? '').replace(/\s+/g, '') === want);
  });
  if (named.length === 0) return { ok: false, reason: `返回的地址里没有「${name}」` };
  const admin = named.filter(({ candidate: c }) => ADMIN_LEVELS.has(c.level));
  const pool = admin.length > 0 ? admin : named;
  const provinces = new Set(pool.map(({ candidate: c }) => c.province).filter(Boolean));
  if (provinces.size > 1) return { ok: false, reason: `同名地点跨省（${[...provinces].join('、')}），需要用户确认` };
  const nearestOf = (item) => neighbours.length === 0 ? 0 : Math.min(...neighbours.map((n) => haversineKm(item.point, n)));
  if (neighbours.length > 0) {
    const nearest = Math.min(...pool.map(nearestOf));
    if (nearest > MAX_NEIGHBOUR_KM) {
      const far = pool.reduce((a, b) => (nearestOf(a) <= nearestOf(b) ? a : b));
      return { ok: false, reason: `离最近的已有停靠点 ${Math.round(nearest)} km（超过 ${MAX_NEIGHBOUR_KM} km），多半是同名异地：${far.candidate.formatted_address}` };
    }
  }
  const best = neighbours.length === 0 ? pool[0] : pool.reduce((a, b) => (nearestOf(a) <= nearestOf(b) ? a : b));
  return { ok: true, candidate: best.candidate, point: best.point, distanceToNearestKm: neighbours.length === 0 ? null : Math.round(nearestOf(best)) };
}

/** 调一次高德地理编码；网络抖动由 [fetchWithRetry] 兜住，API 明确的失败直接抛出。 */
async function geocodeStop(key, name, timeoutMs) {
  const url = `${GEOCODE_ENDPOINT}?key=${encodeURIComponent(key)}&address=${encodeURIComponent(name)}`;
  const response = await fetchWithRetry(url, timeoutMs);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`地理编码返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (data.status !== '1') throw new Error(`地理编码失败：${data.info ?? 'unknown'}（${data.infocode ?? ''}）`);
  return Array.isArray(data.geocodes) ? data.geocodes : [];
}


/** 网络层面的瞬时失败值得重试（手机网络抖动是常态）；API 明确拒绝不重试。 */
const TRANSIENT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

async function fetchWithRetry(url, timeoutMs, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      last = error;
      const code = error?.cause?.code ?? error?.code ?? '';
      const transient = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        || TRANSIENT_CODES.has(code) || /fetch failed/i.test(String(error?.message ?? ''));
      if (!transient || attempt === attempts - 1) break;
      await new Promise((done) => setTimeout(done, 600 * (attempt + 1)));
    }
  }
  const code = last?.cause?.code ?? last?.code;
  const why = last?.name === 'TimeoutError' ? '超时' : String(last?.message ?? 'unknown');
  throw new Error(`请求失败：${why}${code ? `（${code}）` : ''}（已试 ${attempts} 次）`);
}

async function fetchLeg(key, from, to, timeoutMs) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('key', key);
  url.searchParams.set('origin', `${from.lon.toFixed(6)},${from.lat.toFixed(6)}`);
  url.searchParams.set('destination', `${to.lon.toFixed(6)},${to.lat.toFixed(6)}`);
  url.searchParams.set('show_fields', 'polyline,cost');

  const response = await fetchWithRetry(url, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  if (payload.status !== '1') throw new Error(`高德返回 status=${payload.status} info=${payload.info} infocode=${payload.infocode}`);

  const path = payload.route?.paths?.[0];
  if (!path) throw new Error('响应里没有 route.paths[0]');

  const geometry = [];
  for (const step of path.steps ?? []) {
    if (step.polyline) parsePolyline(step.polyline, geometry);
  }
  if (geometry.length < 2) throw new Error('响应里没有 polyline（show_fields=polyline 未生效？）');

  const seconds = Number(
    path.cost?.duration
    ?? path.duration
    ?? (path.steps ?? []).reduce((total, step) => total + (Number(step.cost?.duration ?? step.duration) || 0), 0),
  );
  const distanceKm = toKm(path.distance);
  const durationMinutes = Math.round(seconds / 60);
  if (!(distanceKm > 0)) throw new Error('响应里的距离无效');
  if (!(durationMinutes > 0)) throw new Error('响应里的时长无效');

  return { geometry, distanceKm, durationMinutes, sourceUrl: redactUrl(url) };
}

/** 去掉 URL 里的 key，供 sourceUrl 落盘。 */
export function redactUrl(url) {
  const copy = new URL(url.href);
  if (copy.searchParams.has('key')) copy.searchParams.set('key', 'REDACTED');
  return copy.href;
}

/** 修订号的合法形状（和 trip.schema.json 的 id 一致）。 */
const VALID_REVISION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * 新修订号沿用行程已有的写法：`r3` → `r4`、`rev-9` → `rev-10`（数字位数保持不变）；
 * 和已有编号撞上就往后找。当前修订号没有「前缀 + 数字」的形状时，退回 `rev-N`。
 */
export function nextRevisionId(trip) {
  const used = new Set((trip.revisions ?? []).map(({ id }) => id));
  const current = String(trip.trip?.revision ?? '');
  const match = /^([a-z][a-z0-9-]*?)(\d+)$/.exec(current);
  if (match) {
    const [, prefix, digits] = match;
    let n = Number(digits) + 1;
    for (let guard = 0; guard < 1000; guard += 1, n += 1) {
      const candidate = `${prefix}${String(n).padStart(digits.length, '0')}`;
      if (VALID_REVISION.test(candidate) && !used.has(candidate)) return candidate;
    }
  }
  let index = 1;
  while (used.has(`rev-${index}`)) index += 1;
  return `rev-${index}`;
}

/** 回写里程/时长/routeRef 与当天合计，并生成新修订；无变化返回 null。 */export function applyToTrip(trip, results, nowIso, { alsoChanged = false } = {}) {
  let changed = alsoChanged;
  for (const result of results) {
    const leg = trip.legs?.[result.legId];
    if (!leg) continue;
    if (leg.routeRef !== result.routeId) { leg.routeRef = result.routeId; changed = true; }
    if (leg.distanceKm !== result.distanceKm) { leg.distanceKm = result.distanceKm; changed = true; }
    if (leg.durationMinutes !== result.durationMinutes) { leg.durationMinutes = result.durationMinutes; changed = true; }
  }

  for (const day of Object.values(trip.days ?? {})) {
    const legs = (day.legIds ?? []).map((id) => trip.legs?.[id]).filter(Boolean);
    const distanceKm = Number(legs.reduce((total, leg) => total + (Number(leg.distanceKm) || 0), 0).toFixed(3));
    const durationMinutes = Math.round(legs.reduce((total, leg) => total + (Number(leg.durationMinutes) || 0), 0));
    if (day.distanceKm !== distanceKm) { day.distanceKm = distanceKm; changed = true; }
    if (day.durationMinutes !== durationMinutes) { day.durationMinutes = durationMinutes; changed = true; }
  }

  if (!changed) return null;

  const revision = nextRevisionId(trip);
  trip.revisions = trip.revisions ?? [];
  trip.revisions.push({ id: revision, createdAt: nowIso, reason: '写入高德实测道路几何与里程', parentId: trip.trip.revision });
  trip.trip.revision = revision;
  trip.artifactRevision = null;
  return revision;
}

export function parseArgs(argv) {
  const options = { tripDir: null, legs: [], force: false, apply: false, geocode: false, json: false, timeoutMs: 20000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--leg') {
      const value = argv[index + 1];
      if (!value) throw new Error('--leg 缺少参数');
      options.legs.push(value);
      index += 1;
    } else if (arg === '--force') options.force = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--geocode') options.geocode = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--timeout') {
      options.timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout 需要正整数毫秒');
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
    else if (options.tripDir === null) options.tripDir = arg;
    else throw new Error(`多余的位置参数：${arg}`);
  }
  return options;
}

const USAGE = `用法：node scripts/fetch-amap-route.mjs <trip-directory> [--leg <id>]... [--force] [--apply] [--geocode] [--json]

  --leg <id>   只取指定路段（可重复）
  --force      覆盖已存在的 routes/<routeId>.json
  --apply      回写 leg 里程/时长/routeRef 与当天合计，并生成新修订
  --geocode    location 为 null 的停靠点用高德地理编码补坐标（校验级别、同名歧义与相邻距离，拿不准就跳过）
  --json       机器可读输出
  --timeout    单次请求超时（毫秒，默认 20000）

Key：AMAP_KEY / AMAP_MAPS_API_KEY 环境变量，或 $DSH_HOME/profiles/<profile>/cordis.patch.yml。
`;

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.tripDir) {
    process.stderr.write(USAGE);
    return 2;
  }

  const root = resolve(options.tripDir);
  let trip;
  try {
    trip = JSON.parse(await readFile(join(root, 'trip.json'), 'utf8'));
  } catch (error) {
    console.error(`读不到 ${join(root, 'trip.json')}：${error.message}`);
    return 2;
  }

  const resolved = await resolveKey();
  if (!resolved) {
    console.error('找不到高德 Key：请设置 AMAP_KEY，或在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里配置高德 MCP。');
    return 2;
  }

  const requested = options.legs.length > 0 ? options.legs : Object.keys(trip.legs ?? {});
  const results = [];
  const failures = [];

  // 先补坐标:按路段出现顺序处理 location 为 null 的停靠点,每补一个都拿已有的停靠点做邻近校验
  const geocodes = [];
  if (options.geocode) {
    const order = [];
    for (const legId of requested) {
      const leg = trip.legs?.[legId];
      if (!leg) continue;
      for (const stopId of [leg.fromStopId, leg.toStopId]) if (stopId && !order.includes(stopId)) order.push(stopId);
    }
    for (const stopId of order) {
      const stop = trip.stops?.[stopId];
      if (!stop) continue;
      if (stop.location && Number.isFinite(stop.location.lat) && Number.isFinite(stop.location.lon)) continue;
      const name = stop.name ?? stopId;
      try {
        const neighbours = Object.values(trip.stops ?? {})
          .map((s) => s.location)
          .filter((l) => l && Number.isFinite(l.lat) && Number.isFinite(l.lon));
        // 同名异地时换个后缀再查一次(乡镇名常常要带「镇」「乡」才落得到正确的位置)
        const variants = [name, `${name}镇`, `${name}乡`, `${name}县`].filter((v, i, all) => all.indexOf(v) === i);
        let picked = null;
        let query = name;
        let reason = null;
        for (const variant of variants) {
          query = variant;
          let candidates;
          try {
            candidates = await geocodeStop(resolved.key, variant, options.timeoutMs);
          } catch (error) {
            reason = error.message;
            break;
          }
          const attempt = chooseGeocode(candidates, { name: variant, neighbours });
          if (attempt.ok) {
            picked = attempt;
            break;
          }
          reason = attempt.reason;
          // 只有"同名异地 / 跨省 / 太远"值得换个后缀再试;地址里根本没有这个词就不用试了
          if (!/同名异地|跨省|超过/.test(attempt.reason)) break;
          await new Promise((done) => setTimeout(done, GEOCODE_GAP_MS));
        }
        if (!picked) {
          geocodes.push({ stopId, name, ok: false, reason: reason ?? '没有可用结果' });
        } else {
          stop.location = {
            ...picked.point,
            coordinateSystem: 'GCJ-02',
            source: 'amap-geocode',
            geocode: {
              query,
              formattedAddress: picked.candidate.formatted_address ?? null,
              level: picked.candidate.level ?? null,
              adcode: picked.candidate.adcode ?? null,
              provider: 'amap-geocode-v3',
              at: new Date().toISOString(),
            },
          };
          geocodes.push({
            stopId, name, ok: true, ...picked.point, query,
            level: picked.candidate.level ?? null,
            formattedAddress: picked.candidate.formatted_address ?? null,
            distanceToNearestKm: picked.distanceToNearestKm,
          });
        }
      } catch (error) {
        geocodes.push({ stopId, name, ok: false, reason: error.message });
      }
      await new Promise((done) => setTimeout(done, GEOCODE_GAP_MS));
    }
  }

  for (const legId of requested) {
    const leg = trip.legs?.[legId];
    if (!leg) {
      failures.push({ legId, error: 'trip.json 里没有这个路段' });
      continue;
    }
    const from = trip.stops?.[leg.fromStopId]?.location;
    const to = trip.stops?.[leg.toStopId]?.location;
    if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) {
      failures.push({ legId, error: `端点坐标缺失（${leg.fromStopId} → ${leg.toStopId}）` });
      continue;
    }
    if (from.coordinateSystem !== 'GCJ-02' || to.coordinateSystem !== 'GCJ-02') {
      failures.push({ legId, error: '端点坐标系不是 GCJ-02；高德不返回 WGS84 几何，需先转换坐标' });
      continue;
    }

    const routeId = leg.routeRef ?? `route-${legId}`;
    const target = join(root, 'routes', `${routeId}.json`);
    if (!options.force && await exists(target)) {
      results.push({ legId, routeId, skipped: true, reason: 'routes 已存在（--force 覆盖）' });
      continue;
    }

    try {
      const queryTime = new Date().toISOString();
      const fetched = await fetchLeg(resolved.key, from, to, options.timeoutMs);
      const route = {
        schemaVersion: '0.1.0',
        id: routeId,
        legId,
        provider: PROVIDER,
        queryTime,
        coordinateSystem: 'GCJ-02',
        distanceKm: fetched.distanceKm,
        durationMinutes: fetched.durationMinutes,
        geometry: fetched.geometry,
        elevationsMeters: null,
        sourceUrl: fetched.sourceUrl,
      };
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(route, null, 2)}\n`, 'utf8');
      results.push({
        legId,
        routeId,
        distanceKm: fetched.distanceKm,
        durationMinutes: fetched.durationMinutes,
        points: fetched.geometry.length,
        plannedDistanceKm: Number.isFinite(leg.distanceKm) ? leg.distanceKm : null,
        plannedDurationMinutes: Number.isFinite(leg.durationMinutes) ? leg.durationMinutes : null,
        routePath: target,
      });
    } catch (error) {
      failures.push({ legId, error: error.message });
    }
    await new Promise((done) => setTimeout(done, 250));
  }

  let revision = null;
  const applied = results.filter((result) => !result.skipped);
  const geocoded = geocodes.some((item) => item.ok);
  if (options.apply && (applied.length > 0 || geocoded)) {
    revision = applyToTrip(trip, applied, new Date().toISOString(), { alsoChanged: geocoded });
    if (revision) await writeFile(join(root, 'trip.json'), `${JSON.stringify(trip, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, keySource: resolved.source, geocodes, results, failures, revision }, null, 2));
  } else {
    console.log(`Key 来源：${resolved.source}`);
    if (geocodes.length > 0) {
      console.log('坐标补齐（地理编码）：');
      for (const item of geocodes) {
        if (item.ok) console.log(`- ${item.name}（${item.stopId}）：采用「${item.formattedAddress}」（${item.level}，${item.lat},${item.lon}）${item.query && item.query !== item.name ? `，查询词「${item.query}」` : ''}`);
        else console.log(`- ${item.name}（${item.stopId}）：跳过 — ${item.reason}`);
      }
    }
    for (const result of results) {
      if (result.skipped) {
        console.log(`- ${result.legId}：跳过（${result.reason}）`);
        continue;
      }
      const delta = result.plannedDistanceKm === null ? '' : `（计划 ${result.plannedDistanceKm} km，差 ${Number((result.distanceKm - result.plannedDistanceKm).toFixed(3))} km）`;
      console.log(`- ${result.legId}：${result.distanceKm} km / ${result.durationMinutes} min，${result.points} 个几何点${delta}`);
      console.log(`  → ${result.routePath}`);
    }
    for (const failure of failures) console.error(`- ${failure.legId}：失败 — ${failure.error}`);
    if (revision) console.log(`已回写 trip.json，新修订 ${revision}（artifactRevision 已置空，需重新渲染）`);
    else if (options.apply && applied.length > 0) console.log('trip.json 无需回写（数值一致）');
    else if (options.apply) console.log('这次没有取到可回写的路段（原因见上面的失败行），trip.json 未改动');
  }

  return failures.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
