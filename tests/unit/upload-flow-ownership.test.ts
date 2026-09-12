import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function callCount(contents: string, callee: string): number {
  return [...contents.matchAll(new RegExp(`\\b${callee}\\s*\\(`, 'gu'))].length;
}

function hasRuntimeImport(contents: string, moduleSuffix: string): boolean {
  const parsed = ts.createSourceFile('ownership-check.tsx', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return parsed.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.endsWith(moduleSuffix)) return false;
    const clause = statement.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name !== undefined) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((specifier) => !specifier.isTypeOnly);
  });
}

describe('upload flow ownership', () => {
  it('keeps queue, transport, controller, and queue state out of the controlled renderer', () => {
    // Mutation caught: moving queue ownership back into the shared visual component.
    const renderer = source('src/features/uploads/GuestUploadFlow.tsx');

    expect(renderer).not.toMatch(/from ['"].*browser-upload-transport['"]/u);
    expect(hasRuntimeImport(renderer, 'upload-queue')).toBe(false);
    expect(hasRuntimeImport(`import {
      UploadQueueItem,
      UploadQueueState,
    } from './upload-queue';`, 'upload-queue')).toBe(true);
    expect(hasRuntimeImport(`import type {
      UploadQueueItem,
      UploadQueueState,
    } from './upload-queue';`, 'upload-queue')).toBe(false);
    expect(renderer).not.toContain('AbortController');
    expect(renderer).not.toMatch(/useState\s*<\s*UploadQueueItem/u);
    expect(renderer).not.toContain('runUploadQueue');
    expect(renderer).toContain('session.adoptFiles');
    expect(renderer).toContain('session.canRemoveItem');
    expect(renderer).toContain('session.removeItem');
    expect(renderer).toContain('session.send');
    expect(renderer).toContain('session.cancel');
  });

  it('mounts the guest session owner only inside the upload or terminal-receipt branch', () => {
    // Mutation caught: keeping a live queue/controller above the lifecycle phase boundary.
    const page = source('src/pages/EventPage.tsx');

    expect(page).toMatch(/function GuestPhotoUpload[\s\S]*useGuestUploadSession/u);
    expect(page).toMatch(
      /\(event\.phase === 'photos-primary' \|\| \(terminal && event\.phase === 'waiting'\)\) && <GuestPhotoUpload/u,
    );
    expect(page).not.toContain('session={uploadSession}');
  });

  it('gives each variant one queue call and the shared selection constructor', () => {
    // Mutation caught: nesting the guest hook or adding a second Manager queue.
    const guest = source('src/features/uploads/use-guest-upload-session.ts');
    const manager = source('src/features/uploads/use-manager-upload-session.ts');

    expect(callCount(guest, 'runUploadQueue')).toBe(1);
    expect(callCount(manager, 'runUploadQueue')).toBe(1);
    expect(guest).toMatch(/from ['"].*upload-selection['"]/u);
    expect(manager).toMatch(/from ['"].*upload-selection['"]/u);
    expect(manager).not.toContain('useGuestUploadSession');
  });

  it('leaves one validation and queue-item constructor for both owners', () => {
    // Mutation caught: forking accepted types, size checks, or item construction by variant.
    const selection = source('src/features/uploads/upload-selection.ts');
    const guest = source('src/features/uploads/use-guest-upload-session.ts');
    const manager = source('src/features/uploads/use-manager-upload-session.ts');

    expect(selection).toContain('MAX_IMAGE_BYTES');
    expect(selection).toContain('createUploadSelection');
    expect(callCount(guest, 'createUploadSelection')).toBe(1);
    expect(callCount(manager, 'createUploadSelection')).toBe(1);
  });

  it('keeps blocker and unload-listener ownership outside the dialog and session', () => {
    // Mutation caught: adding a second navigation owner inside the modal subtree.
    const dialog = source('src/features/uploads/ManagerUploadDialog.tsx');
    const manager = source('src/features/uploads/use-manager-upload-session.ts');

    expect(dialog).not.toContain('useBlocker');
    expect(dialog).not.toContain('beforeunload');
    expect(manager).not.toContain('useBlocker');
    expect(manager).not.toContain('beforeunload');
    expect(manager).toContain('onExitGateChange');
  });
});
