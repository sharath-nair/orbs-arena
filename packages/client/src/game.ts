import {
  SpatialHash, TICK_DT, applyInput,
  type Body, type InputCmd, type Snapshot, type Welcome,
} from '@orbs/shared';
import type { Net } from './net';

/** Opponents are rendered this far in the past so we (almost) always have two snapshots to lerp between. */
export const INTERP_DELAY_MS = 100; // 2 snapshot intervals at 20Hz

export interface Food { id: number; x: number; y: number; hue: number }
interface Sample { t: number; x: number; y: number; mass: number }
export interface Remote {
  id: number;
  buf: Sample[];
  lastT: number;
  /** interpolated (render) state, filled by Game.interpolate() */
  x: number; y: number; mass: number;
}
export interface PlayerInfo { name: string; hue: number }

export class Game {
  // identity / lifecycle
  myId = 0;
  alive = false;
  killedBy: string | null = null;

  // toggles (for demoing the techniques)
  prediction = true;
  interpolation = true;
  showGhost = false;

  // --- client-side prediction state ---
  /** Predicted (local) body: authoritative state + replayed unacked inputs. */
  pred: Body = { x: 0, y: 0, mass: 0 };
  /** Last authoritative position of me, for the debug ghost. */
  server: Body = { x: 0, y: 0, mass: 0 };
  private pending: InputCmd[] = [];
  private seq = 0;
  private acc = 0;
  /** Visual correction offset. Reconciliation snaps `pred`; we hide the jump by decaying this to 0. */
  private err = { x: 0, y: 0 };
  lastCorrection = 0;
  aim = { x: 0, y: 0 };

  // --- other entities ---
  remotes = new Map<number, Remote>();
  info = new Map<number, PlayerInfo>();
  food = new Map<number, Food>();
  /** Client-side spatial hash over food: drives viewport culling in the renderer. */
  foodHash = new SpatialHash<Food>(256);
  leaderboard: [string, number][] = [];
  online = 0;

  // --- timing ---
  /** EMA of (local receive time - server timestamp); maps server clock -> local clock. */
  private clockOffset: number | null = null;
  snapsPerSec = 0;
  private snapCount = 0;
  private snapWindow = performance.now();
  rtt = 0;

  constructor(private net: Net) {
    net.on<Welcome>('welcome', (w) => this.onWelcome(w));
    net.on<Snapshot>('snap', (s) => this.onSnapshot(s));
    net.on<{ by: string | null }>('dead', (d) => { this.alive = false; this.killedBy = d.by; onDeath?.(); });
    setInterval(() => net.ping().then((r) => (this.rtt = r)), 1000);
  }

  // ---------------------------------------------------------------------
  join(name: string) { this.net.emit('join', { name }); }

  private onWelcome(w: Welcome) {
    this.myId = w.id;
    this.alive = true;
    this.pred = { ...w.spawn };
    this.server = { ...w.spawn };
    this.pending = [];
    this.err = { x: 0, y: 0 };
    this.remotes.clear();
    this.food.clear();
    this.foodHash = new SpatialHash<Food>(256);
    this.seq = 0;
    this.acc = 0;
    onSpawn?.();
  }

  // --- fixed-step input + prediction -------------------------------------
  update(dt: number) {
    if (!this.alive) return;
    this.acc += dt;
    const batch: InputCmd[] = [];
    let steps = 0;
    while (this.acc >= TICK_DT && steps++ < 5) {
      this.acc -= TICK_DT;
      const cmd: InputCmd = { seq: ++this.seq, dx: this.aim.x, dy: this.aim.y };
      // 1) Predict: apply the input locally *immediately* with the same code the server runs.
      if (this.prediction) applyInput(this.pred, cmd);
      // 2) Remember it until the server acknowledges it, so we can replay on reconcile.
      this.pending.push(cmd);
      batch.push(cmd);
    }
    if (steps > 5) this.acc = 0;
    if (batch.length) this.net.emit('input', batch);

    // decay the visual smoothing offset
    const k = Math.exp(-dt * 12);
    this.err.x *= k; this.err.y *= k;

    const nowSrv = this.serverNow();
    if (nowSrv !== null) this.interpolate(nowSrv - INTERP_DELAY_MS);
  }

