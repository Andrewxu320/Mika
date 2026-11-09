export const WORKFLOW_STATES = ['drafted', 'awaiting-confirmation', 'confirmed', 'researched', 'assessed', 'alternatives-reviewed', 'validated', 'rendered'];

const REFERENCES_BY_STATE = {
  drafted: ['references/ingestion-policy.md'],
  'awaiting-confirmation': ['references/ingestion-policy.md'],
  confirmed: ['references/capability-policy.md'],
  researched: ['references/evidence-policy.md'],
  assessed: ['references/risk-policy.md'],
  'alternatives-reviewed': ['references/alternative-policy.md'],
  validated: [],
  rendered: []
};

const PROFILE_RESULTS = {
  standard: {
    disclosure: 'Provider coverage, query times, and remaining evidence gaps are disclosed.',
    roadGeometry: 'verified',
    staticWorkCompleted: true
  },
  'search-only': {
    disclosure: 'Geometry, distance, duration, and current-condition completeness remain unverified.',
    roadGeometry: 'unavailable',
    staticWorkCompleted: true
  },
  offline: {
    disclosure: 'Current road and weather were not checked; structure and static planning checks completed.',
    roadGeometry: 'unavailable',
    staticWorkCompleted: true
  }
};

export function dryRunWorkflow(profile) {
  const profileResult = PROFILE_RESULTS[profile];
  if (!profileResult) throw new Error(`Unknown operation profile: ${profile}`);
  return {
    profile,
    states: WORKFLOW_STATES.map((state) => ({ state, references: REFERENCES_BY_STATE[state] })),
    finalState: 'rendered',
    ...profileResult
  };
}