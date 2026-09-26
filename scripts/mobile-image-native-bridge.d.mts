export type BridgeExecResult = { code: number; stdout: Buffer; stderr: Buffer };
export type BridgeExec = (args: string[], options?: { input?: ReadableStream<Uint8Array> | null; timeoutMs?: number; maxStdout?: number }) => Promise<BridgeExecResult>;
export const BRIDGE_CONTAINER_PATTERN: RegExp;
export const REAL_ORIGINAL_FIXTURES: readonly string[];
export const wslDocker: BridgeExec;
export function nativeBridgeEnabled(options?: { env?: Record<string, string | undefined>; root?: string }): boolean;
export function createNativeBridge(options?: { container?: string; root?: string; exec?: BridgeExec }): (request: Request) => Promise<Response>;
export function nativeBridge(request: Request): Promise<Response>;
