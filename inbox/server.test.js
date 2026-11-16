import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifySignature, buildNotification, handleEvent, createServer, htmlToText } from "./server.js";

const rawKey = crypto.randomBytes(24);
const secret = `whsec_${rawKey.toString("base64")}`;

function sign(id, ts, body, key = rawKey) {
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

test("verifySignature accepts a valid signature", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"email.received"}';
  assert.equal(verifySignature({ secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body }), true);
});

test("verifySignature accepts when one of several signatures matches", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = "{}";
  const sig = `v1,AAAA ${sign("m", ts, body)}`;
  assert.equal(verifySignature({ secret, id: "m", timestamp: ts, signature: sig, body }), true);
});

test("verifySignature rejects tampered body, wrong key and stale timestamp", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = "{}";
  assert.equal(verifySignature({ secret, id: "m", timestamp: ts, signature: sign("m", ts, body), body: "{ }" }), false);
  assert.equal(verifySignature({ secret, id: "m", timestamp: ts, signature: sign("m", ts, body, crypto.randomBytes(24)), body }), false);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifySignature({ secret, id: "m", timestamp: old, signature: sign("m", old, body), body }), false);
  assert.equal(verifySignature({ secret, id: "m", timestamp: ts, signature: undefined, body }), false);
});

test("buildNotification escapes HTML, strips newlines and sets reply_to", () => {
  const msg = buildNotification({
    meta: { from: "Kund <kund@example.com>", to: ["support@mail.pdc.ax"], subject: "Trasig\r\nBcc: x@y <b>", attachments: [{ filename: "bild.png" }] },
    content: { text: "Hej <script>alert(1)</script>" },
    notifyTo: "me@example.org, other@example.org",
    notifyFrom: "Ärenden <arenden@mail.pdc.ax>",
  });
  assert.deepEqual(msg.to, ["me@example.org", "other@example.org"]);
  assert.equal(msg.reply_to, "Kund <kund@example.com>");
  assert.equal(msg.subject, "[Ärende] Trasig Bcc: x@y <b>");
  assert.ok(!msg.html.includes("<script>"));
  assert.ok(!msg.html.includes("<b>"));
  assert.ok(msg.text.includes("bild.png"));
});

test("htmlToText falls back from html", () => {
  assert.equal(htmlToText("<p>Hej</p><p>Lampan &amp; dörren</p>"), "Hej\nLampan & dörren");
});

test("handleEvent fetches content and sends notification", async () => {
  const calls = [];
  const deps = {
    resend: async (path, init) => {
      calls.push({ path, init });
      return path.startsWith("/emails/receiving/") ? { text: "Dörren går inte att låsa" } : { id: "sent" };
    },
  };
  const config = { notifyTo: "me@example.org", notifyFrom: "arenden@mail.pdc.ax" };
  const result = await handleEvent(
    { type: "email.received", data: { email_id: "abc", from: "kund@example.com", to: ["support@mail.pdc.ax"], subject: "Dörr" } },
    config,
    deps,
  );
  assert.equal(result, "notified");
  assert.equal(calls[0].path, "/emails/receiving/abc");
  const sent = JSON.parse(calls[1].init.body);
  assert.ok(sent.text.includes("Dörren går inte att låsa"));
});

test("handleEvent ignores other events and own notifications", async () => {
  const deps = { resend: async () => assert.fail("should not call") };
  const config = { notifyTo: "me@example.org", notifyFrom: "Ärenden <arenden@mail.pdc.ax>" };
  assert.equal(await handleEvent({ type: "email.sent", data: {} }, config, deps), "ignored");
  assert.equal(await handleEvent({ type: "email.received", data: { from: "arenden@mail.pdc.ax" } }, config, deps), "skipped-own");
});

test("HTTP: rejects unsigned, accepts signed, dedupes retries", async () => {
  let sends = 0;
  const deps = { resend: async (path) => { if (path === "/emails") sends++; return {}; } };
  const server = createServer({ webhookSecret: secret, notifyTo: "me@example.org", notifyFrom: "a@b.c" }, deps);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const body = JSON.stringify({ type: "email.received", data: { email_id: "x", from: "k@example.com", subject: "s" } });
    assert.equal((await fetch(`${url}/webhooks/resend`, { method: "POST", body })).status, 401);

    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { "svix-id": "msg_9", "svix-timestamp": ts, "svix-signature": sign("msg_9", ts, body) };
    assert.equal((await fetch(`${url}/webhooks/resend`, { method: "POST", body, headers })).status, 200);
    assert.equal((await fetch(`${url}/webhooks/resend`, { method: "POST", body, headers })).status, 200);
    assert.equal(sends, 1);
  } finally {
    server.close();
  }
});
