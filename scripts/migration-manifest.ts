import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface HashedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MigrationManifest {
  files: HashedFile[];
  sha256: string;
}

export interface MigrationVerification {
  migrationCount: number;
  ledgerSha256: string;
  foreignKeyRows: 0;
  integrity: 'ok';
  terminalSchema: {
    events: true;
    rosterBatchReceipts: true;
    releaseCertifications: true;
  };
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON requires JSON values');
  if (ancestors.has(value)) throw new TypeError('canonical JSON cannot contain cycles');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError('canonical JSON requires dense arrays without extra keys');
      }
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Object.getOwnPropertySymbols(value).length > 0
        || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError('canonical JSON requires plain arrays');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const items = keys.map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError('canonical JSON does not invoke array accessors');
        }
        return canonicalValue(descriptor.value, ancestors);
      });
      return `[${items.join(',')}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('canonical JSON requires plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON does not accept symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort(lexicalCompare);
    if (keys.length !== Reflect.ownKeys(value).length) {
      throw new TypeError('canonical JSON requires enumerable string keys');
    }
    const fields = keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError('canonical JSON does not invoke accessors');
      }
      return `${JSON.stringify(key)}:${canonicalValue(descriptor.value, ancestors)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set<object>());
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function assertRealContainment(container: string, target: string, field: string): void {
  if (!within(realpathSync(container), realpathSync(target))) {
    throw new Error(`${field} escapes its approved root`);
  }
}

function assertDirectoryChainHasNoLinks(base: string, target: string, field: string): void {
  const path = relative(resolve(base), resolve(target));
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${field} is not a child directory`);
  }
  let current = resolve(base);
  for (const component of path.split(sep)) {
    current = resolve(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${field} contains a linked or non-directory component`);
    }
  }
}

function logicalPath(root: string, target: string): string {
  const path = relative(resolve(root), resolve(target)).replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || path.includes('\0')) {
    throw new Error('migration path escapes its repository root');
  }
  return path;
}

function canonicalMigrationBytes(target: string): Buffer {
  const source = readFileSync(target);
  const canonical = Buffer.allocUnsafe(source.byteLength);
  let outputIndex = 0;
  for (let sourceIndex = 0; sourceIndex < source.byteLength; sourceIndex += 1) {
    if (source[sourceIndex] === 0x0d && source[sourceIndex + 1] === 0x0a) continue;
    canonical[outputIndex] = source[sourceIndex]!;
    outputIndex += 1;
  }
  return canonical.subarray(0, outputIndex);
}

function hashedMigrationFile(root: string, target: string): HashedFile {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('migrations must be regular files');
  const bytes = canonicalMigrationBytes(target);
  return { path: logicalPath(root, target), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function collectMigrationManifest(root: string): MigrationManifest {
  const resolvedRoot = resolve(root);
  const migrationRoot = resolve(resolvedRoot, 'migrations');
  assertDirectoryChainHasNoLinks(resolvedRoot, migrationRoot, 'migration directory');
  assertRealContainment(resolvedRoot, migrationRoot, 'migration directory');
  const entries = readdirSync(migrationRoot, { withFileTypes: true });
  if (entries.length === 0) throw new Error('migration inventory is empty');

  const discovered = entries.map((entry) => {
    const match = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match) {
      throw new Error(`invalid migration entry: ${entry.name}`);
    }
    return { entry, number: Number.parseInt(match[1]!, 10) };
  }).sort((left, right) =>
    left.number - right.number || lexicalCompare(left.entry.name, right.entry.name));

  for (const [index, item] of discovered.entries()) {
    if (item.number !== index + 1) {
      throw new Error('migration sequence must begin at 0001 and be gap-free');
    }
  }

  const files = discovered.map(({ entry }) => {
    const target = resolve(migrationRoot, entry.name);
    assertRealContainment(migrationRoot, target, 'migration');
    return hashedMigrationFile(resolvedRoot, target);
  });
  return {
    files,
    sha256: sha256(canonicalJson(files.map(({ path, sha256: digest }) => ({ path, sha256: digest })))),
  };
}