  private onSnapshot(s: Snapshot) {
    // clock sync
    const sample = performance.now() - s.t;
    this.clockOffset = this.clockOffset === null ? sample : this.clockOffset + (sample - this.clockOffset) * 0.05;

    this.snapCount++;
    const now = performance.now();
    if (now - this.snapWindow >= 1000) {
      this.snapsPerSec = (this.snapCount * 1000) / (now - this.snapWindow);
      this.snapCount = 0; this.snapWindow = now;
    }
    this.online = s.online;
    if (s.lb) this.leaderboard = s.lb;

    // --- self: reconciliation ---
    this.server = { x: s.me[0], y: s.me[1], mass: s.me[2] };
    // Everything the server has processed is now baked into s.me; drop it.
    while (this.pending.length && this.pending[0].seq <= s.ack) this.pending.shift();
    if (this.alive) {
      const before = { x: this.pred.x, y: this.pred.y };
      const next: Body = { ...this.server };
      // Replay inputs the server hasn't seen yet on top of the authoritative state.
      if (this.prediction) for (const c of this.pending) applyInput(next, c);
      const dx = before.x - next.x, dy = before.y - next.y;
      this.lastCorrection = Math.hypot(dx, dy);
      this.pred = next;
      if (this.lastCorrection > 150) this.err = { x: 0, y: 0 }; // teleport-sized: just snap
      else { this.err.x += dx; this.err.y += dy; }               // small: blend out over ~100ms
    }

    // --- others: buffer for interpolation ---
    for (const [id, name, hue] of s.ni) this.info.set(id, { name, hue });
    for (const [id, x, y, mass] of s.p) {
      let r = this.remotes.get(id);
      if (!r) this.remotes.set(id, (r = { id, buf: [], lastT: s.t, x, y, mass }));
      r.buf.push({ t: s.t, x, y, mass });
      if (r.buf.length > 20) r.buf.shift();
      r.lastT = s.t;
    }
    for (const id of s.gone) { this.remotes.delete(id); this.info.delete(id); }

    // --- food (static; applied immediately) ---
    for (const id of s.fr) {
      const f = this.food.get(id);
      if (f) { this.food.delete(id); this.foodHash.remove(f); }
    }
    for (const [id, x, y, hue] of s.fa) {
      const f: Food = { id, x, y, hue };
      this.food.set(id, f);
      this.foodHash.insert(f);
    }
  }

  serverNow(): number | null {
    return this.clockOffset === null ? null : performance.now() - this.clockOffset;
  }

  /** Entity interpolation: lerp between the two buffered snapshots that straddle renderT. */
  private interpolate(renderT: number) {
    for (const r of this.remotes.values()) {
      const b = r.buf;
      if (!this.interpolation || b.length === 1) {
        const l = b[b.length - 1]; r.x = l.x; r.y = l.y; r.mass = l.mass; continue;
      }
      // drop samples that are older than the "from" sample
      while (b.length > 2 && b[1].t <= renderT) b.shift();
      const a = b[0], c = b[1];
      if (renderT >= c.t) { r.x = c.x; r.y = c.y; r.mass = c.mass; continue; } // starved: hold last known
      const u = Math.max(0, (renderT - a.t) / (c.t - a.t));
      r.x = a.x + (c.x - a.x) * u;
      r.y = a.y + (c.y - a.y) * u;
      r.mass = a.mass + (c.mass - a.mass) * u;
    }
  }

  /** What to draw for me. */
  selfRender(): Body {
    if (!this.prediction) return this.server; // no prediction: you see yourself one RTT/2 + snapshot delay late
    return { x: this.pred.x + this.err.x, y: this.pred.y + this.err.y, mass: this.pred.mass };
  }
  get pendingInputs() { return this.pending.length; }
}

// tiny event hooks set from main.ts
let onDeath: (() => void) | undefined;
let onSpawn: (() => void) | undefined;
export const hooks = {
  set death(f: () => void) { onDeath = f; },
  set spawn(f: () => void) { onSpawn = f; },
};
