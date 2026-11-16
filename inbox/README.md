# pdc-inbox — ärendekorg via Resend

Kunder mejlar `support@mail.pdc.ax`. Resend tar emot mejlet (syns under
**Emails → Receiving** på https://resend.com/emails) och skickar en webhook hit.
Tjänsten hämtar mejlets innehåll och skickar en avisering till dig, med
`reply_to` satt till kunden så att du kan svara direkt från aviseringen.

```
kund ──mejl──▶ Resend (MX på mail.pdc.ax) ──webhook──▶ pdc-inbox (Fly) ──avisering──▶ NOTIFY_TO
```

## Engångsuppsättning

1. **Domän i Resend** – `mail.pdc.ax` (är den redan verifierad för sändning räcker det att slå på Receiving; subdomän så att
   vanlig e-post på `pdc.ax` inte påverkas). Slå på **Receiving** och lägg in
   MX-posten som Resend visar i DNS. Den måste ha lägst prioritet för subdomänen.
   Domänen behöver också vara verifierad för *sändning*, eftersom aviseringen
   skickas från `NOTIFY_FROM`.
2. **Driftsätt tjänsten**
   ```sh
   cd inbox
   fly apps create pdc-inbox
   fly secrets set \
     RESEND_API_KEY=re_... \
     NOTIFY_TO=din@adress.ax \
     NOTIFY_FROM="PDC Ärenden <arenden@mail.pdc.ax>"
   fly deploy
   ```
3. **Webhook i Resend** – under Webhooks: endpoint
   `https://pdc-inbox.fly.dev/webhooks/resend`, event `email.received`.
   Kopiera signing secret (`whsec_...`) och kör
   `fly secrets set RESEND_WEBHOOK_SECRET=whsec_...`.
4. Testa: skicka ett mejl till `support@mail.pdc.ax`.

`NOTIFY_TO` ska vara din vanliga brevlåda, inte en adress på
`mail.pdc.ax`. Tjänsten hoppar ändå över mejl från `NOTIFY_FROM` för att
undvika loopar.

## Miljövariabler

| Namn | Beskrivning |
| --- | --- |
| `RESEND_API_KEY` | API-nyckel med rätt att läsa mottagna mejl och skicka |
| `RESEND_WEBHOOK_SECRET` | Webhookens signing secret (`whsec_...`) |
| `NOTIFY_TO` | Vart aviseringar skickas (kommaseparerat för flera) |
| `NOTIFY_FROM` | Avsändare för aviseringen, på en domän verifierad i Resend |

## Utveckling

Inga beroenden. `npm test` kör testerna (Node 20+).
Webhook-signaturer verifieras enligt Svix-schemat (som Resend använder),
dubbletter från omförsök filtreras på `svix-id`.
