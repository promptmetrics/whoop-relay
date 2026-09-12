import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { whoop } from "./whoop/client";
import { deleteUserData } from "./db/upserts";

// Offboarding is one path for every trigger — the dashboard button, the MCP
// tool, an allowlist rejection, or WHOOP telling us the token is dead. WHOOP's
// API Terms (§4.2(b), §7.1) forbid keeping copies once access ends, so the
// purge is immediate and total: upstream grant, token DO, every D1 row, and
// the MCP grants that would otherwise keep pointing at a user who is gone.
export interface OffboardOptions {
  // False when WHOOP already rejected the token: there is nothing to revoke.
  revokeUpstream: boolean;
  // Present only on HTTP paths — the provider injects it into env for fetch
  // handlers, not for queue or cron invocations.
  oauth?: OAuthHelpers;
}

export async function offboardUser(env: Env, whoopUserId: number, opts: OffboardOptions): Promise<void> {
  const tokens = env.TOKEN_MANAGER.get(env.TOKEN_MANAGER.idFromName(String(whoopUserId)));

  if (opts.revokeUpstream) {
    const tokenRes = await tokens.getAccessToken();
    if (tokenRes.ok) await revokeUpstream(env, tokenRes.token, whoopUserId);
  }

  await tokens.disconnect();
  await deleteUserData(env.DB, whoopUserId);

  if (opts.oauth) await revokeMcpGrants(opts.oauth, whoopUserId);
  console.log(JSON.stringify({ event: "user_offboarded", user_id: whoopUserId, upstream_revoke_attempted: opts.revokeUpstream }));
}

// Revoking an access token WHOOP just issued (allowlist rejection) uses the
// same call, before any TokenManager exists for the user.
export async function revokeUpstream(env: Env, accessToken: string, whoopUserId: number): Promise<void> {
  const budget = await env.RATE_BUDGET.get(env.RATE_BUDGET.idFromName("global")).draw(1, "interactive");
  if (!budget.ok) {
    console.warn(`offboard: budget exhausted, skipping upstream revoke for user ${whoopUserId}`);
    return;
  }
  try {
    await whoop.revokeAccess(accessToken);
  } catch (err) {
    // A 401 here means the grant is already gone — the local purge still runs.
    console.warn(`offboard: upstream revoke failed for user ${whoopUserId}`, err);
  }
}

async function revokeMcpGrants(oauth: OAuthHelpers, whoopUserId: number): Promise<void> {
  const userId = String(whoopUserId);
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor ? { cursor } : undefined);
    for (const grant of page.items) await oauth.revokeGrant(grant.id, userId);
    cursor = page.cursor;
  } while (cursor);
}
