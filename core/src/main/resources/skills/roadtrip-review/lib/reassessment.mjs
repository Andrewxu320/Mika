import { diffSnapshots } from './snapshots.mjs';

export function orchestrateReassessment(trip, previousSnapshot, currentSnapshot, { proposeAlternative } = {}) {
  const diff = diffSnapshots(previousSnapshot, currentSnapshot);
  const proposedAlternatives = diff.changes
    .filter(({ category, current }) => current?.severity === 'blocking' && ['new', 'escalated'].includes(category))
    .map((change) => proposeAlternative?.(change, structuredClone(trip)))
    .filter(Boolean);
  return { diff, proposedAlternatives };
}