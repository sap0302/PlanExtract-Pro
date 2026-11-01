/**
 * Fixed-window rate limiting for unauthenticated endpoints.
 *
 * State lives in this process only, so it does not hold across a multi-instance
 * deployment or a dev-server reload. That is acceptable for the abuse it guards
 * against (signup-request spam from a single client); swap the two exported
 * functions for a Redis-backed pair if the app is ever scaled horizontally.
 */

type Bucket = { count: number; expiresAt: number };

const buckets = new Map<string, Bucket>();

// Bounded so a flood of unique keys can't grow the map without limit.
const MAX_BUCKETS = 10_000;

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the window resets — suitable for a Retry-After header. */
  retryAfter: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.expiresAt <= now) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(key, { count: 1, expiresAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((bucket.expiresAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

/**
 * Best-effort client identity. `x-forwarded-for` is only trustworthy behind a
 * proxy that overwrites it; a missing header collapses every caller into one
 * shared bucket, which fails closed (stricter) rather than open.
 */
export function clientKey(req: Request, scope: string): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return `${scope}:${ip}`;
}
