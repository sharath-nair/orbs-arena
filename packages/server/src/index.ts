import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  AOI_HALF_H, AOI_HALF_W, FOOD_COUNT, FOOD_MASS, MAX_INPUTS_PER_MSG, SNAPSHOT_RATE, SpatialHash,
  START_MASS, TICK_DT, TICK_RATE, WORLD_SIZE, applyInput, radiusOf, sanitizeInput,
  type InputCmd, type Snapshot, type Welcome,
} from '@orbs/shared';

const PORT = Number(process.env.PORT ?? 3001);
const BOTS = Number(process.env.BOTS ?? 25);
const MAX_QUEUE = 30;

interface Food { id: number; x: number; y: number; hue: number }
interface Player {
  id: number; x: number; y: number; mass: number;
  name: string; hue: number;
  queue: InputCmd[]; lastSeq: number;
  socket?: Socket;
  bot?: { tx: number; ty: number; retarget: number };
  knownPlayers: Set<number>; knownFood: Set<number>;
  dead: boolean;
}

let nextId = 1;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const players = new Map<number, Player>();
const playerHash = new SpatialHash<Player>(512);
const foodHash = new SpatialHash<Food>(128);
let gone: number[] = [];

// ---- World ----------------------------------------------------------------
function spawnFood() {
  const f: Food = { id: nextId++, x: rand(10, WORLD_SIZE - 10), y: rand(10, WORLD_SIZE - 10), hue: Math.floor(rand(0, 360)) };
  foodHash.insert(f);
}
for (let i = 0; i < FOOD_COUNT; i++) spawnFood();

const BOT_NAMES = ['Nova', 'Pip', 'Moss', 'Echo', 'Zed', 'Blip', 'Orbit', 'Kiwi', 'Rune', 'Fizz', 'Juno', 'Taro'];
function spawnPlayer(name: string, socket?: Socket): Player {
  const p: Player = {
    id: nextId++, x: rand(200, WORLD_SIZE - 200), y: rand(200, WORLD_SIZE - 200), mass: START_MASS,
    name, hue: Math.floor(rand(0, 360)), queue: [], lastSeq: 0, socket,
    knownPlayers: new Set(), knownFood: new Set(), dead: false,
  };
  if (!socket) p.bot = { tx: p.x, ty: p.y, retarget: 0 };
  players.set(p.id, p);
  playerHash.insert(p);
  return p;
}
function spawnBot() {
  spawnPlayer(`${BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]}${Math.floor(rand(10, 99))}`);
}
for (let i = 0; i < BOTS; i++) spawnBot();

function kill(victim: Player, killer?: Player) {
  if (victim.dead) return;
  victim.dead = true;
  players.delete(victim.id);
  playerHash.remove(victim);
  gone.push(victim.id);
  victim.socket?.emit('dead', { by: killer?.name ?? null });
  if (victim.bot) setTimeout(spawnBot, 2000);
}

// ---- Bots (they go through the same applyInput as humans) -----------------
function botThink(b: Player, tick: number) {
  const bot = b.bot!;
  if (tick >= bot.retarget) {
    bot.retarget = tick + 15 + Math.floor(Math.random() * 15);
    const r = 350;
    let best = Infinity;
    let flee: Player | null = null;
    playerHash.query(b.x - r, b.y - r, b.x + r, b.y + r, (o) => {
      if (o === b) return;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (o.mass > b.mass * 1.25 && d < 300) flee = o;
      else if (b.mass > o.mass * 1.4 && d < best) { best = d; bot.tx = o.x; bot.ty = o.y; }
    });
    if (flee) {
      const f = flee as Player;
      bot.tx = b.x - (f.x - b.x); bot.ty = b.y - (f.y - b.y);
    } else if (best === Infinity) {
      let bd = Infinity;
      foodHash.query(b.x - r, b.y - r, b.x + r, b.y + r, (f) => {
        const d = Math.hypot(f.x - b.x, f.y - b.y);
        if (d < bd) { bd = d; bot.tx = f.x; bot.ty = f.y; }
      });
      if (bd === Infinity) { bot.tx = rand(0, WORLD_SIZE); bot.ty = rand(0, WORLD_SIZE); }
    }
  }
  const dx = bot.tx - b.x, dy = bot.ty - b.y;
  const len = Math.hypot(dx, dy) || 1;
  applyInput(b, { seq: 0, dx: (dx / len) * Math.min(1, len / 40), dy: (dy / len) * Math.min(1, len / 40) });
}

