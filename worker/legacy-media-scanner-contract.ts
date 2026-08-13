import scannerConfig from '../config/legacy-media-scanner.json';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const expected = scannerConfig;

export function validateLegacyMediaScannerContract(
  candidate: unknown,
): typeof scannerConfig {
  if (stableJson(candidate) !== stableJson(expected)) {
    throw new Error('Invalid legacy media scanner contract.');
  }
  return candidate as typeof scannerConfig;
}

/** Production scanner behavior is bound to these exact checked-in bytes. */
export const legacyMediaScannerContract = validateLegacyMediaScannerContract(scannerConfig);
