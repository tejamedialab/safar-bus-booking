/** Thin fetch wrapper: cookies for auth, JSON in/out, typed error with the server's error code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
    public requestId?: string,
  ) {
    super(message);
  }
}

const BASE = '/api/v1';

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<T> {
  const qs = opts.query
    ? '?' +
      new URLSearchParams(
        Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  let res: Response;
  try {
    res = await fetch(BASE + path + qs, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? `Request failed (${res.status})`, e.details, e.requestId);
  }
  return json as T;
}

export const data = <T = any>(p: Promise<{ data: T }>) => p.then((r) => r.data);

/** Turns field-level validation details into { path: message } for inline form errors. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
    return Object.fromEntries(err.details.map((d: any) => [d.path, d.message]));
  }
  return {};
}
