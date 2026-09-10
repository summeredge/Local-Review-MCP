export const LOCAL_CONTROL_BRIDGE_PROTOCOL = 3 as const;
export const LOCAL_CONTROL_BRIDGE_SERVICE = "local-review-control-bridge" as const;
export const LOCAL_CONTROL_BRIDGE_HOST = "127.0.0.1" as const;
export const LOCAL_CONTROL_BRIDGE_PORTS = [12081, 12082, 12083, 12084, 12085] as const;
export const MAX_BRIDGE_REQUEST_BYTES = 64 * 1024;
export const MAX_BRIDGE_COMPLETION_ACK_REQUEST_BYTES = 512 * 1024;
export const BRIDGE_PROTOCOL_HEADER = "x-lrm-bridge-protocol" as const;

const CHROME_EXTENSION_ID = /^[a-p]{32}$/u;

export function parseExtensionOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "chrome-extension:"
      || !CHROME_EXTENSION_ID.test(parsed.hostname)
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || parsed.search !== ""
      || parsed.hash !== "") {
      return null;
    }

    const canonical = `chrome-extension://${parsed.hostname}`;
    return value === canonical || value === `${canonical}/` ? canonical : null;
  } catch {
    return null;
  }
}

export function isAllowedExtensionOrigin(value: unknown): value is string {
  return parseExtensionOrigin(value) !== null;
}

export function parseBridgeProtocol(value: unknown): number | null {
  const raw = Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
  if (typeof raw !== "string" || !/^\d+$/u.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isCompatibleBridgeProtocol(value: unknown): boolean {
  return parseBridgeProtocol(value) === LOCAL_CONTROL_BRIDGE_PROTOCOL;
}
