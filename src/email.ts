import type { Env } from "./types";
import { SUPPORT_EMAIL } from "./pages";

// Transactional email through Resend's REST API (no SDK: one fetch, and the
// Worker bundle stays small). Every send is best-effort — the access-request
// flow must never fail because an email did not go out.

const RESEND_URL = "https://api.resend.com/emails";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmail(env: Env, mail: Mail): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn(JSON.stringify({ event: "email_skipped", reason: "RESEND_API_KEY not set" }));
    return false;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        reply_to: mail.replyTo ?? SUPPORT_EMAIL
      })
    });
    if (!res.ok) {
      // No subject or recipient here: both carry the applicant's name/email.
      console.error(JSON.stringify({ event: "email_failed", status: res.status, body: (await res.text()).slice(0, 300) }));
      return false;
    }
    return true;
  } catch (err) {
    console.error("email_failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Templates. Plain text first (it is what the admin reads on a phone), HTML
// as a light wrapper so the approve/deny links are tappable.

export interface RequestSummary {
  whoopUserId: number;
  name: string | null;
  email: string;
  requestedAt: string;
  isRepeat: boolean; // had a previous decision
}

export function adminRequestMail(
  env: Env,
  req: RequestSummary,
  links: { approve: string; deny: string; admin: string },
  seats: { used: number; max: number }
): Mail {
  const who = req.name ? `${req.name} <${req.email}>` : req.email;
  const repeat = req.isRepeat ? " (repeat request, previously decided)" : "";
  const footer = `The grant behind this request is already revoked. Until you approve, we hold name, email and id. Nothing else. Links expire in 7 days.`;
  const text = [
    `New WHOOP Relay access request${repeat}`,
    ``,
    `Who:        ${who}`,
    `WHOOP id:   ${req.whoopUserId}`,
    `Requested:  ${req.requestedAt}`,
    `Seats used: ${seats.used} / ${seats.max}`,
    ``,
    `Approve: ${links.approve}`,
    `Deny:    ${links.deny}`,
    ``,
    `Queue and history: ${links.admin}`,
    ``,
    footer
  ].join("\n");
  const html =
    `<p><strong>New WHOOP Relay access request${repeat}</strong></p>` +
    `<p>${esc(who)}<br>WHOOP id ${req.whoopUserId}<br>Requested ${esc(req.requestedAt)}<br>Seats used ${seats.used} / ${seats.max}</p>` +
    `<p><a href="${links.approve}" style="display:inline-block;padding:10px 18px;background:#00f19f;color:#101518;border-radius:8px;text-decoration:none;font-weight:700">Approve</a>&nbsp;&nbsp;` +
    `<a href="${links.deny}" style="display:inline-block;padding:10px 18px;border:1px solid #ff0026;color:#ff0026;border-radius:8px;text-decoration:none">Deny</a></p>` +
    `<p><a href="${links.admin}">Queue and history</a></p>` +
    `<p style="color:#666;font-size:13px">${footer}</p>`;
  return { to: env.ADMIN_EMAIL, subject: `[WHOOP Relay] Access request: ${who}`, text, html, replyTo: req.email };
}

export function applicantReceivedMail(to: string, origin: string, opts: { full: boolean }): Mail {
  const wait = opts.full
    ? `WHOOP caps the app at a fixed member limit and we've hit it, so you're on the waiting list. I'll write when a seat opens.`
    : `I approve seats by hand, usually within a day or two. You'll get a second email either way.`;
  const facts = `One thing worth knowing now: we already revoked the access you granted on WHOOP's screen. We didn't fetch any health data. We hold your name and this email address. Nothing else.`;
  const text = [
    `Your WHOOP Relay request is in.`,
    ``,
    wait,
    ``,
    `${facts} Details: ${origin}/privacy`,
    ``,
    `Questions? Reply to this email.`
  ].join("\n");
  const html =
    `<p><strong>Your WHOOP Relay request is in.</strong></p>` +
    `<p>${wait}</p>` +
    `<p>${facts} <a href="${origin}/privacy">Details</a>.</p>` +
    `<p>Questions? Reply to this email.</p>`;
  return {
    to,
    subject: opts.full ? "WHOOP Relay: you're on the waiting list" : "WHOOP Relay: request received, pending approval",
    text,
    html
  };
}

export function applicantApprovedMail(to: string, origin: string): Mail {
  const consent = `Either way, WHOOP shows you one consent screen. Use the same WHOOP account you requested with. Your last six months import in the background. Give it a few minutes, then ask Claude about your recovery.`;
  const text = [
    `You're in.`,
    ``,
    `Two ways to connect:`,
    ``,
    `Claude Code:`,
    `  claude mcp add --transport http whoop ${origin}/mcp`,
    ``,
    `Claude Desktop or claude.ai:`,
    `  Settings → Connectors → Add custom connector → ${origin}/mcp`,
    ``,
    consent,
    ``,
    `Live dashboard: ${origin}/dashboard`,
    `Your data, and how to delete it: ${origin}/privacy`,
    ``,
    `Something break? Reply and tell me.`
  ].join("\n");
  const html =
    `<p><strong>You're in.</strong></p>` +
    `<p>Two ways to connect:</p>` +
    `<p><strong>Claude Code</strong></p><pre style="background:#f3f3f3;padding:10px;border-radius:6px">claude mcp add --transport http whoop ${origin}/mcp</pre>` +
    `<p><strong>Claude Desktop or claude.ai</strong><br>Settings → Connectors → Add custom connector → <code>${origin}/mcp</code></p>` +
    `<p>${consent}</p>` +
    `<p><a href="${origin}/dashboard">Live dashboard</a><br><a href="${origin}/privacy">Your data, and how to delete it</a></p>` +
    `<p>Something break? Reply and tell me.</p>`;
  return { to, subject: "WHOOP Relay: you're approved. Here's how to connect", text, html };
}

export function applicantDeniedMail(to: string): Mail {
  const text = [
    `Thanks for requesting WHOOP Relay.`,
    ``,
    `No seat right now. WHOOP caps the app at a fixed member limit, and seats go to Operator Stack members first. That's the whole reason. Nothing about you.`,
    ``,
    `We stored nothing from your WHOOP account and already revoked the access you granted.`,
    ``,
    `Think I got this wrong? Reply and say so.`
  ].join("\n");
  const html =
    `<p><strong>Thanks for requesting WHOOP Relay.</strong></p>` +
    `<p>No seat right now. WHOOP caps the app at a fixed member limit, and seats go to Operator Stack members first. That's the whole reason. Nothing about you.</p>` +
    `<p>We stored nothing from your WHOOP account and already revoked the access you granted.</p>` +
    `<p>Think I got this wrong? Reply and say so.</p>`;
  return { to, subject: "WHOOP Relay: no seat available right now", text, html };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
