import { useCallback, useEffect, useState } from "react";

export type * from "./types";

/** True in the hosted static build: every call is answered in the browser, never by a server. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === "1";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const ADMIN_TOKEN_KEY = "penstock.adminToken";

export function adminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAdminToken(t: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, t);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
}

export function seller(): string {
  return new URLSearchParams(location.search).get("seller") ?? "tidewater";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (STATIC_DEMO) {
    const { staticApi } = await import("./static/sim");
    return staticApi<T>(path, init);
  }
  const sep = path.includes("?") ? "&" : "?";
  const token = adminToken();
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}${sep}seller=${encodeURIComponent(seller())}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new ApiError(0, "The Penstock proxy is not reachable.");
  }
  const body = await res.json().catch(() => ({}));
  // The dev server answers 5xx with no JSON error when the proxy behind it is down.
  if (!res.ok && res.status >= 500 && !(body as { error?: string }).error) throw new ApiError(0, "The Penstock proxy is not reachable.");
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Hosted demo only: builds the CSV in the browser. */
export async function downloadCsv(days: number): Promise<void> {
  const { downloadStaticCsv } = await import("./static/sim");
  await downloadStaticCsv(days);
}

export function exportUrl(days: number): string {
  return `/api/admin/export.csv?seller=${encodeURIComponent(seller())}&days=${days}`;
}

export function useApi<T>(path: string | null, pollMs?: number): { data: T | null; error: ApiError | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error: ApiError) => live && setState({ data: null, error, loading: false }));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs]);
  return { ...state, reload };
}
