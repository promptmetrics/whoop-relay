import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "revoked" | "not_connected" };

// One instance per WHOOP user (idFromName(String(whoopUserId))).
//
// WHOOP refresh tokens rotate: every refresh invalidates the old pair, so two
// components refreshing independently log each other out. This DO is the ONLY
// code path that touches the token endpoint; concurrent callers share one
// in-flight refresh via the promise mutex below, and the new pair is stored
// before any waiter is released.
export class TokenManager extends DurableObject<Env> {
  private refreshing: Promise<TokenResult> | null = null;

  async storeTokens(tokens: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }): Promise<void> {
    const stored: StoredTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000
    };
    await this.ctx.storage.put("tokens", stored);
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async getAccessToken(): Promise<TokenResult> {
    const stored = await this.ctx.storage.get<StoredTokens>("tokens");
    if (!stored) return { ok: false, reason: "not_connected" };
    if (stored.expires_at - Date.now() > 60_000) {
      return { ok: true, token: stored.access_token };
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh(stored).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(stored: StoredTokens): Promise<TokenResult> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
        client_id: this.env.WHOOP_CLIENT_ID,
        client_secret: this.env.WHOOP_CLIENT_SECRET,
        scope: "offline"
      })
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // invalid_grant: the user revoked access (or the pair was lost).
      await this.ctx.storage.deleteAll();
      return { ok: false, reason: "revoked" };
    }
    if (!res.ok) {
      // Transient upstream failure: keep the stored pair, let the caller retry.
      throw new Error(`WHOOP token refresh failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const next: StoredTokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + body.expires_in * 1000
    };
    await this.ctx.storage.put("tokens", next);
    return { ok: true, token: next.access_token };
  }
}
