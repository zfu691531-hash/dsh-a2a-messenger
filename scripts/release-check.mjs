import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  'README.md', 'README.zh-CN.md', 'LICENSE', 'SECURITY.md', 'ARCHITECTURE.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'package.json',
  'package-lock.json', 'schemas/envelope.schema.json', 'schemas/work-package.schema.json', 'docs/PROTOCOL.md',
  'docs/THREAT_MODEL.md', 'docs/VALIDATION.md', 'examples/config.example.json', 'scripts/install.sh',
  'scripts/uninstall.sh', 'docs/adr/0004-work-package-and-http-relay.md',
  'examples/relay-credentials.example.json',
];
const failures = [];
for (const file of required) if (!existsSync(join(root, file))) failures.push(`missing:${file}`);

const excluded = new Set(['.git', '.codex', 'node_modules', 'coverage', '.a2a']);
const textExtensions = new Set(['.md', '.mjs', '.json', '.yml', '.yaml', '.sh', '.txt']);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|github_pat|sk-proj)-[A-Za-z0-9_\-]{16,}\b/,
  /\/Users\/[A-Za-z0-9._-]+\//,
];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (excluded.has(entry)) continue;
    const path = join(dir, entry);
    if (relative(root, path) === 'relay-credentials.json') {
      failures.push('sensitive-file:relay-credentials.json');
      continue;
    }
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if ([...textExtensions].some((extension) => path.endsWith(extension))) {
      const text = readFileSync(path, 'utf8');
      for (const pattern of secretPatterns) if (pattern.test(text)) failures.push(`sensitive-pattern:${relative(root, path)}:${pattern}`);
    }
  }
}
walk(root);

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '0.2.0') failures.push('version:not-0.2.0');
  if (pkg.license !== 'MIT') failures.push('license:not-MIT');
  if (pkg.engines?.node !== '>=22.13.0') failures.push('engines:not->=22.13.0');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) failures.push(`runtime-node-too-old:${process.versions.node}`);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const thirdParty = Object.entries(lock.packages ?? {}).filter(([name]) => name && name.startsWith('node_modules/'));
  if (thirdParty.length) failures.push(`dependency-license-review-required:${thirdParty.map(([name]) => name).join(',')}`);
} catch (error) { failures.push(`metadata:${error.message}`); }

const result = { ok: failures.length === 0, version: '0.2.0', checks: { requiredFiles: required.length, sensitivePatterns: secretPatterns.length, thirdPartyRuntimeDependencies: 0 }, failures };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
