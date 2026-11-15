// pdc-inbox: receives Resend `email.received` webhooks for the customer
// request mailbox and sends a notification email to NOTIFY_TO.
//
// No dependencies: node:http, node:crypto and global fetch only.

import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const RESEND_API = "https://api.resend.com";
const MAX_BODY_BYTES = 1024 * 1024; // webhook payloads are metadata only
const TIMESTAMP_TOLERANCE_S = 5 * 60;
const PREVIEW_CHARS = 2000;

// ---------------------------------------------------------------------------
// Webhook signature verification (Svix scheme, used by Resend).
// signed content = `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the
// base64-decoded part of the secret after "whsec_", base64-encoded.
// The signature header is a space-separated list of "v1,<base64>".
// ---------------------------------------------------------------------------
export function verifySignature({ secret, id, timestamp, signature, body, now = Date.now() }) {
  if (!secret || !id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > TIMESTAMP_TOLERANCE_S) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();

  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Strip CR/LF so values from the incoming mail cannot inject headers.
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export function buildNotification({ meta, content, notifyTo, notifyFrom }) {
  const from = oneLine(meta.from);
  const subject = oneLine(meta.subject) || "(inget ämne)";
  const to = (meta.to ?? []).map(oneLine).join(", ");
  const text = (content?.text || htmlToText(content?.html) || "").trim();
  const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  const attachments = (meta.attachments ?? []).map((a) => oneLine(a.filename)).filter(Boolean);

  const lines = [
    `Nytt ärende till ${to}`,
    "",
    `Från:   ${from}`,
    `Ämne:   ${subject}`,
    attachments.length ? `Bilagor: ${attachments.join(", ")}` : null,
    "",
    preview || "(tomt meddelande)",
    "",
    "—",
    "Svara på det här mejlet för att svara kunden direkt.",
    "Alla mottagna mejl: https://resend.com/emails (fliken Receiving)",
  ].filter((l) => l !== null);

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
<p style="color:#666;margin:0 0 12px">Nytt ärende till ${escapeHtml(to)}</p>
<table style="border-collapse:collapse;margin-bottom:16px">
<tr><td style="padding:2px 12px 2px 0;color:#666">Från</td><td>${escapeHtml(from)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#666">Ämne</td><td><strong>${escapeHtml(subject)}</strong></td></tr>
${attachments.length ? `<tr><td style="padding:2px 12px 2px 0;color:#666">Bilagor</td><td>${escapeHtml(attachments.join(", "))}</td></tr>` : ""}
</table>
<pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:12px;border-radius:6px">${escapeHtml(preview || "(tomt meddelande)")}</pre>
<p style="color:#666;font-size:13px">Svara på det här mejlet för att svara kunden direkt.<br>
<a href="https://resend.com/emails">Alla mottagna mejl i Resend</a> (fliken Receiving)</p>
</div>`;

  return {
    from: notifyFrom,
    to: notifyTo.split(",").map((s) => s.trim()).filter(Boolean),
    reply_to: from || undefined,
    subject: `[Ärende] ${subject}`,
    text: lines.join("\n"),
    html,
  };
}

async function resend(apiKey, path, init = {}) {
  const res = await fetch(`${RESEND_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Resend ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------
export async function handleEvent(event, config, deps = {}) {
  const call = deps.resend ?? ((path, init) => resend(config.apiKey, path, init));
  if (event?.type !== "email.received") return "ignored";

  const meta = event.data ?? {};
  // Never react to our own notifications (avoids mail loops if NOTIFY_TO
  // ever points back at the receiving domain).
  const fromAddr = String(meta.from ?? "").toLowerCase();
  const ownAddr = String(config.notifyFrom ?? "").toLowerCase().match(/[^<\s]+@[^>\s]+/)?.[0];
  if (ownAddr && fromAddr.includes(ownAddr)) return "skipped-own";

  let content = null;
  if (meta.email_id) {
    try {
      content = await call(`/emails/receiving/${encodeURIComponent(meta.email_id)}`);
    } catch (err) {
      // Still notify with metadata only.
      console.error("fetch content failed:", err.message);
    }
  }

  const message = buildNotification({
    meta,
    content,
    notifyTo: config.notifyTo,
    notifyFrom: config.notifyFrom,
  });
  await call("/emails", { method: "POST", body: JSON.stringify(message) });
  return "notified";
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
export function createServer(config, deps = {}) {
  const seen = new Map(); // svix-id -> timestamp, dedupes webhook retries

  return http.createServer((req, res) => {
    const send = (code, msg) => {
      res.writeHead(code, { "Content-Type": "text/plain" });
      res.end(`${msg}\n`);
    };

    if (req.method === "GET" && req.url === "/health") return send(200, "healthy");
    if (req.url !== "/webhooks/resend") return send(404, "not found");
    if (req.method !== "POST") return send(405, "method not allowed");

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        send(413, "too large");
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks).toString("utf8");
      const id = req.headers["svix-id"];

      const ok = verifySignature({
        secret: config.webhookSecret,
        id,
        timestamp: req.headers["svix-timestamp"],
        signature: req.headers["svix-signature"],
        body,
      });
      if (!ok) return send(401, "invalid signature");

      if (seen.has(id)) return send(200, "duplicate");

      let event;
      try {
        event = JSON.parse(body);
      } catch {
        return send(400, "invalid json");
      }

      try {
        const result = await handleEvent(event, config, deps);
        seen.set(id, Date.now());
        for (const [k, t] of seen) if (Date.now() - t > 24 * 3600_000) seen.delete(k);
        console.log(`${id} ${event.type} -> ${result}`);
        send(200, result);
      } catch (err) {
        console.error(`${id} failed:`, err.message);
        send(500, "error"); // Resend retries on non-2xx
      }
    });
  });
}

function loadConfig() {
  const config = {
    apiKey: process.env.RESEND_API_KEY,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    notifyTo: process.env.NOTIFY_TO,
    notifyFrom: process.env.NOTIFY_FROM,
  };
  const missing = Object.entries({
    RESEND_API_KEY: config.apiKey,
    RESEND_WEBHOOK_SECRET: config.webhookSecret,
    NOTIFY_TO: config.notifyTo,
    NOTIFY_FROM: config.notifyFrom,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer(loadConfig()).listen(port, () => console.log(`pdc-inbox listening on :${port}`));
}
