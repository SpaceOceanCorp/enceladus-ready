# Enceladus shared world (multiplayer relay)

People flying or walking on the Enceladus web globe (Land and Fly) and players of the Unreal game (M2EBridge plugin,
`M2EMultiplayerSubsystem`) see each other. Every client sends where it is about 5 times a second; the relay sends each
one the 60 players nearest them, 10 times a second. Nothing is stored. Message format: [PROTOCOL.md](PROTOCOL.md).

## Live relay

`wss://enceladus-relay.enceladus-relay-cloudflare.workers.dev` (Cloudflare Workers free plan, one Durable Object).
The web page reads it from `window.ENC_MP_URL` in `src/enceladus_ready/globe_template.html`.

Free-plan budget, roughly: 100,000 Durable Object requests a day, with incoming WebSocket messages counted at 20 to 1,
so about 100 player-hours a day at 5 updates a second. Past that, Cloudflare refuses new messages until the next day
(no charges on the free plan).

Redeploy after changing `cloudflare/src/worker.js`:

```
cd multiplayer/cloudflare
npm install          # once (pinned wrangler)
npx wrangler deploy
```

## Running it locally

Two equivalent versions:

- `node server.mjs` in this folder (after `npm install`), on port 8790. A local copy of the globe (localhost) connects
  to `ws://localhost:8790` by default.
- `npx wrangler dev --port 8791` in `cloudflare/`, the Cloudflare version running locally.

On localhost, `?mp=ws://127.0.0.1:PORT` on the page's address picks a different relay.

## Limits

Browser connections only from the Enceladus site and localhost (`ALLOW_ORIGINS`); the Unreal game sends no Origin and
is allowed. 300 players at once, 30 messages a second each, 1 KB per message, idle players dropped after 20 s.
Positions are self-reported and there are no accounts, chat or moderation yet.
