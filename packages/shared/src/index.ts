/**
 * Shared simulation code. Both the server (authoritative) and the client
 * (prediction + reconciliation replay) import `applyInput`, so they can never
 * drift apart because of duplicated movement logic.
 */
export * from './spatial';

// ---- World / tuning -------------------------------------------------------
export const WORLD_SIZE = 6000;
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 20;
export const FOOD_COUNT = 5000;
export const FOOD_RADIUS = 5;
export const FOOD_MASS = 1;
export const START_MASS = 20;
/** Area of interest: half extents of the region the server streams to a client. */
export const AOI_HALF_W = 1500;
export const AOI_HALF_H = 1000;
export const MAX_INPUTS_PER_MSG = 10;

export const radiusOf = (mass: number) => 4 * Math.sqrt(mass);
export const speedOf = (mass: number) => 300 * Math.pow(mass, -0.12);

// ---- Simulation -----------------------------------------------------------
export interface Body {
  x: number;
  y: number;
  mass: number;
}

/** One client input for one fixed simulation tick. (dx,dy) has length <= 1. */
export interface InputCmd {
  seq: number;
  dx: number;
  dy: number;
}

export function sanitizeInput(c: unknown): InputCmd | null {
  if (!c || typeof c !== 'object') return null;
  const { seq, dx, dy } = c as Record<string, unknown>;
  if (!Number.isInteger(seq) || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return { seq: seq as number, dx: dx as number, dy: dy as number };
}

/** Deterministic movement step. Mutates and returns `b`. */
export function applyInput(b: Body, c: InputCmd, dt = TICK_DT): Body {
  const len = Math.hypot(c.dx, c.dy);
  const k = len > 1 ? 1 / len : 1; // clamp magnitude so clients can't speed-hack
  const v = speedOf(b.mass) * dt;
  const r = radiusOf(b.mass);
  b.x = Math.min(WORLD_SIZE - r, Math.max(r, b.x + c.dx * k * v));
  b.y = Math.min(WORLD_SIZE - r, Math.max(r, b.y + c.dy * k * v));
  return b;
}

// ---- Protocol -------------------------------------------------------------
export interface Welcome {
  id: number;
  spawn: Body;
}

/** Compact snapshot streamed at SNAPSHOT_RATE. Tuples keep the JSON small. */
export interface Snapshot {
  /** server clock (ms) */
  t: number;
  /** last input seq the server processed for this client */
  ack: number;
  me: [x: number, y: number, mass: number];
  /** visible other players [id, x, y, mass] */
  p: [number, number, number, number][];
  /** newly visible player info [id, name, hue] */
  ni: [number, string, number][];
  /** food entering the AOI [id, x, y, hue] */
  fa: [number, number, number, number][];
  /** food leaving the AOI / eaten */
  fr: number[];
  /** players that died or disconnected */
  gone: number[];
  /** leaderboard (sent ~1/s) */
  lb?: [string, number][];
  online: number;
}
