import { Diagnostics } from './diagnostics.mjs';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLACEHOLDER_PATTERN = /^(?:tbd|todo|unknown|n\/?a|\?+)$/i;
const SENSITIVE_KEY_PATTERN = /(?:phone|mobile|identity|passport|booking|plate|password|secret|credential|access.?token|home.?address)/i;
const REQUIRED_TOP_LEVEL = ['schemaVersion', 'trip', 'participants', 'vehicle', 'days', 'stops', 'legs', 'risks', 'alternatives', 'capabilities', 'unknowns', 'revisions', 'assessment'];
const GATES = ['not-executable', 'modification-required', 'executable-with-monitoring', 'insufficient-evidence', 'passed'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}/${index}`, visit));
  else if (isObject(value)) Object.entries(value).forEach(([key, item]) => walk(item, `${path}/${key}`, visit));
}

function checkStableId(diagnostics, value, path) {
  if (value !== undefined && value !== null && !ID_PATTERN.test(value)) diagnostics.error('ID_FORMAT', path, 'ID must be lowercase kebab-case.');
}

function checkEntityMap(diagnostics, map, path) {
  if (!isObject(map)) return diagnostics.error('STRUCTURE_TYPE', path, 'Expected an object keyed by stable ID.');
  for (const [key, entity] of Object.entries(map)) {
    checkStableId(diagnostics, key, `${path}/${key}`);
    if (!isObject(entity) || entity.id !== key) diagnostics.error('ID_KEY_MISMATCH', `${path}/${key}/id`, 'Entity ID must equal its map key.');
  }
}

function checkCoordinates(diagnostics, coordinate, path, { requireCoordinateSystem = false } = {}) {
  if (coordinate === null) return;
  if (!isObject(coordinate) || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lon)) {
    diagnostics.error('COORDINATE_INVALID', path, 'Coordinate must contain finite lat and lon values.');
    return;
  }
  if (coordinate.lat === 0 && coordinate.lon === 0) diagnostics.error('COORDINATE_ZERO', path, 'Unknown coordinates must be null, not (0, 0).');
  if (coordinate.lat < -90 || coordinate.lat > 90 || coordinate.lon < -180 || coordinate.lon > 180) diagnostics.error('COORDINATE_RANGE', path, 'Coordinate is outside plausible latitude/longitude ranges.');
  if (requireCoordinateSystem && !['GCJ-02', 'WGS84'].includes(coordinate.coordinateSystem)) diagnostics.error('COORDINATE_SYSTEM_INVALID', `${path}/coordinateSystem`, 'Coordinate system must be GCJ-02 or WGS84.');
}

function sumByIds(map, ids, property) {
  return ids.reduce((total, id) => total + (Number(map[id]?.[property]) || 0), 0);
}

function checkReferencesAndTotals(diagnostics, trip) {
  for (const [dayId, day] of Object.entries(trip.days ?? {})) {
    for (const legId of day.legIds ?? []) {
      if (!trip.legs?.[legId]) diagnostics.error('REFERENCE_BROKEN', `/days/${dayId}/legIds`, `Unknown leg ${legId}.`);
    }
    if (day.overnightStopId && !trip.stops?.[day.overnightStopId]) diagnostics.error('REFERENCE_BROKEN', `/days/${dayId}/overnightStopId`, `Unknown stop ${day.overnightStopId}.`);
    const distance = sumByIds(trip.legs ?? {}, day.legIds ?? [], 'distanceKm');
    const duration = sumByIds(trip.legs ?? {}, day.legIds ?? [], 'durationMinutes');
    if (Number.isFinite(day.distanceKm) && Math.abs(day.distanceKm - distance) > 0.1) diagnostics.error('DAY_DISTANCE_MISMATCH', `/days/${dayId}/distanceKm`, `Expected leg sum ${distance} km (tolerance 0.1 km).`);
    if (Number.isFinite(day.durationMinutes) && Math.abs(day.durationMinutes - duration) > 1) diagnostics.error('DAY_DURATION_MISMATCH', `/days/${dayId}/durationMinutes`, `Expected leg sum ${duration} minutes (tolerance 1 minute).`);
  }

  for (const [legId, leg] of Object.entries(trip.legs ?? {})) {
    if (!trip.days?.[leg.dayId]) diagnostics.error('REFERENCE_BROKEN', `/legs/${legId}/dayId`, `Unknown day ${leg.dayId}.`);
    for (const field of ['fromStopId', 'toStopId']) if (!trip.stops?.[leg[field]]) diagnostics.error('REFERENCE_BROKEN', `/legs/${legId}/${field}`, `Unknown stop ${leg[field]}.`);
    for (const riskId of leg.riskIds ?? []) if (!trip.risks?.[riskId]) diagnostics.error('REFERENCE_BROKEN', `/legs/${legId}/riskIds`, `Unknown risk ${riskId}.`);
    for (const alternativeId of leg.alternativeIds ?? []) if (!trip.alternatives?.[alternativeId]) diagnostics.error('REFERENCE_BROKEN', `/legs/${legId}/alternativeIds`, `Unknown alternative ${alternativeId}.`);
  }
}

function checkRoutes(diagnostics, trip, routes) {
  for (const [routeId, route] of Object.entries(routes)) {
    if (!trip.legs?.[route.legId]) diagnostics.error('REFERENCE_BROKEN', `/routes/${routeId}/legId`, `Unknown leg ${route.legId}.`);
    if (!route.provider) diagnostics.error('ROUTE_SOURCE_MISSING', `/routes/${routeId}/provider`, 'Route provider is required.');
    if (!route.queryTime || Number.isNaN(Date.parse(route.queryTime))) diagnostics.error('ROUTE_QUERY_TIME_INVALID', `/routes/${routeId}/queryTime`, 'A valid route query time is required.');
    if (!['GCJ-02', 'WGS84'].includes(route.coordinateSystem)) diagnostics.error('COORDINATE_SYSTEM_INVALID', `/routes/${routeId}/coordinateSystem`, 'Coordinate system must be GCJ-02 or WGS84.');
    (route.geometry ?? []).forEach((coordinate, index) => checkCoordinates(diagnostics, coordinate, `/routes/${routeId}/geometry/${index}`));
    if (route.elevationsMeters !== null && route.elevationsMeters !== undefined && route.elevationsMeters.length !== route.geometry?.length) diagnostics.error('ELEVATION_ALIGNMENT', `/routes/${routeId}/elevationsMeters`, 'Elevation and geometry arrays must have equal length.');
    const leg = trip.legs?.[route.legId];
    if (leg) {
      const endpointSystems = [trip.stops?.[leg.fromStopId]?.location?.coordinateSystem, trip.stops?.[leg.toStopId]?.location?.coordinateSystem].filter(Boolean);
      if (endpointSystems.some((system) => system !== route.coordinateSystem)) diagnostics.error('COORDINATE_SYSTEM_MIXED', `/routes/${routeId}/coordinateSystem`, 'Route and endpoint coordinate systems must match or be explicitly converted.');
    }
    if (leg && Number.isFinite(leg.distanceKm) && Math.abs(leg.distanceKm - route.distanceKm) > 0.1) diagnostics.error('LEG_ROUTE_DISTANCE_MISMATCH', `/legs/${route.legId}/distanceKm`, 'Leg and route distances differ beyond 0.1 km.');
    if (leg && Number.isFinite(leg.durationMinutes) && Math.abs(leg.durationMinutes - route.durationMinutes) > 1) diagnostics.error('LEG_ROUTE_DURATION_MISMATCH', `/legs/${route.legId}/durationMinutes`, 'Leg and route durations differ beyond 1 minute.');
  }

  for (const [legId, leg] of Object.entries(trip.legs ?? {})) {
    if (leg.routeRef && !routes[leg.routeRef]) diagnostics.error('REFERENCE_BROKEN', `/legs/${legId}/routeRef`, `Unknown route ${leg.routeRef}.`);
  }
}

function checkEvidenceAndRisks(diagnostics, trip, evidence) {
  for (const [evidenceId, item] of Object.entries(evidence)) {
    for (const field of ['source', 'sourceClass', 'collectedAt', 'spatialScope', 'temporalScope', 'claim', 'kind', 'freshness', 'confidence']) {
      if (item[field] === undefined || item[field] === '') diagnostics.error('EVIDENCE_METADATA_MISSING', `/evidence/${evidenceId}/${field}`, `${field} is required.`);
    }
    for (const legId of item.affectedLegIds ?? []) if (!trip.legs?.[legId]) diagnostics.error('REFERENCE_BROKEN', `/evidence/${evidenceId}/affectedLegIds`, `Unknown leg ${legId}.`);
  }

  for (const [riskId, risk] of Object.entries(trip.risks ?? {})) {
    if (!trip.legs?.[risk.legId]) diagnostics.error('REFERENCE_BROKEN', `/risks/${riskId}/legId`, `Unknown leg ${risk.legId}.`);
    for (const field of ['severity', 'confidence', 'coverage', 'status', 'unknowns']) if (risk[field] === undefined) diagnostics.error('RISK_ATTRIBUTE_MISSING', `/risks/${riskId}/${field}`, `${field} must be explicit.`);
    for (const evidenceId of risk.evidenceIds ?? []) if (!evidence[evidenceId]) diagnostics.error('REFERENCE_BROKEN', `/risks/${riskId}/evidenceIds`, `Unknown evidence ${evidenceId}.`);
  }
}

function checkAlternatives(diagnostics, trip) {
  for (const [alternativeId, alternative] of Object.entries(trip.alternatives ?? {})) {
    for (const field of ['triggerRiskId', 'replacedLegIds', 'diversionStartStopId', 'rejoinStopId', 'replacementLegs', 'distanceDeltaKm', 'durationDeltaMinutes', 'verification', 'accepted']) {
      if (alternative[field] === undefined) diagnostics.error('ALTERNATIVE_INCOMPLETE', `/alternatives/${alternativeId}/${field}`, `${field} is required.`);
    }
    if (!trip.risks?.[alternative.triggerRiskId]) diagnostics.error('REFERENCE_BROKEN', `/alternatives/${alternativeId}/triggerRiskId`, `Unknown risk ${alternative.triggerRiskId}.`);
    for (const legId of alternative.replacedLegIds ?? []) if (!trip.legs?.[legId]) diagnostics.error('REFERENCE_BROKEN', `/alternatives/${alternativeId}/replacedLegIds`, `Unknown leg ${legId}.`);
    for (const field of ['diversionStartStopId', 'rejoinStopId']) if (alternative[field] && !trip.stops?.[alternative[field]]) diagnostics.error('REFERENCE_BROKEN', `/alternatives/${alternativeId}/${field}`, `Unknown stop ${alternative[field]}.`);
    if (alternative.verification && !['executable', 'proposed-unverified'].includes(alternative.verification.status)) diagnostics.error('ALTERNATIVE_VERIFICATION_INVALID', `/alternatives/${alternativeId}/verification/status`, 'Verification status must be executable or proposed-unverified.');
    if (alternative.verification?.status === 'executable' && (!alternative.verification.provider || !alternative.verification.queryTime)) diagnostics.error('ALTERNATIVE_UNVERIFIED', `/alternatives/${alternativeId}/verification`, 'Executable alternatives require provider and query time.');
  }
}

function checkVersionsAndGate(diagnostics, trip, snapshots) {
  const currentRevision = trip.trip?.revision;
  if (!trip.revisions?.some(({ id }) => id === currentRevision)) diagnostics.error('REVISION_UNKNOWN', '/trip/revision', 'Current revision is absent from revisions.');
  if (trip.artifactRevision !== null && trip.artifactRevision !== undefined && trip.artifactRevision !== currentRevision) diagnostics.error('ARTIFACT_REVISION_STALE', '/artifactRevision', 'Artifacts do not represent the current trip revision.');
  const snapshotRef = trip.assessment?.snapshotRef;
  if (snapshotRef) {
    const snapshot = snapshots[snapshotRef];
    if (!snapshot) diagnostics.error('REFERENCE_BROKEN', '/assessment/snapshotRef', `Unknown assessment snapshot ${snapshotRef}.`);
    else {
      if (snapshot.ruleVersion !== trip.assessment.ruleVersion) diagnostics.error('ASSESSMENT_VERSION_MISMATCH', '/assessment/ruleVersion', 'Current assessment rule version differs from its snapshot.');
      if (snapshot.tripId !== trip.trip?.id || snapshot.tripRevision !== currentRevision) diagnostics.error('SNAPSHOT_CONTEXT_MISMATCH', '/assessment/snapshotRef', 'Assessment snapshot belongs to a different trip or revision.');
    }
  }
  if (!GATES.includes(trip.assessment?.gate)) diagnostics.error('GATE_INVALID', '/assessment/gate', 'Unknown execution gate.');
  if (trip.assessment?.gate === 'passed') {
    const critical = ['fetch_route', 'fetch_weather', 'fetch_traffic_events'];
    if (critical.some((name) => !['available', 'limited'].includes(trip.capabilities?.[name]?.status))) diagnostics.error('CLEAN_PASS_UNSUPPORTED', '/assessment/gate', 'A clean pass requires usable critical capabilities.');
    if (Object.values(trip.risks ?? {}).some(({ severity, status }) => severity === 'blocking' && status !== 'resolved')) diagnostics.error('CLEAN_PASS_BLOCKED', '/assessment/gate', 'An unresolved blocking finding prevents a clean pass.');
  }
}

export function validateTrip(trip, { routes = {}, evidence = {}, snapshots = {} } = {}) {
  const diagnostics = new Diagnostics();
  if (!isObject(trip)) {
    diagnostics.error('STRUCTURE_TYPE', '/', 'Trip must be a JSON object.');
    return diagnostics.toJSON();
  }
  for (const field of REQUIRED_TOP_LEVEL) if (!Object.hasOwn(trip, field)) diagnostics.error('REQUIRED_FIELD', `/${field}`, 'Required top-level field is missing.');
  checkStableId(diagnostics, trip.trip?.id, '/trip/id');
  checkStableId(diagnostics, trip.trip?.revision, '/trip/revision');
  for (const [index, revision] of (trip.revisions ?? []).entries()) {
    checkStableId(diagnostics, revision.id, `/revisions/${index}/id`);
    checkStableId(diagnostics, revision.parentId, `/revisions/${index}/parentId`);
  }
  for (const path of ['/days', '/stops', '/legs', '/risks', '/alternatives']) checkEntityMap(diagnostics, trip[path.slice(1)], path);
  walk(trip, '', (value, path) => {
    if (typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim())) diagnostics.error('PLACEHOLDER_ILLEGAL', path || '/', 'Use null plus an unknown record instead of a placeholder.');
    const key = path.split('/').at(-1) ?? '';
    if (SENSITIVE_KEY_PATTERN.test(key)) diagnostics.error('SENSITIVE_FIELD', path, 'Sensitive fields must not be persisted.');
  });
  for (const [stopId, stop] of Object.entries(trip.stops ?? {})) checkCoordinates(diagnostics, stop.location, `/stops/${stopId}/location`, { requireCoordinateSystem: true });
  checkReferencesAndTotals(diagnostics, trip);
  checkRoutes(diagnostics, trip, routes);
  checkEvidenceAndRisks(diagnostics, trip, evidence);
  checkAlternatives(diagnostics, trip);
  checkVersionsAndGate(diagnostics, trip, snapshots);
  return diagnostics.toJSON();
}