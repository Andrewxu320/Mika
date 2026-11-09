export class Diagnostics {
  #items = [];

  add(code, path, message, severity = 'error') {
    this.#items.push({ code, path, severity, message });
  }

  error(code, path, message) {
    this.add(code, path, message, 'error');
  }

  warning(code, path, message) {
    this.add(code, path, message, 'warning');
  }

  get items() {
    return [...this.#items];
  }

  get hasErrors() {
    return this.#items.some(({ severity }) => severity === 'error');
  }

  toJSON() {
    return {
      valid: !this.hasErrors,
      errorCount: this.#items.filter(({ severity }) => severity === 'error').length,
      warningCount: this.#items.filter(({ severity }) => severity === 'warning').length,
      diagnostics: this.items
    };
  }
}

export function formatDiagnostics(result) {
  if (result.diagnostics.length === 0) return 'Trip validation passed.';
  return result.diagnostics
    .map(({ severity, code, path, message }) => `${severity.toUpperCase()} ${code} ${path}: ${message}`)
    .join('\n');
}