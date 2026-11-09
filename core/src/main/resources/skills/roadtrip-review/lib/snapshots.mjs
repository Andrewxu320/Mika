const SEVERITY = { information: 0, attention: 1, blocking: 2 };

export function selectLegIds(trip, scope) {
  if (scope.kind === 'whole-trip') return Object.keys(trip.legs);
  if (scope.kind === 'selected-day') return [...(trip.days[scope.ids[0]]?.legIds ?? [])];
  if (scope.kind === 'upcoming-legs') return scope.ids.filter((id) => Object.hasOwn(trip.legs, id));
  throw new Error(`Unknown reassessment scope: ${scope.kind}`);
}

export function createSnapshot(trip, scope, { id, createdAt, previousSnapshot = null } = {}) {
  const legIds = selectLegIds(trip, scope);
  const selected = new Set(legIds);
  const currentFindings = structuredClone(Object.fromEntries(Object.entries(trip.risks).filter(([, finding]) => selected.has(finding.legId))));
  const preservedFindings = previousSnapshot
    ? structuredClone(Object.fromEntries(Object.entries(previousSnapshot.findings).filter(([, finding]) => !selected.has(finding.legId))))
    : {};
  const evidenceIds = new Set([
    ...(previousSnapshot?.evidenceIds ?? []),
    ...Object.values(currentFindings).flatMap(({ evidenceIds = [] }) => evidenceIds)
  ]);
  return {
    schemaVersion: trip.schemaVersion,
    id,
    tripId: trip.trip.id,
    tripRevision: trip.trip.revision,
    createdAt,
    ruleVersion: trip.assessment.ruleVersion,
    scope: { kind: scope.kind, ids: scope.ids },
    capabilities: structuredClone(trip.capabilities),
    evidenceIds: [...evidenceIds],
    findings: { ...preservedFindings, ...currentFindings },
    gate: trip.assessment.gate
  };
}

function category(previous, current, now) {
  if (!previous) return 'new';
  if (!current) return previous.expiresAt && Date.parse(previous.expiresAt) <= Date.parse(now) ? 'expired' : 'resolved';
  if ((previous.evidenceIds?.length ?? 0) > 0 && (current.evidenceIds?.length ?? 0) === 0 && current.coverage === 'unknown') return 'newly-unknown';
  const before = SEVERITY[previous.severity] ?? 0;
  const after = SEVERITY[current.severity] ?? 0;
  if (after > before) return 'escalated';
  if (after < before) return 'reduced';
  return 'unchanged';
}

export function diffSnapshots(previous, current, { now = current.createdAt } = {}) {
  const ids = new Set([...Object.keys(previous.findings), ...Object.keys(current.findings)]);
  const changes = [...ids].map((id) => ({
    id,
    category: category(previous.findings[id], current.findings[id], now),
    legId: current.findings[id]?.legId ?? previous.findings[id]?.legId,
    previous: previous.findings[id] ?? null,
    current: current.findings[id] ?? null
  }));
  return {
    previousSnapshotId: previous.id,
    currentSnapshotId: current.id,
    changes,
    actionRequired: changes.filter(({ category, current: finding }) => ['new', 'escalated', 'newly-unknown'].includes(category) || finding?.severity === 'blocking').map(({ id }) => id)
  };
}