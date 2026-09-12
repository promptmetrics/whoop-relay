import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

// What actually sits in DO storage: AES-256-GCM over the JSON above, keyed by
// the TOKEN_ENCRYPTION_KEY Worker secret. Cloudflare already encrypts DO
// storage at rest; this layer means a storage-level read still yields nothing
// usable without the secret (WHOOP API Terms §2.4).
interface SealedTokens {
  v: 1;
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext + tag
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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
  private key: Promise<CryptoKey> | null = null;

  async storeTokens(tokens: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }): Promise<void> {
    await this.put({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000
    });
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async getAccessToken(): Promise<TokenResult> {
    const stored = await this.read();
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
    await this.put(next);
    return { ok: true, token: next.access_token };
  }

  // --- storage envelope -------------------------------------------------

  private async put(tokens: StoredTokens): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.aesKey(),
      new TextEncoder().encode(JSON.stringify(tokens))
    );
    const sealed: SealedTokens = { v: 1, iv: b64(iv), ct: b64(ct) };
    await this.ctx.storage.put("tokens", sealed);
  }

  private async read(): Promise<StoredTokens | null> {
    const raw = await this.ctx.storage.get<StoredTokens | SealedTokens>("tokens");
    if (!raw) return null;
    if (!("ct" in raw)) {
      // Pre-encryption record from before 2026-09-11: usable as-is, sealed on
      // the way past so the plaintext copy disappears on first touch.
      await this.put(raw);
      return raw;
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(raw.iv) },
      await this.aesKey(),
      unb64(raw.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain)) as StoredTokens;
  }

  private aesKey(): Promise<CryptoKey> {
    if (!this.key) {
      const secret = this.env.TOKEN_ENCRYPTION_KEY;
      if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY secret is not set (openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY)");
      const bytes = unb64(secret);
      if (bytes.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
      this.key = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    }
    return this.key;
  }
}
