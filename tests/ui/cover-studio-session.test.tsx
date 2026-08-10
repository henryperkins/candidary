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
    await act(async () => {
      await Promise.all([
        session.result.current.enterCompose(),
        session.result.current.enterCompose(),
      ]);
    });
    expect(requests.filter((path) => path.endsWith('/cover/drafts'))).toHaveLength(1);
    expect(session.result.current.draftState.status).toBe('ready');
    expect(session.result.current.canvasPreview).toEqual({ kind: 'draft', url: 'blob:natural' });

    act(() => session.result.current.resetFocus());
    expect(session.result.current.selection.focus).toEqual({ x: 0.3, y: 0.4, zoom: 1 });
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

  it('fetches each real effect at most once and revokes all URLs on close', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:natural')
      .mockReturnValueOnce('blob:warm');
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
      await session.result.current.setEffect('warm');
      await session.result.current.setEffect('warm');
    });
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/previews/warm')))
      .toHaveLength(1);
    expect(session.result.current.styleThumbnails.warm).toMatchObject({
      status: 'ready',
      url: 'blob:warm',
    });

    act(() => session.result.current.close());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:natural');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:warm');
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
});
