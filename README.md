# Orbs Arena

A real-time 2D arena multiplayer game where players move around an infinite canvas, eat food to grow, and interact with other players. TypeScript everywhere: Node + Socket.io server, Canvas 2D client (Vite).

```bash
npm install
npm run dev          # server :3001, client :5173
npm run smoke        # (server running) checks client replay == server state
```

Open http://localhost:5173 in two tabs. Try `?lag=150&jitter=40` to simulate a bad network.

## Layout

| package | role |
| --- | --- |
| `packages/shared` | constants, protocol types, **`applyInput`** (the one movement function), `SpatialHash` |
| `packages/server` | authoritative 60 Hz sim, 20 Hz snapshots, per-client area of interest, bots |
| `packages/client` | prediction/reconciliation, interpolation, culling, Canvas renderer |

## The three techniques

1. **Prediction + reconciliation** (`client/src/game.ts`: `update`, `onSnapshot`)
   Every fixed 60 Hz tick the client builds `{seq, dx, dy}`, applies it locally with the shared `applyInput`, and keeps it in `pending`.
   Snapshots carry `ack` (last seq the server processed). On receipt: take the server's position, drop acked inputs, replay the rest.
   The difference between old and new predicted position is added to a visual `err` offset that decays (~100 ms), so corrections never pop.
2. **Entity interpolation** (`Game.interpolate`)
   Remote orbs get a snapshot buffer and are drawn `INTERP_DELAY_MS` (100 ms = 2 snapshot intervals at 20 Hz) in the past,
   lerping between the two samples around that time. Server timestamps are mapped to the local clock with an EMA offset.
3. **Viewport culling via spatial hash** (`shared/src/spatial.ts`, `render.ts`)
   Server: a hash over food/players builds each client's AOI and sends food as add/remove deltas (not full lists).
   Client: its own hash is queried with the camera rectangle, so only on-screen food is drawn.

## Demo keys
`L` latency · `P` prediction · `I` interpolation · `G` server ghost · `H` HUD.
Turn prediction off at 200 ms to feel the difference; turn on the ghost to see reconciliation.

## Notes / next steps
- Interpolation delay is 100 ms rather than 50 ms: at 20 Hz snapshots, 50 ms would often have only one sample. Raise `SNAPSHOT_RATE` to 30 and drop the delay for tighter feel.
- World is a large bounded map (6000²), not truly infinite.
- Not done: split/eject, input rate-limiting beyond queue caps, binary protocol, tests beyond `smoke`.
