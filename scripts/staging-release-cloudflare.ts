import { isAbsolute, relative, resolve } from 'node:path';

import { STAGING_TARGET } from './staging-release-contract.ts';

type CommonInput = {
  readonly root: string;
  readonly wrangler: string;
  readonly config: string;
};

export type CloudflareCommandInput = CommonInput & (
  | { readonly id: 'd1-execute'; readonly inputPath: string }
  | { readonly id: 'deploy'; readonly candidateSha: string }
  | { readonly id: 'r2-put'; readonly objectSuffix: string; readonly inputPath: string }
  | { readonly id: 'r2-get'; readonly objectSuffix: string; readonly outputPath: string }
  | { readonly id: 'worker-delete' }
  | { readonly id: 'workflow-delete'; readonly workflowName: string }
  | { readonly id: 'd1-delete' }
  | { readonly id: 'r2-delete' }
  | { readonly id: 'deployments-status' }
  | { readonly id: 'versions-list' }
);

export interface Task11CloudflareCommand {
  readonly id: CloudflareCommandInput['id'];
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
}

function safeObjectSuffix(value: string): string {
  if (value.length === 0 || value.length > 768 || value.startsWith('/') || value.endsWith('/')
    || value.includes('\\')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Task 11 R2 object suffix is invalid.');
  }
  return value;
}

function configArgs(config: string): string[] {
  return ['--config', config];
}

export function buildCloudflareCommand(input: CloudflareCommandInput): Task11CloudflareCommand {
  const prefix = [input.wrangler];
  let args: string[];
  switch (input.id) {
    case 'd1-execute':
      args = [
        ...prefix, 'd1', 'execute', STAGING_TARGET.databaseName, '--remote',
        ...configArgs(input.config), '--json', '--file', input.inputPath,
      ];
      break;
    case 'deploy':
      if (!/^[0-9a-f]{40}$/u.test(input.candidateSha)) {
        throw new Error('Task 11 deploy candidate SHA is invalid.');
      }
      args = [...prefix, 'deploy', ...configArgs(input.config), '--strict', '--tag', input.candidateSha];
      break;
    case 'r2-put':
      args = [
        ...prefix, 'r2', 'object', 'put',
        `${STAGING_TARGET.bucketName}/${safeObjectSuffix(input.objectSuffix)}`,
        '--remote', ...configArgs(input.config), '--file', input.inputPath,
      ];
      break;
    case 'r2-get':
      args = [
        ...prefix, 'r2', 'object', 'get',
        `${STAGING_TARGET.bucketName}/${safeObjectSuffix(input.objectSuffix)}`,
        '--remote', ...configArgs(input.config), '--file', input.outputPath,
      ];
      break;
    case 'worker-delete':
      args = [...prefix, 'delete', STAGING_TARGET.workerName, ...configArgs(input.config), '--force'];
      break;
    case 'workflow-delete':
      if (!Object.values(STAGING_TARGET.workflows).includes(input.workflowName as never)) {
        throw new Error('Task 11 Workflow delete target is not approved.');
      }
      args = [...prefix, 'workflows', 'delete', input.workflowName, ...configArgs(input.config)];
      break;
    case 'd1-delete':
      args = [
        ...prefix, 'd1', 'delete', STAGING_TARGET.databaseName,
        ...configArgs(input.config), '--skip-confirmation',
      ];
      break;
    case 'r2-delete':
      args = [...prefix, 'r2', 'bucket', 'delete', STAGING_TARGET.bucketName, ...configArgs(input.config)];
      break;
    case 'deployments-status':
      args = [
        ...prefix, 'deployments', 'status', '--name', STAGING_TARGET.workerName,
        ...configArgs(input.config), '--json',
      ];
      break;
    case 'versions-list':
      args = [
        ...prefix, 'versions', 'list', '--name', STAGING_TARGET.workerName,
        ...configArgs(input.config), '--json',
      ];
      break;
  }
  return assertSafeCloudflareCommand({
    id: input.id,
    executable: process.execPath,
    args,
    cwd: resolve(input.root),
    shell: false,
  }, input.root);
}

function within(container: string, target: string): boolean {
  const candidate = relative(resolve(container), resolve(target));
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

const PRODUCTION_IDENTITIES = new Set([
  'candidary',
  'candidary-core',
  'candidary-media',
  'candidary-export',
  'candidary-cover-render',
  'candidary-cover-backfill',
]);

export function assertSafeCloudflareCommand(
  value: Task11CloudflareCommand,
  ownedRoot: string,
): Task11CloudflareCommand {
  if (value.executable !== process.execPath) {
    throw new Error('Task 11 Cloudflare command must use the pinned Node executable.');
  }
  if (value.shell !== false) throw new Error('Task 11 Cloudflare command cannot use a shell.');
  if (!within(ownedRoot, value.cwd)) throw new Error('Task 11 command cwd escapes the owned root.');
  if (!Array.isArray(value.args) || value.args.length < 2
    || typeof value.args[0] !== 'string'
    || !/[/\\]node_modules[/\\]wrangler[/\\]bin[/\\]wrangler\.js$/iu.test(value.args[0])) {
    throw new Error('Task 11 command does not use the candidate-pinned Wrangler module.');
  }
  if (value.args.some((argument) => argument === 'npx')) {
    throw new Error('Task 11 command cannot use npx.');
  }
  if (value.args.some((argument) => PRODUCTION_IDENTITIES.has(argument))) {
    throw new Error('Task 11 command contains a production identity.');
  }
  const joined = value.args.join(' ');
  if (/\bd1\s+migrations\s+apply\b/iu.test(joined)) {
    throw new Error('Task 11 command cannot use migrations apply.');
  }
  const configIndex = value.args.indexOf('--config');
  if (configIndex < 0 || typeof value.args[configIndex + 1] !== 'string'
    || !within(ownedRoot, value.args[configIndex + 1]!)) {
    throw new Error('Task 11 command config is missing or outside the owned root.');
  }
  for (const flag of ['--file']) {
    let index = value.args.indexOf(flag);
    while (index >= 0) {
      const path = value.args[index + 1];
      if (!path || !within(ownedRoot, path)) {
        throw new Error(`Task 11 command ${flag} path escapes the owned root.`);
      }
      index = value.args.indexOf(flag, index + 1);
    }
  }
  return value;
}
