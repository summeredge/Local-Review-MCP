import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string | null>();

export function withInboundRequestId<T>(requestId: string | null, body: () => T): T {
  return store.run(requestId, body);
}

export function inboundRequestId(): string | null {
  return store.getStore() ?? null;
}

export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const id = raw.split("/")[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
