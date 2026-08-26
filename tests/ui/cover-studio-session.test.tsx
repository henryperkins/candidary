import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import type { EventView } from '../../shared/contracts';
import {
  CoverDraftPrimitiveError,
  type CoverDraftView,
  coverOperationKey,
  createCoverDraft,
  discardCoverDraft,
  inspectCoverDraft,
  publishCoverIntent,
  readCoverEffectPreview,
  readCoverOperation,
  restartCoverOperation,
  transferCoverDraft,
  writeCoverComposition,
} from '../../src/features/cover/cover-draft-client';
import { createCoverOperationController } from '../../src/features/cover/cover-operation-controller';
import { useCoverStudioSession } from '../../src/features/cover/use-cover-studio-session';
import type { CoverOperationReconciler } from '../../src/features/cover/use-cover-operation-reconciler';

const OPERATION = 'd2f3b2a0-885c-4380-bf20-8d44e9712176';

function draft(patch: Partial<CoverDraftView> = {}): CoverDraftView {
  return {
    id: 'draft-a',
    source: 'new-upload',
    state: 'reserved',
    revision: 0,
    expiresAt: '2026-08-11T00:00:00.000Z',
    compositionModelVersion: 1,
    master: null,
    focus: null,
    preview: null,
    ...patch,
  };
}

function operation(patch: Partial<EventCoverPreparationView> = {}): EventCoverPreparationView {
  return {
    operationId: OPERATION,
    status: 'preparing',
    completedSteps: 0,
    requiredSteps: 6,
    retryable: false,
    safeFailureCode: null,
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...patch,
  };
}

function envelope(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function managerEvent(
  config: EventView['cover']['config'],
  revision = 3,
): EventView {
  return {
    id: 'event-a',
    cover: {
      config,
      revision,
      hasCover: config.source.kind !== 'none',
      available2xProfiles: [],
      surfaceTreatment: 'none',
      preparation: null,
    },
  } as unknown as EventView;
}

function reconciler(
  patch: Partial<CoverOperationReconciler> = {},
): CoverOperationReconciler {
  const controller = createCoverOperationController({
    eventId: 'event-a',
    schedule: () => () => undefined,
  });
  return {
    controller,
    operation: null,
    operationState: controller.getState(),
    accessFailure: null,
    beginDispatch: vi.fn((operationId: string) => controller.beginDispatch(operationId)),
    dispatchSettled: vi.fn((answer) => controller.dispatchSettled(answer)),
    dispatchFailed: vi.fn((error) => { void error; controller.dispatchSettled(null); }),
    rejectBeforeDispatch: vi.fn(),
    retry: vi.fn(),
    recoverAccess: vi.fn(),
    ...patch,
  };
}

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cover draft primitives', () => {
  it('persists one new-upload intent before reserve and replays it without an object key', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const storedAtDispatch: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      storedAtDispatch.push(sessionStorage.getItem(
        'candidary.cover.intent.event-a.porch.jpg.3.10',
      ) ?? '');
      return envelope({
        draft: draft(),
        ingress: { method: 'PUT', path: '/forged-path-is-not-used' },
        replayed: requests.length > 1,
      }, 201);
    }));
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 });

    const first = await createCoverDraft({
      eventId: 'event-a', intentKey: 'porch.jpg.3.10', source: { kind: 'new-upload', file },
    });
    const replay = await createCoverDraft({
      eventId: 'event-a', intentKey: 'porch.jpg.3.10', source: { kind: 'new-upload', file },
    });

    expect(first.draftIntentId).toBe(replay.draftIntentId);
    expect(storedAtDispatch).toEqual([first.draftIntentId, first.draftIntentId]);
    expect(requests[0]).toMatchObject({
      draftIntentId: first.draftIntentId,
      source: { kind: 'new-upload' },
      filename: 'porch.jpg',
      mimeType: 'image/jpeg',
      byteSize: 3,
    });
    expect(JSON.stringify(requests)).not.toMatch(/objectKey|object_key/iu);
    expect(replay.replayed).toBe(true);
  });

  it('creates an existing-upload edit from only the active cover revision', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return envelope({ draft: draft({ source: 'existing-upload', state: 'ready' }), ingress: null }, 201);
    }));

    await createCoverDraft({
      eventId: 'event-a',
      intentKey: 'existing',
      source: { kind: 'existing-upload', expectedCoverRevision: 7 },
    });
    expect(body).toMatchObject({
      source: { kind: 'existing-upload' }, expectedCoverRevision: 7,
    });
    expect(JSON.stringify(body)).not.toMatch(/object|master|render/iu);
  });

  it('guards transfer, inspection, composition, preview abort, and discard revisions', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(path), init]);
      if (String(path).endsWith('/previews/warm')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      const nextState = init?.method === 'PUT'
        ? 'transferred'
        : init?.method === 'POST'
          ? 'inspected'
          : init?.method === 'PATCH'
            ? 'ready'
            : 'expired';
      return envelope({ draft: draft({ state: nextState, revision: 4 }) });
    }));
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg' });

    await expect(transferCoverDraft({ eventId: 'event-a', draft: draft({ state: 'ready' }), file }))
      .rejects.toBeInstanceOf(CoverDraftPrimitiveError);
    await expect(inspectCoverDraft('event-a', draft({ state: 'reserved' })))
      .rejects.toBeInstanceOf(CoverDraftPrimitiveError);
    await expect(writeCoverComposition({
      eventId: 'event-a', draft: draft({ state: 'ready' }), focus: { x: 0.4, y: 0.6 },
    })).rejects.toBeInstanceOf(CoverDraftPrimitiveError);

    await transferCoverDraft({ eventId: 'event-a', draft: draft({ revision: 3 }), file });
    await inspectCoverDraft('event-a', draft({ state: 'transferred', revision: 4 }));
    await writeCoverComposition({
      eventId: 'event-a',
      draft: draft({ state: 'inspected', revision: 5 }),
      focus: { x: 0.4, y: 0.6 },
    });
    const controller = new AbortController();
    await readCoverEffectPreview('event-a', 'draft-a', 'warm', controller.signal);
    await discardCoverDraft('event-a', draft({ state: 'ready', revision: 8 }));

    expect(new Headers(calls.find(([, init]) => init?.method === 'PUT')?.[1]?.headers)
      .get('if-match')).toBe('"3"');
    expect(calls.find(([path]) => path.endsWith('/previews/warm'))?.[1]?.signal)
      .toBe(controller.signal);
    expect(new Headers(calls.find(([, init]) => init?.method === 'DELETE')?.[1]?.headers)
      .get('if-match')).toBe('"8"');
  });
});

