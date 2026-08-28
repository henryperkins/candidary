import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SURFACES = [
  {
    path: 'src/components/ManagerPhotoIntakePanel.tsx',
    canonicalCalls: ['formatEventDateTime'],
    numericToLocaleStringReceivers: [],
  },
  {
    path: 'src/pages/ManagerPage.tsx',
    canonicalCalls: ['formatEventDate', 'formatRetentionDate'],
    numericToLocaleStringReceivers: [
      'MAX_EVENT_MEDIA',
      'activeExport.processedMediaCount',
      'activeExport.mediaCount',
      'heldCount',
      'recoverableCount',
    ],
  },
  {
    path: 'src/features/uploads/GuestUploadFlow.tsx',
    canonicalCalls: ['formatEventDate'],
    numericToLocaleStringReceivers: [],
  },
  {
    path: 'src/pages/HostEventsPage.tsx',
    canonicalCalls: ['formatEventDate', 'formatRetentionDate'],
    numericToLocaleStringReceivers: ['event.storedMediaCount'],
  },
] as const;

interface AuditResult {
  canonicalCalls: Set<string>;
  violations: string[];
}

function auditSurface(
  path: string,
  allowedNumericReceivers: readonly string[],
): AuditResult {
  const sourceText = readFileSync(resolve(process.cwd(), path), 'utf8');
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const allowed = new Set(allowedNumericReceivers);
  const canonicalCalls = new Set<string>();
  const violations: string[] = [];

  const report = (node: ts.Node, reason: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${path}:${line + 1}:${character + 1} ${reason}`);
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'Intl'
      && node.expression.name.text === 'DateTimeFormat'
    ) {
      report(node, 'constructs a local Intl.DateTimeFormat');
    }

    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'Intl'
        && node.expression.name.text === 'DateTimeFormat'
      ) {
        report(node, 'calls a local Intl.DateTimeFormat');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text.startsWith('formatEvent')) {
        canonicalCalls.add(node.expression.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'formatRetentionDate') {
        canonicalCalls.add(node.expression.text);
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText(source);
        if (method === 'toLocaleDateString' || method === 'toLocaleTimeString') {
          report(node, `calls date-valued ${method}`);
        }
        if (method === 'toLocaleString' && !allowed.has(receiver)) {
          report(node, `calls unapproved toLocaleString receiver ${receiver}`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return { canonicalCalls, violations };
}

describe('Slice 5 C-61 date formatting AST audit', () => {
  it('audits exactly the four owning surfaces and only permits named numeric count formatting', () => {
    expect(SURFACES.map(({ path }) => path)).toEqual([
      'src/components/ManagerPhotoIntakePanel.tsx',
      'src/pages/ManagerPage.tsx',
      'src/features/uploads/GuestUploadFlow.tsx',
      'src/pages/HostEventsPage.tsx',
    ]);

    const violations: string[] = [];
    for (const surface of SURFACES) {
      const audit = auditSurface(surface.path, surface.numericToLocaleStringReceivers);
      violations.push(...audit.violations);
      for (const expectedCall of surface.canonicalCalls) {
        if (!audit.canonicalCalls.has(expectedCall)) {
          violations.push(`${surface.path} does not call ${expectedCall}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
