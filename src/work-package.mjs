import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statfsSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, sha256 } from './crypto.mjs';

export const WORK_PACKAGE_SCHEMA_VERSION = 1;
export const WORK_PACKAGE_CAPABILITY = 'work.package';
export const WORK_PACKAGE_EXTENSION = 'https://dsh-a2a.dev/extensions/work-package/v1';
export const WORK_PACKAGE_CHUNK_BYTES = 96 * 1024;
export const MAX_WORK_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_WORK_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_WORK_PACKAGE_FILES = 1024;
export const MAX_WORK_PATH_BYTES = 512;
export const MAX_WORK_PATH_DEPTH = 16;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const mediaType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const strictBase64 = /^[A-Za-z0-9+/]*={0,2}$/;
const manifestFields = new Set([
  'schemaVersion', 'packageId', 'kind', 'taskId', 'title', 'instructions',
  'createdAt', 'fileCount', 'totalBytes', 'files', 'manifestHash',
]);
const fileFields = new Set(['path', 'byteLength', 'sha256', 'mediaType', 'chunkCount']);
const chunkFields = new Set([
  'schemaVersion', 'packageId', 'taskId', 'path', 'chunkIndex', 'chunkCount',
  'byteLength', 'sha256', 'data',
]);

function fail(code) { throw new Error(code); }

export function validateWorkPath(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > MAX_WORK_PATH_BYTES) fail('work_path_invalid');
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) fail('work_path_unsafe');
  const parts = value.split('/');
  if (parts.length > MAX_WORK_PATH_DEPTH || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('work_path_unsafe');
  return value;
}

function inferMediaType(path) {
  const extension = path.toLowerCase().split('.').pop();
  return ({
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/typescript',
    json: 'application/json', md: 'text/markdown', txt: 'text/plain', html: 'text/html',
    css: 'text/css', py: 'text/x-python', sh: 'text/x-shellscript', yaml: 'application/yaml',
    yml: 'application/yaml', xml: 'application/xml', csv: 'text/csv', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf',
  })[extension] ?? 'application/octet-stream';
}

function collectRegularFiles(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath) fail('work_source_required');
  const root = resolve(sourcePath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) fail('work_symlink_rejected');
  const records = [];
  const walk = (absolutePath, relativePath) => {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail('work_symlink_rejected');
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort((a, b) => a.localeCompare(b, 'en'))) {
        walk(join(absolutePath, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) fail('work_non_regular_rejected');
    const path = validateWorkPath(relativePath || basename(root));
    if (stat.size > MAX_WORK_FILE_BYTES) fail('work_file_too_large');
    records.push({ absolutePath, path, size: stat.size });
    if (records.length > MAX_WORK_PACKAGE_FILES) fail('work_too_many_files');
  };
  walk(root, rootStat.isDirectory() ? '' : basename(root));
  return records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function manifestWithoutHash(manifest) {
  const { manifestHash, ...unsigned } = manifest;
  return unsigned;
}

export function validateWorkPackageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('work_manifest_invalid');
  if (Object.keys(manifest).some((key) => !manifestFields.has(key))) fail('work_manifest_unknown_field');
  for (const field of manifestFields) if (!(field in manifest)) fail(`work_manifest_missing_${field}`);
  if (manifest.schemaVersion !== WORK_PACKAGE_SCHEMA_VERSION) fail('work_schema_unsupported');
  if (!uuid.test(manifest.packageId) || !uuid.test(manifest.taskId)) fail('work_id_invalid');
  if (!['request', 'result'].includes(manifest.kind)) fail('work_kind_invalid');
  if (typeof manifest.title !== 'string' || manifest.title.length < 1 || manifest.title.length > 200) fail('work_title_invalid');
  if (typeof manifest.instructions !== 'string' || Buffer.byteLength(manifest.instructions) > 32_768) fail('work_instructions_too_large');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) fail('work_created_at_invalid');
  if (!Number.isInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > MAX_WORK_PACKAGE_FILES) fail('work_file_count_invalid');
  if (!Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_WORK_PACKAGE_BYTES) fail('work_total_too_large');
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) fail('work_files_invalid');
  let total = 0;
  const paths = new Set();
  const folded = new Set();
  let previous = null;
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some((key) => !fileFields.has(key))) fail('work_file_invalid');
    for (const field of fileFields) if (!(field in file)) fail(`work_file_missing_${field}`);
    validateWorkPath(file.path);
    const fold = file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (paths.has(file.path) || folded.has(fold)) fail('work_path_collision');
    if (previous !== null && previous.localeCompare(file.path, 'en') >= 0) fail('work_files_not_sorted');
    paths.add(file.path); folded.add(fold); previous = file.path;
    if (!Number.isInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > MAX_WORK_FILE_BYTES) fail('work_file_length_invalid');
    if (!digest.test(file.sha256)) fail('work_file_hash_invalid');
    if (typeof file.mediaType !== 'string' || !mediaType.test(file.mediaType)) fail('work_file_media_type_invalid');
    const expectedChunks = Math.ceil(file.byteLength / WORK_PACKAGE_CHUNK_BYTES);
    if (!Number.isInteger(file.chunkCount) || file.chunkCount !== expectedChunks) fail('work_chunk_count_invalid');
    total += file.byteLength;
  }
  if (total !== manifest.totalBytes) fail('work_total_mismatch');
  if (!digest.test(manifest.manifestHash) || sha256(canonical(manifestWithoutHash(manifest))) !== manifest.manifestHash) fail('work_manifest_hash_mismatch');
  return true;
}

