export const WORKFLOW_CODE_FIELDS = [
  'code',
  'errorCode',
  'status',
  'statusCode',
] as const;

export type WorkflowCodeField = typeof WORKFLOW_CODE_FIELDS[number];
export type WorkflowCodeValue = string | number;

export interface WorkflowCodeObservation {
  readonly field: WorkflowCodeField;
  readonly value: WorkflowCodeValue;
}

export interface WorkflowErrorFingerprint {
  readonly constructorFamily: 'Error' | 'Object' | 'primitive' | 'null';
  readonly name: string | null;
  readonly codeFields: readonly WorkflowCodeObservation[];
  readonly ownKeys: readonly string[];
}

export interface WorkflowProbeSamples {
  readonly absent: readonly WorkflowErrorFingerprint[];
  readonly invalid: readonly WorkflowErrorFingerprint[];
  readonly synthetic: readonly WorkflowErrorFingerprint[];
}

export interface CertifiedWorkflowMissingDiscriminator {
  readonly field: WorkflowCodeField;
  readonly value: WorkflowCodeValue;
}

export type WorkflowFingerprintBlockerCode =
  | 'NO_DISTINCT_WORKFLOW_MISSING_DISCRIMINATOR'
  | 'AMBIGUOUS_WORKFLOW_MISSING_DISCRIMINATOR';

export class WorkflowFingerprintQualificationError extends Error {
  constructor(readonly blockerCode: WorkflowFingerprintBlockerCode) {
    super(blockerCode);
    this.name = 'WorkflowFingerprintQualificationError';
  }
}

const CLOSED_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const CLOSED_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u;

function constructorFamily(value: unknown): WorkflowErrorFingerprint['constructorFamily'] {
  if (value === null) return 'null';
  if (typeof value !== 'object') return 'primitive';
  if (value instanceof Error) return 'Error';
  return 'Object';
}

function safeName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const ownName = Object.getOwnPropertyDescriptor(value, 'name');
  if (ownName && 'value' in ownName && typeof ownName.value === 'string'
    && CLOSED_NAME_PATTERN.test(ownName.value)) return ownName.value;
  if (value instanceof Error) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    const constructorDescriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'constructor')
      : undefined;
    if (constructorDescriptor && 'value' in constructorDescriptor
      && typeof constructorDescriptor.value === 'function') {
      const candidate = constructorDescriptor.value.name as string;
      if (CLOSED_NAME_PATTERN.test(candidate)) return candidate;
    }
    return 'Error';
  }
  return null;
}

function safeCodeValue(value: unknown): WorkflowCodeValue | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && CLOSED_CODE_PATTERN.test(value)) return value;
  return null;
}

export function fingerprintWorkflowError(value: unknown): WorkflowErrorFingerprint {
  if (value === null || typeof value !== 'object') {
    return {
      constructorFamily: constructorFamily(value),
      name: null,
      codeFields: [],
      ownKeys: [],
    };
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const codeFields: WorkflowCodeObservation[] = [];
  for (const field of WORKFLOW_CODE_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || !('value' in descriptor)) continue;
    const observed = safeCodeValue(descriptor.value);
    if (observed !== null) codeFields.push({ field, value: observed });
  }
  return {
    constructorFamily: constructorFamily(value),
    name: safeName(value),
    codeFields,
    ownKeys: Object.keys(descriptors)
      .filter((key) => descriptors[key]?.enumerable === true)
      .sort(),
  };
}

function observationKey(value: WorkflowCodeObservation): string {
  return `${value.field}:${typeof value.value}:${String(value.value)}`;
}

function observationMap(value: WorkflowErrorFingerprint): Map<string, WorkflowCodeObservation> {
  return new Map(value.codeFields.map((field) => [observationKey(field), field]));
}

export function qualifyMissingFingerprint(
  samples: WorkflowProbeSamples,
): CertifiedWorkflowMissingDiscriminator {
  if (samples.absent.length < 3) {
    throw new Error('Missing-instance probe requires at least three repeated absent samples.');
  }
  const first = observationMap(samples.absent[0]!);
  let stable = new Map(first);
  for (const sample of samples.absent.slice(1)) {
    const keys = observationMap(sample);
    stable = new Map([...stable].filter(([key]) => keys.has(key)));
  }
  const controls = [...samples.invalid, ...samples.synthetic]
    .flatMap((sample) => [...observationMap(sample).keys()]);
  for (const key of controls) stable.delete(key);
  if (stable.size === 0) {
    throw new WorkflowFingerprintQualificationError('NO_DISTINCT_WORKFLOW_MISSING_DISCRIMINATOR');
  }
  if (stable.size !== 1) {
    throw new WorkflowFingerprintQualificationError('AMBIGUOUS_WORKFLOW_MISSING_DISCRIMINATOR');
  }
  return [...stable.values()][0]!;
}