// ---- Tick -----------------------------------------------------------------
let tick = 0;
function step() {
  tick++;
  for (const p of players.values()) {
    if (p.bot) botThink(p, tick);
    else {
      // Consume buffered inputs: 1 per tick, 2 when catching up after jitter.
      const n = Math.min(p.queue.length, p.queue.length > 1 ? 2 : 1);
      for (let i = 0; i < n; i++) {
        const c = p.queue.shift()!;
        applyInput(p, c);
        p.lastSeq = c.seq;
      }
    }
    // slow mass decay so giants shrink back
    p.mass -= (p.mass - START_MASS) * 0.002 * TICK_DT;
    playerHash.update(p);
  }

  // food
  for (const p of players.values()) {
    const r = radiusOf(p.mass);
    const eaten: Food[] = [];
    foodHash.query(p.x - r, p.y - r, p.x + r, p.y + r, (f) => {
      if ((f.x - p.x) ** 2 + (f.y - p.y) ** 2 < r * r) eaten.push(f);
    });
    for (const f of eaten) { foodHash.remove(f); p.mass += FOOD_MASS; spawnFood(); }
  }

  // players eating players
  for (const p of [...players.values()]) {
    if (p.dead) continue;
    const r = radiusOf(p.mass);
    playerHash.query(p.x - r, p.y - r, p.x + r, p.y + r, (q) => {
      if (q === p || q.dead || p.dead) return;
      if (p.mass > q.mass * 1.25 && Math.hypot(p.x - q.x, p.y - q.y) < r - radiusOf(q.mass) * 0.5) {
        p.mass += q.mass * 0.8;
        kill(q, p);
      }
    });
  }

  if (tick % (TICK_RATE / SNAPSHOT_RATE) === 0) broadcast();
}

const r1 = (n: number) => Math.round(n * 10) / 10;
function broadcast() {
  const sendLb = tick % TICK_RATE === 0;
  const lb: [string, number][] | undefined = sendLb
    ? [...players.values()].sort((a, b) => b.mass - a.mass).slice(0, 8).map((p) => [p.name, Math.round(p.mass)])
    : undefined;
  const t = performance.now();
  let online = 0;
  for (const p of players.values()) if (p.socket) online++;

  for (const me of players.values()) {
    if (!me.socket) continue;
    const x0 = me.x - AOI_HALF_W, x1 = me.x + AOI_HALF_W, y0 = me.y - AOI_HALF_H, y1 = me.y + AOI_HALF_H;

    const p: Snapshot['p'] = [];
    const ni: Snapshot['ni'] = [];
    playerHash.query(x0, y0, x1, y1, (o) => {
      if (o === me) return;
      p.push([o.id, r1(o.x), r1(o.y), r1(o.mass)]);
      if (!me.knownPlayers.has(o.id)) { me.knownPlayers.add(o.id); ni.push([o.id, o.name, o.hue]); }
    });
    for (const id of gone) me.knownPlayers.delete(id);

    const cur = new Set<number>();
    const fa: Snapshot['fa'] = [];
    foodHash.query(x0, y0, x1, y1, (f) => {
      cur.add(f.id);
      if (!me.knownFood.has(f.id)) fa.push([f.id, r1(f.x), r1(f.y), f.hue]);
    });
    const fr: number[] = [];
    for (const id of me.knownFood) if (!cur.has(id)) fr.push(id);
    me.knownFood = cur;

    const snap: Snapshot = { t, ack: me.lastSeq, me: [me.x, me.y, me.mass], p, ni, fa, fr, gone, online };
    if (lb) snap.lb = lb;
    me.socket.emit('snap', snap);
  }
  gone = [];
}

// fixed-timestep loop with catch-up, independent of setInterval jitter
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(250, now - last);
  last = now;
  while (acc >= TICK_DT * 1000) { step(); acc -= TICK_DT * 1000; }
}, 4);

// ---- Networking -----------------------------------------------------------
const http = createServer((_, res) => { res.writeHead(200).end('orbs-arena server ok'); });
const io = new Server(http, { cors: { origin: true }, transports: ['websocket'], perMessageDeflate: false });

io.on('connection', (socket) => {
  let me: Player | null = null;

  socket.on('join', (data: { name?: unknown }) => {
    if (me && !me.dead) return;
    const name = (typeof data?.name === 'string' ? data.name : '').trim().slice(0, 16) || 'anon';
    me = spawnPlayer(name, socket);
    const w: Welcome = { id: me.id, spawn: { x: me.x, y: me.y, mass: me.mass } };
    socket.emit('welcome', w);
  });

  socket.on('input', (cmds: unknown) => {
    if (!me || me.dead || !Array.isArray(cmds)) return;
    for (const raw of cmds.slice(0, MAX_INPUTS_PER_MSG)) {
      const c = sanitizeInput(raw);
      if (!c || c.seq <= (me.queue.at(-1)?.seq ?? me.lastSeq)) continue; // drop stale/duplicate
      if (me.queue.length < MAX_QUEUE) me.queue.push(c);
    }
  });

  socket.on('ping', (_t: number, ack?: () => void) => ack?.());

  socket.on('disconnect', () => { if (me) kill(me); });
});

http.listen(PORT, () => console.log(`orbs-arena server on :${PORT} (${TICK_RATE}Hz sim, ${SNAPSHOT_RATE}Hz snapshots, ${BOTS} bots, ${FOOD_COUNT} food)`));