export function validateWorkPackageChunk(chunk, manifest) {
  validateWorkPackageManifest(manifest);
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || Object.keys(chunk).some((key) => !chunkFields.has(key))) fail('work_chunk_invalid');
  for (const field of chunkFields) if (!(field in chunk)) fail(`work_chunk_missing_${field}`);
  if (chunk.schemaVersion !== WORK_PACKAGE_SCHEMA_VERSION || chunk.packageId !== manifest.packageId || chunk.taskId !== manifest.taskId) fail('work_chunk_binding_invalid');
  validateWorkPath(chunk.path);
  const file = manifest.files.find((entry) => entry.path === chunk.path);
  if (!file) fail('work_chunk_undeclared_file');
  if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= file.chunkCount || chunk.chunkCount !== file.chunkCount) fail('work_chunk_index_invalid');
  if (typeof chunk.data !== 'string' || chunk.data.length % 4 !== 0 || !strictBase64.test(chunk.data)) fail('work_chunk_data_invalid');
  const bytes = Buffer.from(chunk.data, 'base64');
  const expectedLength = chunk.chunkIndex === file.chunkCount - 1
    ? file.byteLength - WORK_PACKAGE_CHUNK_BYTES * chunk.chunkIndex
    : WORK_PACKAGE_CHUNK_BYTES;
  if (!Number.isInteger(chunk.byteLength) || bytes.length !== chunk.byteLength || bytes.length !== expectedLength || bytes.length > WORK_PACKAGE_CHUNK_BYTES) fail('work_chunk_length_invalid');
  if (!digest.test(chunk.sha256) || sha256(bytes) !== chunk.sha256) fail('work_chunk_hash_mismatch');
  return bytes;
}

