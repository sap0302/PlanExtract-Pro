import "server-only";

/**
 * Server-side client for the main app's /api/internal/* endpoints.
 *
 * The `server-only` import is load-bearing: it turns any accidental import from
 * a client component into a build error, so the service token can never be
 * serialized into a browser bundle.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

function failure(error: string, status: number): ApiResult<never> {
  return { ok: false, error, status };
}

export async function serviceFetch<T>(
  path: string,
  actor: string,
  init: { method?: string; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const token = process.env.ADMIN_SERVICE_TOKEN;
  const base = process.env.MAIN_APP_URL;

  if (!token || !base) {
    return failure(
      "Admin service is not configured — set MAIN_APP_URL and ADMIN_SERVICE_TOKEN",
      503
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "x-admin-actor": actor,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    return failure("Could not reach the main application", 502);
  }

  if (res.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure(`Unexpected response from the main application (${res.status})`, res.status);
    }
  }

  if (!res.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${res.status})`;
    return failure(message, res.status);
  }

  return { ok: true, data: parsed as T };
}
