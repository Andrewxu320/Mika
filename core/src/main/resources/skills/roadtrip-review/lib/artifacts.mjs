import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const SENSITIVE_KEY = /(?:phone|mobile|identity|passport|booking|plate|password|secret|credential|access.?token|home.?address)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._-]+|(?:api[_-]?key|token|secret)\s*[:=]\s*\S+)/i;

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readEntities(path) {
  try {
    const files = (await readdir(path)).filter((file) => extname(file) === '.json');
    return Object.fromEntries(await Promise.all(files.map(async (file) => {
      const entity = await readJson(join(path, file));
      return [entity.id ?? basename(file, '.json'), entity];
    })));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function loadTripDirectory(root) {
  // 快照也读:评估里的 snapshotRef 要对着 snapshots/ 里的那一份核;少读一处,校验和渲染就会给出不同结论
  const [trip, routes, evidence, snapshots] = await Promise.all([
    readJson(join(root, 'trip.json')),
    readEntities(join(root, 'routes')),
    readEntities(join(root, 'evidence')),
    readEntities(join(root, 'snapshots'))
  ]);
  return { root, trip, routes, evidence, snapshots };
}

export function artifactMetadata(trip, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: trip.schemaVersion,
    tripRevision: trip.trip.revision,
    ruleVersion: trip.assessment.ruleVersion,
    generatedAt
  };
}

export function escapeMarkdown(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replace(/([`*_{}\[\]()#+.!|>-])/g, '\\$1');
}

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function redactSensitive(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && SECRET_VALUE.test(value)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]));
  return value;
}

export async function writeText(path, content) {
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

export async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}