describe('cover operation transport', () => {
  it('persists the operation before dispatch and accepts only its authorized receipt path', async () => {
    const locations = [
      '/api/manage/events/event-a/cover/publications/' + OPERATION,
      'https://attacker.example/steal',
      '/api/manage/events/other/cover/publications/' + OPERATION,
      '/api/manage/events/event-a/cover/publications/other',
      'http://%',
    ];
    for (const location of locations) {
      sessionStorage.clear();
      let storedAtDispatch: string | null = null;
      vi.stubGlobal('fetch', vi.fn(async () => {
        storedAtDispatch = sessionStorage.getItem(coverOperationKey('event-a'));
        return envelope({ operation: operation() }, 202, {
          Location: location,
          'Retry-After': '2',
        });
      }));
      const answer = await publishCoverIntent({
        eventId: 'event-a',
        expectedRevision: 3,
        operationId: OPERATION,
        intent: { source: { kind: 'preset', presetId: 'warm-linen' }, effect: 'film' },
      });
      expect(storedAtDispatch).toBe(OPERATION);
      expect(answer.receiptPath)
        .toBe('/api/manage/events/event-a/cover/publications/' + OPERATION);
      expect(answer.retryAfterMs).toBe(2_000);
    }
  });

  it('returns complete typed answers from status and restart', async () => {
    const event = {
      id: 'event-a',
      cover: { revision: 4, hasCover: true },
    } as EventView;
    const fetchMock = vi.fn(async (path: RequestInfo | URL) => {
      if (String(path).endsWith('/restart')) {
        return envelope({ operation: operation({ status: 'retryable-failed', retryable: true }) }, 503, {
          'Retry-After': '11',
        });
      }
      return envelope({
        operation: operation({ status: 'applied', completedSteps: 6 }),
        appliedRevision: 4,
        event,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readCoverOperation('event-a', OPERATION)).resolves.toMatchObject({
      status: 200,
      operation: { status: 'applied' },
      appliedRevision: 4,
      event,
      receiptPath: '/api/manage/events/event-a/cover/publications/' + OPERATION,
      retryAfterMs: null,
    });
    await expect(restartCoverOperation('event-a', OPERATION)).resolves.toMatchObject({
      status: 503,
      operation: { status: 'retryable-failed' },
      retryAfterMs: 11_000,
    });
  });
});

describe('useCoverStudioSession', () => {
  it('opens none and preset covers in their exact semantic state', () => {
    const none = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
    }));
    act(() => none.result.current.openStudio());
    expect(none.result.current.selection).toEqual({
      source: null,
      focus: null,
      focusMode: 'auto',
      effect: 'natural',
    });
    expect(none.result.current.draftState.status).toBe('idle');
    expect(none.result.current.canvasPreview.kind).toBe('authoritative');
    none.unmount();

    const preset = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'preset', presetId: 'coastal-haze', assetVersion: 1 },
        effect: 'soft',
      }),
      reconciler: reconciler(),
    }));
    act(() => preset.result.current.openStudio());
    expect(preset.result.current.selection).toEqual({
      source: { kind: 'preset', presetId: 'coastal-haze' },
      focus: null,
      focusMode: 'auto',
      effect: 'soft',
    });
  });

  it('creates one existing-upload edit draft on Compose and resets to its automatic point', async () => {
    const createObjectURL = vi.fn(() => 'blob:natural');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.3, y: 0.4, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => {
      requests.push(String(path));
      if (String(path).endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return envelope({ draft: ready, ingress: null }, 201);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'manual', x: 0.8, y: 0.7, zoom: 1.25 },
        effect: 'film',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    expect(session.result.current.selection.focus).toEqual({ x: 0.8, y: 0.7, zoom: 1.25 });
    expect(session.result.current.selection.focusMode).toBe('manual');
    await act(async () => {
      await Promise.all([
        session.result.current.enterCompose(),
        session.result.current.enterCompose(),
      ]);
    });
    expect(requests.filter((path) => path.endsWith('/cover/drafts'))).toHaveLength(1);
    expect(session.result.current.draftState.status).toBe('ready');
    expect(session.result.current.canvasPreview).toEqual({ kind: 'draft', url: 'blob:natural' });
    expect(session.result.current.draft).toMatchObject({
      id: 'draft-a',
      initialFocus: { x: 0.8, y: 0.7, zoom: 1.25 },
      automaticFocus: { x: 0.3, y: 0.4, zoom: 1 },
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6 },
    });

    act(() => session.result.current.setFocus({ x: 0.8, y: 0.7, zoom: 1.6 }));
    expect(session.result.current.selection.focusMode).toBe('manual');
    expect(session.result.current.draft?.available2xProfiles)
      .toEqual(['compact-default', 'short-lookup']);

    act(() => session.result.current.resetFocus());
    expect(session.result.current.selection.focus).toEqual({ x: 0.3, y: 0.4, zoom: 1 });
    expect(session.result.current.selection.focusMode).toBe('auto');
    expect(session.result.current.draft?.available2xProfiles).toEqual([
      'compact-default',
      'compact-expanded',
      'framed-default',
      'short-lookup',
      'standard-default',
      'wide-expanded',
    ]);
    session.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:natural');
  });

  it('keeps the authoritative canvas until a new upload preview is ready', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: draft(), ingress: { method: 'PUT', path: '/ignored' } }, 201);
      if (value.endsWith('/raw')) return envelope({ draft: draft({ state: 'transferred', revision: 1 }) });
      if (value.endsWith('/inspect')) return envelope({ draft: draft({
        state: 'inspected',
        revision: 2,
        master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
        preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
      }) });
      if (value.endsWith('/previews/natural')) {
        await previewGate;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/composition') && init?.method === 'PATCH') {
        return envelope({ draft: draft({
          state: 'ready',
          revision: 3,
          master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
          focus: { x: 0.5, y: 0.5, modelVersion: 1 },
          preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
        }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
      compositionRunner: async () => ({ x: 0.5, y: 0.5 }),
    }));
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 });
    let upload!: Promise<void>;
    act(() => {
      session.result.current.openStudio();
      upload = session.result.current.chooseFile(file);
    });
    await waitFor(() => expect(session.result.current.draftState.status).toBe('loading'));
    expect(session.result.current.canvasPreview.kind).toBe('authoritative');

    releasePreview();
    await act(async () => upload);
    expect(session.result.current.draftState.status).toBe('ready');
    expect(session.result.current.canvasPreview.kind).toBe('draft');
  });

  it('retries the exact new upload after preparation fails', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let reservations = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        if (reservations === 1) {
          return new Response(JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'Preparation unavailable.',
          }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: draft(), ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/raw')) {
        return envelope({ draft: draft({ state: 'transferred', revision: 1 }) });
      }
      if (value.endsWith('/inspect')) {
        return envelope({ draft: draft({
          state: 'inspected',
          revision: 2,
          master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
          preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
        }) });
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/composition') && init?.method === 'PATCH') {
        return envelope({ draft: draft({
          state: 'ready',
          revision: 3,
          master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
          focus: { x: 0.5, y: 0.5, modelVersion: 1 },
          preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
        }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
      compositionRunner: async () => ({ x: 0.5, y: 0.5 }),
    }));
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 });

    act(() => session.result.current.openStudio());
    await act(async () => {
      await expect(session.result.current.chooseFile(file)).rejects.toThrow('Preparation unavailable.');
    });
    expect(session.result.current.draftState.status).toBe('error');

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());

    expect(reservations).toBe(2);
    expect(session.result.current.draftState.status).toBe('ready');
    expect(session.result.current.selection.source).toEqual({ kind: 'upload' });
  });

  it('discards a reservation created while cancellation is in flight', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let releaseReservation!: () => void;
    const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const calls: Array<[string, string]> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      const method = init?.method ?? 'GET';
      calls.push([value, method]);
      if (value.endsWith('/cover/drafts')) {
        await reservationGate;
        return envelope({ draft: draft(), ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/draft-a') && method === 'GET') return envelope({ draft: draft() });
      if (method === 'DELETE') return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      if (value.endsWith('/raw')) return envelope({ draft: draft({ state: 'transferred', revision: 1 }) });
      if (value.endsWith('/inspect')) {
        return envelope({ draft: draft({
          state: 'inspected',
          revision: 2,
          master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
          preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
        }) });
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/composition')) {
        return envelope({ draft: draft({
          state: 'ready',
          revision: 3,
          master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
          focus: { x: 0.5, y: 0.5, modelVersion: 1 },
          preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
        }) });
      }
      throw new Error(`Unexpected request ${method} ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
      compositionRunner: async () => ({ x: 0.5, y: 0.5 }),
    }));
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 });

    act(() => session.result.current.openStudio());
    let upload!: Promise<void>;
    act(() => { upload = session.result.current.chooseFile(file); });
    await waitFor(() => expect(calls.some(([path]) => path.endsWith('/cover/drafts'))).toBe(true));
    const discard = session.result.current.discard();
    releaseReservation();
    await act(async () => { await Promise.allSettled([upload, discard]); });

    expect(calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1);
    expect(session.result.current.open).toBe(false);
    expect(session.result.current.draftState.status).toBe('idle');
  });

  it('makes a canceled in-flight attempt retryable when its deletion fails', async () => {
    let releaseReservation!: () => void;
    const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    let reservations = 0;
    const reserved = draft();
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        if (reservations === 1) await reservationGate;
        return envelope({ draft: reserved, ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: reserved });
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({
          code: 'INTERNAL_ERROR',
          message: 'Deletion unavailable.',
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    let upload!: Promise<void>;
    act(() => {
      upload = session.result.current.chooseFile(
        new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 }),
      );
    });
    await waitFor(() => expect(reservations).toBe(1));
    const discard = session.result.current.discard();
    releaseReservation();
    await act(async () => {
      await upload;
      await expect(discard).rejects.toThrow('Deletion unavailable.');
    });

    expect(session.result.current.open).toBe(true);
    expect(session.result.current.draftState.status).toBe('error');
    expect(reservations).toBe(1);
  });

  it('rejects a new upload once discard has started', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let deleteStarted = false;
    let reservations = 0;
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        return envelope({ draft: ready, ingress: null }, 201);
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: ready });
      }
      if (init?.method === 'DELETE') {
        deleteStarted = true;
        await deleteGate;
        return envelope({ draft: draft({ state: 'expired', revision: 4 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    let discard!: Promise<void>;
    act(() => { discard = session.result.current.discard(); });
    await waitFor(() => expect(deleteStarted).toBe(true));

    await act(async () => {
      await expect(session.result.current.chooseFile(
        new File(['new'], 'new.jpg', { type: 'image/jpeg', lastModified: 11 }),
      )).rejects.toThrow('discard is in progress');
    });
    // The acknowledged reservation is already owned. The blocked new file
    // creates no second reservation.
    expect(reservations).toBe(1);
    expect(session.result.current.selection.focus).toEqual({ x: 0.5, y: 0.5, zoom: 1 });

    releaseDelete();
    await act(async () => discard);
  });

  it('refreshes an ambiguously advanced draft before discarding it', async () => {
    let serverDraft = draft();
    let deleteRevision: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        return envelope({ draft: serverDraft, ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/raw')) {
        serverDraft = draft({ state: 'transferred', revision: 1 });
        throw new TypeError('The transfer response was lost.');
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: serverDraft });
      }
      if (init?.method === 'DELETE') {
        deleteRevision = new Headers(init.headers).get('if-match');
        if (deleteRevision !== '"1"') {
          return new Response(JSON.stringify({
            code: 'COVER_DRAFT_STATE_CONFLICT',
            message: 'The cover draft changed.',
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: draft({ state: 'expired', revision: 2 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => {
      await expect(session.result.current.chooseFile(
        new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 }),
      )).rejects.toThrow('transfer response was lost');
    });
    await act(async () => session.result.current.discard());

    expect(deleteRevision).toBe('"1"');
    expect(session.result.current.open).toBe(false);
  });

  it('replays a reservation whose committed response was lost before discarding', async () => {
    let reservations = 0;
    let deletes = 0;
    const reserved = draft();
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        if (reservations === 1) throw new TypeError('The reservation response was lost.');
        return envelope({ draft: reserved, ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: reserved });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => {
      await expect(session.result.current.chooseFile(
        new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 }),
      )).rejects.toThrow('reservation response was lost');
    });
    await act(async () => session.result.current.discard());

    expect(reservations).toBe(2);
    expect(deletes).toBe(1);
    expect(session.result.current.open).toBe(false);
  });

  it('replays a committed reservation that returned a structured server error', async () => {
    let reservations = 0;
    let deletes = 0;
    const reserved = draft();
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        if (reservations === 1) {
          return new Response(JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'The reservation response could not be prepared.',
          }), { status: 500, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: reserved, ingress: { method: 'PUT', path: '/ignored' } }, 201);
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: reserved });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => {
      await expect(session.result.current.chooseFile(
        new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 }),
      )).rejects.toThrow('reservation response could not be prepared');
    });
    await act(async () => session.result.current.discard());

    expect(reservations).toBe(2);
    expect(deletes).toBe(1);
    expect(session.result.current.open).toBe(false);
  });

  it('replays a lost existing-upload response with its original cover revision', async () => {
    let reservations = 0;
    let deletes = 0;
    const expectedRevisions: number[] = [];
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        expectedRevisions.push(JSON.parse(String(init?.body)).expectedCoverRevision as number);
        if (reservations === 1) throw new TypeError('The reservation response was lost.');
        return envelope({ draft: ready, ingress: null }, 201);
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: ready });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const heldReconciler = reconciler();
    const initial = managerEvent({
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, 7);
    const session = renderHook(
      ({ event }: { event: EventView }) => useCoverStudioSession({ event, reconciler: heldReconciler }),
      { initialProps: { event: initial } },
    );

    act(() => session.result.current.openStudio());
    await act(async () => {
      await expect(session.result.current.enterCompose()).rejects.toThrow('reservation response was lost');
    });
    session.rerender({ event: { ...initial, cover: { ...initial.cover, revision: 8 } } });
    await act(async () => session.result.current.discard());

    expect(reservations).toBe(2);
    expect(expectedRevisions).toEqual([7, 7]);
    expect(deletes).toBe(1);
    expect(session.result.current.open).toBe(false);
  });

  it('does not replay a resolved existing-upload reservation after the cover revision changes', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let reservations = 0;
    let deletes = 0;
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        reservations += 1;
        if (reservations > 1) {
          return new Response(JSON.stringify({
            code: 'COVER_DRAFT_STATE_CONFLICT',
            message: 'This cover has moved on since this page loaded.',
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: ready, ingress: null }, 201);
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: ready });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const heldReconciler = reconciler();
    const initial = managerEvent({
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, 7);
    const session = renderHook(
      ({ event }: { event: EventView }) => useCoverStudioSession({ event, reconciler: heldReconciler }),
      { initialProps: { event: initial } },
    );

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    session.rerender({ event: { ...initial, cover: { ...initial.cover, revision: 8 } } });
    await act(async () => session.result.current.discard());

    expect(reservations).toBe(1);
    expect(deletes).toBe(1);
    expect(session.result.current.open).toBe(false);
  });

  it('treats an already-published draft as terminal without deleting it', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let deletes = 0;
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: ready, ingress: null }, 201);
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: draft({ ...ready, state: 'published', revision: 4 }) });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return new Response(JSON.stringify({
          code: 'COVER_DRAFT_STATE_CONFLICT',
          message: 'Published drafts cannot be discarded.',
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => session.result.current.discard());

    expect(deletes).toBe(0);
    expect(session.result.current.open).toBe(false);
  });

  it('keeps a publishing draft in recovery instead of attempting deletion', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let deletes = 0;
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: ready, ingress: null }, 201);
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: draft({ ...ready, state: 'publishing', revision: 4 }) });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        throw new Error('Publishing drafts must never reach DELETE.');
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => {
      await expect(session.result.current.discard()).rejects.toThrow('being published');
    });

    expect(deletes).toBe(0);
    expect(session.result.current.open).toBe(true);
  });

  it('reconciles a deletion whose committed response was lost', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      revision: 3,
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    let serverDraft = ready;
    let deletes = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: serverDraft, ingress: null }, 201);
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: serverDraft });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        serverDraft = draft({ state: 'expired', revision: 4 });
        throw new TypeError('The deletion response was lost.');
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => session.result.current.discard());

    expect(deletes).toBe(1);
    expect(session.result.current.open).toBe(false);
    expect(session.result.current.draftState.status).toBe('idle');
  });

  it('retains draft ownership when deletion fails so discard can be retried', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:ready') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    let deletes = 0;
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (init?.method === 'DELETE') {
        deletes += 1;
        if (deletes === 1) {
          return new Response(JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'Deletion unavailable.',
          }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: draft({ state: 'expired', revision: 1 }) });
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-a') && (init?.method ?? 'GET') === 'GET') {
        return envelope({ draft: ready });
      }
      if (value.endsWith('/cover/drafts')) return envelope({ draft: ready, ingress: null }, 201);
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => {
      await expect(session.result.current.discard()).rejects.toThrow('Deletion unavailable.');
    });
    expect(session.result.current.open).toBe(true);
    expect(session.result.current.draft?.previewUrl).toBe('blob:ready');
    expect(session.result.current.canvasPreview).toEqual({ kind: 'draft', url: 'blob:ready' });

    await act(async () => session.result.current.discard());
    expect(deletes).toBe(2);
    expect(session.result.current.open).toBe(false);
    expect(session.result.current.draftState.status).toBe('idle');
  });

  it('keeps the current draft editable when an older owned draft fails deletion', async () => {
    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        value: vi.fn().mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new'),
      },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    const readyView = (id: string, source: CoverDraftView['source']) => draft({
      id,
      source,
      state: 'ready',
      revision: 3,
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.5, y: 0.5, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    const oldDraft = readyView('draft-old', 'existing-upload');
    const newDraft = readyView('draft-new', 'new-upload');
    const deleteOrder: string[] = [];
    let oldDeleteAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      const method = init?.method ?? 'GET';
      if (value.endsWith('/cover/drafts')) {
        const body = JSON.parse(String(init?.body)) as { source: { kind: string } };
        const selected = body.source.kind === 'existing-upload' ? oldDraft : newDraft;
        return envelope({ draft: selected, ingress: null }, 201);
      }
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (method === 'GET' && value.endsWith('/draft-old')) return envelope({ draft: oldDraft });
      if (method === 'GET' && value.endsWith('/draft-new')) return envelope({ draft: newDraft });
      if (method === 'DELETE') {
        const id = value.endsWith('/draft-old') ? 'draft-old' : 'draft-new';
        deleteOrder.push(id);
        if (id === 'draft-old' && oldDeleteAttempts++ === 0) {
          return new Response(JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'Old deletion unavailable.',
          }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return envelope({ draft: draft({ id, state: 'expired', revision: 4 }) });
      }
      throw new Error(`Unexpected request ${method} ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, 7),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => session.result.current.chooseFile(
      new File(['new'], 'new.jpg', { type: 'image/jpeg', lastModified: 11 }),
    ));
    await act(async () => {
      await expect(session.result.current.discard()).rejects.toThrow('Old deletion unavailable.');
    });

    expect(deleteOrder).toEqual(['draft-old']);
    expect(session.result.current.draft).toMatchObject({ id: 'draft-new', previewUrl: 'blob:new' });

    await act(async () => session.result.current.discard());
    expect(deleteOrder).toEqual(['draft-old', 'draft-old', 'draft-new']);
    expect(session.result.current.open).toBe(false);
  });

  it('prefetches all five real effects through one deduplicated session owner', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:natural')
      .mockReturnValueOnce('blob:warm')
      .mockReturnValueOnce('blob:film')
      .mockReturnValueOnce('blob:soft')
      .mockReturnValueOnce('blob:monochrome');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.3, y: 0.4, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    const fetchMock = vi.fn(async (path: RequestInfo | URL) => (
      String(path).includes('/previews/')
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        : envelope({ draft: ready, ingress: null }, 201)
    ));
    vi.stubGlobal('fetch', fetchMock);
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }),
      reconciler: reconciler(),
    }));
    await act(async () => session.result.current.enterCompose());
    await act(async () => {
      await Promise.all([
        session.result.current.prefetchStylePreviews(),
        session.result.current.prefetchStylePreviews(),
      ]);
    });
    for (const effect of ['natural', 'warm', 'film', 'soft', 'monochrome']) {
      expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith(`/previews/${effect}`)))
        .toHaveLength(1);
    }
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'ready',
      url: 'blob:warm',
    });

    act(() => session.result.current.close());
    for (const url of ['blob:natural', 'blob:warm', 'blob:film', 'blob:soft', 'blob:monochrome']) {
      expect(revokeObjectURL).toHaveBeenCalledTimes(5);
      expect(revokeObjectURL).toHaveBeenCalledWith(url);
    }
  });

  it('retains the last usable tile until an exact replacement succeeds', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:natural-old')
      .mockReturnValueOnce('blob:warm-old')
      .mockReturnValueOnce('blob:natural-new')
      .mockReturnValueOnce('blob:warm-new');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const ready = (id: string, source: CoverDraftView['source']) => draft({
      id,
      source,
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.3, y: 0.4, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    let draftRequest = 0;
    let newWarmRequest = 0;
    let releaseNatural!: () => void;
    const naturalGate = new Promise<void>((resolve) => { releaseNatural = resolve; });
    let newNaturalStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) {
        draftRequest += 1;
        return envelope({
          draft: draftRequest === 1
            ? ready('draft-old', 'existing-upload')
            : ready('draft-new', 'new-upload'),
          ingress: null,
        }, 201);
      }
      if (value.endsWith('/draft-old/previews/natural')
          || value.endsWith('/draft-old/previews/warm')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/draft-new/previews/natural')) {
        newNaturalStarted = true;
        await naturalGate;
        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      if (value.endsWith('/draft-new/previews/warm')) {
        newWarmRequest += 1;
        return newWarmRequest === 1
          ? envelope({ code: 'PREVIEW_UNAVAILABLE', message: 'Preview unavailable.' }, 503)
          : new Response(new Uint8Array([7, 8, 9]), { status: 200 });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => session.result.current.setEffect('warm'));
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'ready', url: 'blob:warm-old',
    });

    let replacement!: Promise<void>;
    act(() => {
      replacement = session.result.current.chooseFile(
        new File(['new'], 'new.jpg', { type: 'image/jpeg', lastModified: 11 }),
      );
    });
    await waitFor(() => expect(newNaturalStarted).toBe(true));
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:natural-old');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:warm-old');

    releaseNatural();
    await act(async () => replacement);
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:natural-old')).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:warm-old');
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'loading', url: 'blob:warm-old',
    });
    expect(session.result.current.canvasPreview).toEqual({
      kind: 'draft', url: 'blob:natural-new',
    });

    await act(async () => session.result.current.setEffect('warm'));
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'error', url: 'blob:warm-old',
    });
    expect(session.result.current.canvasPreview).toEqual({
      kind: 'draft', url: 'blob:natural-new',
    });
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:warm-old');

    await act(async () => session.result.current.retryEffectPreview('warm'));
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'ready', url: 'blob:warm-new',
    });
    expect(session.result.current.canvasPreview).toEqual({
      kind: 'draft', url: 'blob:warm-new',
    });
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:warm-old')).toHaveLength(1);

    session.unmount();
    for (const url of ['blob:natural-old', 'blob:warm-old', 'blob:natural-new', 'blob:warm-new']) {
      expect(revokeObjectURL.mock.calls.filter(([revoked]) => revoked === url)).toHaveLength(1);
    }
  });

  it('keeps a newer request owned when a superseded request settles', async () => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:natural') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.3, y: 0.4, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const warmSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: ready, ingress: null }, 201);
      if (value.endsWith('/previews/natural')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (value.endsWith('/previews/warm')) {
        warmSignals.push(init?.signal as AbortSignal);
        await (warmSignals.length === 1 ? firstGate : secondGate);
        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      throw new Error(`Unexpected request ${value}`);
    }));
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }),
      reconciler: reconciler(),
    }));
    await act(async () => session.result.current.enterCompose());

    let first!: Promise<void>;
    act(() => { first = session.result.current.setEffect('warm'); });
    await waitFor(() => expect(warmSignals).toHaveLength(1));
    act(() => {
      session.result.current.close();
      session.result.current.openStudio();
    });
    let second!: Promise<void>;
    act(() => { second = session.result.current.setEffect('warm'); });
    await waitFor(() => expect(warmSignals).toHaveLength(2));

    releaseFirst();
    await act(async () => first);
    session.unmount();
    expect(warmSignals[1]?.aborted).toBe(true);

    releaseSecond();
    await second;
  });

  it('retries a failed effect after close and reopen without refetching cached effects', async () => {
    const createdUrls: string[] = [];
    const createObjectURL = vi.fn(() => {
      const url = `blob:preview-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const ready = draft({
      source: 'existing-upload',
      state: 'ready',
      master: { width: 1600, height: 1000, safeZoomMaximum: 1.6, available2xProfiles: [] },
      focus: { x: 0.3, y: 0.4, modelVersion: 1 },
      preview: { effect: 'natural', width: 960, height: 600, byteSize: 3, recipeVersion: 1 },
    });
    let warmRequests = 0;
    const fetchMock = vi.fn(async (path: RequestInfo | URL) => {
      const value = String(path);
      if (value.endsWith('/cover/drafts')) return envelope({ draft: ready, ingress: null }, 201);
      if (value.endsWith('/previews/warm')) {
        warmRequests += 1;
        return warmRequests === 1
          ? envelope({ code: 'PREVIEW_UNAVAILABLE', message: 'Preview unavailable.' }, 503)
          : new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      if (value.includes('/previews/')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      throw new Error(`Unexpected request ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'upload' },
        focus: { mode: 'auto' },
        effect: 'natural',
      }),
      reconciler: reconciler(),
    }));

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.enterCompose());
    await act(async () => session.result.current.setEffect('warm'));
    expect(session.result.current.styleThumbnails.warm.status).toBe('error');

    act(() => session.result.current.close());
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:preview-1')).toHaveLength(1);
    expect(session.result.current.styleThumbnails.warm.status).toBe('idle');

    act(() => session.result.current.openStudio());
    await act(async () => session.result.current.prefetchStylePreviews());

    expect(warmRequests).toBe(2);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/previews/natural')))
      .toHaveLength(1);
    expect(session.result.current.styleThumbnails.warm.status).toBe('ready');
    expect(session.result.current.selection.effect).toBe('warm');

    session.unmount();
    expect(createdUrls).toHaveLength(6);
    for (const url of createdUrls) {
      expect(revokeObjectURL.mock.calls.filter(([revoked]) => revoked === url)).toHaveLength(1);
    }
  });

  it('marks dispatch before publication and sends nothing with a before-dispatch denial', async () => {
    const order: string[] = [];
    const owner = reconciler({
      beginDispatch: vi.fn(() => { order.push('begin'); }),
      dispatchSettled: vi.fn(() => { order.push('settled'); }),
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return envelope({ operation: operation() }, 202, { Location: `/api/manage/events/event-a/cover/publications/${OPERATION}` });
    }));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(OPERATION);
    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({
        version: 1,
        source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
        effect: 'film',
      }),
      reconciler: owner,
    }));

    await act(async () => session.result.current.publish());
    expect(order).toEqual(['begin', 'fetch', 'settled']);
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);

    const denied = new Error('Access must be restored.');
    const deniedOwner = reconciler({ accessFailure: { phase: 'before_dispatch', error: denied } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const deniedSession = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: deniedOwner,
    }));
    await expect(deniedSession.result.current.publish()).rejects.toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases a handed-off terminal receipt when a new Studio session opens', () => {
    const owner = reconciler();
    owner.controller.beginDispatch(OPERATION);
    owner.controller.dispatchSettled({
      status: 200,
      operation: operation({ status: 'applied', completedSteps: 6 }),
      receiptPath: `/api/manage/events/event-a/cover/publications/${OPERATION}`,
      retryAfterMs: null,
    });
    expect(owner.controller.getState().phase).toBe('applied');

    const session = renderHook(() => useCoverStudioSession({
      event: managerEvent({ version: 1, source: { kind: 'none' } }),
      reconciler: owner,
    }));
    act(() => session.result.current.openStudio());

    expect(owner.controller.getState()).toMatchObject({
      phase: 'idle',
      operationId: null,
      dispatched: false,
    });
  });
});
