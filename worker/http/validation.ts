import type { z } from 'zod';

export function fieldErrors(
  error: z.ZodError,
  prefix: readonly PropertyKey[] = [],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = [...prefix, ...issue.path, key].map(String).join('.');
        fields[field || 'form'] ??= issue.message;
      }
      continue;
    }
    const field = [...prefix, ...issue.path].map(String).join('.');
    fields[field || 'form'] ??= issue.message;
  }
  return fields;
}
