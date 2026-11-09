const GATE_PRIORITY = [
  'passed',
  'executable-with-monitoring',
  'insufficient-evidence',
  'modification-required',
  'not-executable'
];

export function aggregateGate(legGates) {
  let strongest = 'passed';
  for (const gate of legGates) {
    if (!GATE_PRIORITY.includes(gate)) throw new Error(`Unknown execution gate: ${gate}`);
    if (GATE_PRIORITY.indexOf(gate) > GATE_PRIORITY.indexOf(strongest)) strongest = gate;
  }
  return strongest;
}