export function prepareWorkPackage({ sourcePath, kind = 'request', taskId = randomUUID(), title, instructions = '', packageId = randomUUID(), createdAt = new Date().toISOString() }) {
  const records = sourcePath ? collectRegularFiles(sourcePath) : [];
  const chunks = [];
  let totalBytes = 0;
  const files = records.map((record) => {
    const bytes = readFileSync(record.absolutePath);
    totalBytes += bytes.length;
    if (totalBytes > MAX_WORK_PACKAGE_BYTES) fail('work_total_too_large');
    const chunkCount = Math.ceil(bytes.length / WORK_PACKAGE_CHUNK_BYTES);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const data = bytes.subarray(chunkIndex * WORK_PACKAGE_CHUNK_BYTES, (chunkIndex + 1) * WORK_PACKAGE_CHUNK_BYTES);
      chunks.push({
        schemaVersion: WORK_PACKAGE_SCHEMA_VERSION, packageId, taskId, path: record.path,
        chunkIndex, chunkCount, byteLength: data.length, sha256: sha256(data), data: data.toString('base64'),
      });
    }
    return { path: record.path, byteLength: bytes.length, sha256: sha256(bytes), mediaType: inferMediaType(record.path), chunkCount };
  });
  const unsigned = {
    schemaVersion: WORK_PACKAGE_SCHEMA_VERSION, packageId, kind, taskId, title,
    instructions, createdAt, fileCount: files.length, totalBytes, files,
  };
  const manifest = { ...unsigned, manifestHash: sha256(canonical(unsigned)) };
  validateWorkPackageManifest(manifest);
  for (const chunk of chunks) validateWorkPackageChunk(chunk, manifest);
  return { manifest, chunks };
}

function chunkPayload(row) {
  if (row.data !== undefined) return row;
  return {
    schemaVersion: WORK_PACKAGE_SCHEMA_VERSION,
    packageId: row.package_id,
    taskId: row.task_id,
    path: row.file_path,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    byteLength: row.byte_length,
    sha256: row.digest,
    data: Buffer.from(row.data_blob).toString('base64'),
  };
}

export function materializeWorkPackage(manifest, storedChunks, targetRoot) {
  validateWorkPackageManifest(manifest);
  const root = resolve(targetRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const available = statfsSync(root);
  if (Number(available.bavail) * Number(available.bsize) < manifest.totalBytes + 1_048_576) fail('work_insufficient_disk');
  const finalPath = join(root, manifest.packageId);
  if (existsSync(finalPath)) fail('work_destination_exists');
  const staging = join(root, `.${manifest.packageId}.${randomUUID()}.tmp`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const byFile = new Map();
    for (const row of storedChunks) {
      const chunk = chunkPayload(row);
      const bytes = validateWorkPackageChunk(chunk, manifest);
      const fileChunks = byFile.get(chunk.path) ?? [];
      if (fileChunks[chunk.chunkIndex]) fail('work_duplicate_chunk');
      fileChunks[chunk.chunkIndex] = bytes;
      byFile.set(chunk.path, fileChunks);
    }
    for (const file of manifest.files) {
      const fileChunks = byFile.get(file.path) ?? [];
      if (fileChunks.length !== file.chunkCount || fileChunks.some((item) => !item)) fail('work_package_incomplete');
      const bytes = Buffer.concat(fileChunks);
      if (bytes.length !== file.byteLength || sha256(bytes) !== file.sha256) fail('work_file_hash_mismatch');
      const destination = resolve(staging, ...file.path.split('/'));
      if (relative(staging, destination).startsWith(`..${sep}`) || destination === staging) fail('work_path_escape');
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    renameSync(staging, finalPath);
    return finalPath;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function workPackageDestination(manifest, targetRoot) {
  validateWorkPackageManifest(manifest);
  return join(resolve(targetRoot), manifest.packageId);
}

export function verifyMaterializedWorkPackage(manifest, destination) {
  validateWorkPackageManifest(manifest);
  const records = collectRegularFiles(resolve(destination));
  if (records.length !== manifest.files.length) fail('work_materialized_file_count_mismatch');
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = records[index];
    if (actual.path !== expected.path || actual.size !== expected.byteLength
      || sha256(readFileSync(actual.absolutePath)) !== expected.sha256) {
      fail('work_materialized_content_mismatch');
    }
  }
  return true;
}

export function cleanupWorkPackageStaging(manifest, targetRoot) {
  validateWorkPackageManifest(manifest);
  const root = resolve(targetRoot);
  if (!existsSync(root)) return 0;
  const prefix = `.${manifest.packageId}.`;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
