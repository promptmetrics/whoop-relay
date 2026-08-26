// WHOOP v2 API client. v1 is removed; v2 is the only API.
const API_BASE = "https://api.prod.whoop.com/developer/v2";

export class WhoopApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export class RateLimitedError extends WhoopApiError {
  constructor(public readonly resetSeconds: number) {
    super(`WHOOP rate limit hit, resets in ${resetSeconds}s`, 429);
  }
}

export class UnauthorizedError extends WhoopApiError {
  constructor(status: number) {
    super("WHOOP token rejected (user revoked access?)", status);
  }
}

export interface CollectionPage<T = Record<string, unknown>> {
  records: T[];
  next_token?: string;
}

export interface CollectionParams {
  start?: string;
  end?: string;
  nextToken?: string;
  limit?: number;
}

async function whoopFetch(
  token: string,
  path: string,
  params?: CollectionParams,
  method: "GET" | "DELETE" = "GET"
): Promise<Record<string, unknown> | null> {
  const url = new URL(API_BASE + path);
  if (params?.start) url.searchParams.set("start", params.start);
  if (params?.end) url.searchParams.set("end", params.end);
  if (params?.nextToken) url.searchParams.set("nextToken", params.nextToken);
  if (params?.limit) url.searchParams.set("limit", String(params.limit));

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get("X-RateLimit-Reset") ?? "60");
    throw new RateLimitedError(Number.isFinite(reset) && reset > 0 ? reset : 60);
  }
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(res.status);
  if (res.status === 404) return null;
  if (res.status === 204) return {};
  if (!res.ok) throw new WhoopApiError(`WHOOP ${method} ${path} -> ${res.status}`, res.status);
  return (await res.json()) as Record<string, unknown>;
}

export const whoop = {
  sleep: (token: string, id: string) => whoopFetch(token, `/activity/sleep/${id}`),
  workout: (token: string, id: string) => whoopFetch(token, `/activity/workout/${id}`),
  cycle: (token: string, id: number) => whoopFetch(token, `/cycle/${id}`),
  recoveryForCycle: (token: string, cycleId: number) =>
    whoopFetch(token, `/cycle/${cycleId}/recovery`),

  sleeps: (token: string, params: CollectionParams) =>
    whoopFetch(token, "/activity/sleep", params) as Promise<CollectionPage | null>,
  workouts: (token: string, params: CollectionParams) =>
    whoopFetch(token, "/activity/workout", params) as Promise<CollectionPage | null>,
  cycles: (token: string, params: CollectionParams) =>
    whoopFetch(token, "/cycle", params) as Promise<CollectionPage | null>,
  recoveries: (token: string, params: CollectionParams) =>
    whoopFetch(token, "/recovery", params) as Promise<CollectionPage | null>,

  profile: (token: string) => whoopFetch(token, "/user/profile/basic"),
  bodyMeasurement: (token: string) => whoopFetch(token, "/user/measurement/body"),

  // Offboarding: revokes the token upstream; WHOOP then stops sending the
  // user's webhooks.
  revokeAccess: (token: string) => whoopFetch(token, "/user/access", undefined, "DELETE")
};
