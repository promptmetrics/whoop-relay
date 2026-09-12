import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env, QueueMsg, SessionProps } from "./types";
import { handleQueueBatch } from "./consumer";
import { runReconciliation, runTokenHealthCheck, runDailyPrune } from "./reconcile";
import { buildServer } from "./mcp/server";
import { defaultHandler } from "./mcp/auth";

// Stateless MCP (spec 2026-07-28): no sessions, no initialize handshake —
// a fresh server instance per request is the canonical shape, so any request
// can land on any Worker instance.
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // workers-oauth-provider verified the bearer token and decrypted the
    // props we sealed in at consent time.
    const props = (ctx as ExecutionContext & { props?: SessionProps }).props;
    if (!props || typeof props.whoopUserId !== "number") {
      return new Response("unauthorized", { status: 401 });
    }
    // origin feeds the browser-dashboard URL in tool text so dev/tunnel/prod all point at themselves
    const origin = new URL(request.url).origin;
    // The provider injects its helpers into env for fetch handlers; the
    // disconnect tool uses them to revoke this user's MCP grants.
    const oauth = (env as Env & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
    const handler = createMcpHandler(() => buildServer(env, props, origin, oauth));
    return handler.fetch(request);
  }
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // 2026-07-28 client registration: CIMD is the current mechanism; the DCR
  // endpoint stays as the deprecated-but-functional fallback for older clients.
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register"
});

export default {
  fetch: (request, env, ctx) => provider.fetch(request, env, ctx),

  queue: (batch, env) => handleQueueBatch(batch, env),

  scheduled: (event, env, ctx) => {
    if (event.cron === "30 3 * * *") {
      ctx.waitUntil(runTokenHealthCheck(env));
      ctx.waitUntil(runDailyPrune(env));
    } else {
      ctx.waitUntil(runReconciliation(env));
    }
  }
} satisfies ExportedHandler<Env, QueueMsg>;

export { TokenManager } from "./do/token-manager";
export { RateBudget } from "./do/rate-budget";
