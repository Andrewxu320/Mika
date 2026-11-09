/**
 * 瓦片底图相关的纯函数。
 *
 * 设计约束（见 openspec/changes/add-overview-page-and-map-basemap/design.md）：
 * - 渲染阶段不得联网，因此这里只生成 URL 与坐标，从不发起请求。
 * - 轨迹与底图必须同一坐标系：GCJ-02 几何只能配 GCJ-02 瓦片。
 */

const TILE_SIZE = 256;
const MAX_MERCATOR_LAT = 85.05112878;

const SOURCES = {
  'GCJ-02': {
    id: 'amap',
    label: '高德地图',
    urlTemplate: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    attribution: '底图 © 高德地图（GCJ-02）'
  },
  WGS84: {
    id: 'osm',
    label: 'OpenStreetMap',
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: [],
    attribution: '底图 © OpenStreetMap contributors（WGS84）'
  }
};

/** 坐标系 → 瓦片源；未知坐标系返回 null（不猜、不默认 WGS84）。 */
export function tileSourceFor(coordinateSystem) {
  if (typeof coordinateSystem !== 'string') return null;
  return SOURCES[coordinateSystem] ?? null;
}

/** 经度 → 归一化墨卡托 X（0..1）。 */
export function mercatorX(lon) {
  return (Number(lon) + 180) / 360;
}

/** 纬度 → 归一化墨卡托 Y（0..1，北为 0）。 */
export function mercatorY(lat) {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, Number(lat)));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/** 所有几何的经纬度包围盒；没有可用点时返回 null。 */
export function bboxOfRoutes(routes) {
  const points = Object.values(routes ?? {}).flatMap(({ geometry = [] }) => geometry)
    .filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon));
  if (points.length < 2) return null;
  const lats = points.map(({ lat }) => lat);
  const lons = points.map(({ lon }) => lon);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons)
  };
}

function clampTile(value, max) {
  return Math.min(max, Math.max(0, value));
}

/**
 * 选出覆盖包围盒的瓦片网格。
 * 瓦片总数必须不超过 maxTiles，否则逐级降低 zoom。
 * 返回的 origin/span 是归一化墨卡托坐标下整块拼图的范围，供渲染器做投影。
 */
export function pickTiles(bounds, { maxTiles = 16, maxZoom = 14, minZoom = 3 } = {}) {
  if (!bounds) return null;
  const x0 = mercatorX(bounds.minLon);
  const x1 = mercatorX(bounds.maxLon);
  const y0 = mercatorY(bounds.maxLat);
  const y1 = mercatorY(bounds.minLat);
  for (let zoom = maxZoom; zoom >= minZoom; zoom -= 1) {
    const n = 2 ** zoom;
    const tx0 = clampTile(Math.floor(x0 * n), n - 1);
    const tx1 = clampTile(Math.floor(x1 * n), n - 1);
    const ty0 = clampTile(Math.floor(y0 * n), n - 1);
    const ty1 = clampTile(Math.floor(y1 * n), n - 1);
    const cols = tx1 - tx0 + 1;
    const rows = ty1 - ty0 + 1;
    if (cols * rows > maxTiles) continue;
    const tiles = [];
    for (let x = tx0; x <= tx1; x += 1) {
      for (let y = ty0; y <= ty1; y += 1) tiles.push({ x, y, z: zoom });
    }
    return {
      zoom,
      tiles,
      origin: { x: tx0 / n, y: ty0 / n },
      span: { x: cols / n, y: rows / n }
    };
  }
  return null;
}

/** 把瓦片模板填成具体 URL。 */
export function tileUrl(source, { x, y, z }) {
  const subdomains = source?.subdomains ?? [];
  const sub = subdomains.length ? subdomains[(x + y) % subdomains.length] : '';
  return String(source?.urlTemplate ?? '')
    .replaceAll('{s}', sub)
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

/** 一条几何里声明的坐标系；混用时返回 null（调用方据此不画底图）。 */
export function coordinateSystemOf(routes) {
  const systems = new Set(Object.values(routes ?? {})
    .map(({ coordinateSystem }) => coordinateSystem)
    .filter((value) => typeof value === 'string'));
  return systems.size === 1 ? [...systems][0] : null;
}

export { TILE_SIZE, MAX_MERCATOR_LAT };
