import { AOI_HALF_H, AOI_HALF_W, FOOD_COUNT, FOOD_RADIUS, WORLD_SIZE, radiusOf } from '@orbs/shared';
import type { Food, Game } from './game';

const GRID = 100;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  fps = 60;
  hud = true;
  latency = 0;
  foodDrawn = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
  }

  draw(g: Game, dt: number) {
    const { ctx, w, h, dpr } = this;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1220';
    ctx.fillRect(0, 0, w, h);

    const me = g.alive ? g.selfRender() : g.server;
    const r = radiusOf(Math.max(me.mass, 1));
    // zoom out as you grow; never zoom out past what the server streams (the AOI)
    const target = Math.max(h / (700 + r * 6), w / (AOI_HALF_W * 2) * 1.02, h / (AOI_HALF_H * 2) * 1.02);
    this.scale += (target - this.scale) * Math.min(1, dt * 4);
    const s = this.scale;
    const cx = me.x, cy = me.y;

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (w / 2 - cx * s), dpr * (h / 2 - cy * s));
    const vx0 = cx - w / 2 / s, vx1 = cx + w / 2 / s, vy0 = cy - h / 2 / s, vy1 = cy + h / 2 / s;

    this.drawGrid(vx0, vy0, vx1, vy1, s);

    // ---- Viewport culling: ask the spatial hash for ONLY the food inside the camera rect ----
    const buckets: Food[][] = Array.from({ length: 12 }, () => []);
    let drawn = 0;
    g.foodHash.query(vx0 - FOOD_RADIUS, vy0 - FOOD_RADIUS, vx1 + FOOD_RADIUS, vy1 + FOOD_RADIUS, (f) => {
      buckets[(f.hue / 30) | 0].push(f);
      drawn++;
    });
    this.foodDrawn = drawn;
    for (let i = 0; i < buckets.length; i++) {
      if (!buckets[i].length) continue;
      ctx.fillStyle = `hsl(${i * 30 + 15} 80% 62%)`;
      ctx.beginPath();
      for (const f of buckets[i]) { ctx.moveTo(f.x + FOOD_RADIUS, f.y); ctx.arc(f.x, f.y, FOOD_RADIUS, 0, Math.PI * 2); }
      ctx.fill();
    }

    // ---- players (smallest first so big ones overlap) ----
    type Item = { x: number; y: number; mass: number; name: string; hue: number; self: boolean };
    const items: Item[] = [];
    for (const rm of g.remotes.values()) {
      const rr = radiusOf(rm.mass);
      if (rm.x + rr < vx0 || rm.x - rr > vx1 || rm.y + rr < vy0 || rm.y - rr > vy1) continue;
      const inf = g.info.get(rm.id);
      items.push({ x: rm.x, y: rm.y, mass: rm.mass, name: inf?.name ?? '', hue: inf?.hue ?? 0, self: false });
    }
    if (g.alive) items.push({ x: me.x, y: me.y, mass: me.mass, name: 'you', hue: 210, self: true });
    items.sort((a, b) => a.mass - b.mass);
    for (const it of items) this.drawOrb(it.x, it.y, it.mass, it.name, it.hue, it.self);

    if (g.alive && g.showGhost) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([6 / s, 6 / s]);
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.arc(g.server.x, g.server.y, radiusOf(g.server.mass), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // world border
    ctx.strokeStyle = '#ff5b6e';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawUi(g, items.length);
  }

  private drawGrid(x0: number, y0: number, x1: number, y1: number, s: number) {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1 / s;
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(x0 / GRID) * GRID); x <= Math.min(WORLD_SIZE, x1); x += GRID) { ctx.moveTo(x, Math.max(0, y0)); ctx.lineTo(x, Math.min(WORLD_SIZE, y1)); }
    for (let y = Math.max(0, Math.floor(y0 / GRID) * GRID); y <= Math.min(WORLD_SIZE, y1); y += GRID) { ctx.moveTo(Math.max(0, x0), y); ctx.lineTo(Math.min(WORLD_SIZE, x1), y); }
    ctx.stroke();
  }

  private drawOrb(x: number, y: number, mass: number, name: string, hue: number, self: boolean) {
    const { ctx } = this;
    const r = radiusOf(mass);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue} 70% 55%)`;
    ctx.fill();
    ctx.lineWidth = Math.max(3, r * 0.08);
    ctx.strokeStyle = `hsl(${hue} 70% 38%)`;
    ctx.stroke();
    if (self) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(); }
    if (name) {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.max(12, r * 0.45)}px system-ui, sans-serif`;
      ctx.fillText(name, x, y);
    }
  }

  private drawUi(g: Game, visibleOrbs: number) {
    const { ctx, w } = this;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`Online ${g.online}`, w - 14, 12);
    ctx.font = '13px system-ui, sans-serif';
    g.leaderboard.forEach(([n, m], i) => {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(`${i + 1}. ${n}  ${m}`, w - 14, 36 + i * 18);
    });

    if (g.alive) {
      ctx.textAlign = 'center';
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(`Mass ${Math.round(g.pred.mass)}`, w / 2, 14);
    }
    if (!this.hud) return;

    const lines = [
      `${this.fps.toFixed(0)} fps · RTT ${g.rtt.toFixed(0)}ms (sim one-way ${this.latency}ms)`,
      `snapshots ${g.snapsPerSec.toFixed(1)}/s`,
      `food: drawn ${this.foodDrawn} / known ${g.food.size} / world ${FOOD_COUNT}`,
      `orbs drawn ${visibleOrbs} / known ${g.remotes.size + 1}`,
      `[P] prediction ${g.prediction ? 'ON' : 'OFF'}   [I] interpolation ${g.interpolation ? 'ON' : 'OFF'}`,
      `[G] ghost ${g.showGhost ? 'ON' : 'OFF'}   [L] latency`,
      `unacked inputs ${g.pendingInputs} · last correction ${g.lastCorrection.toFixed(2)}px`,
    ];
    ctx.textAlign = 'left';
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(8, 8, 360, lines.length * 16 + 10);
    ctx.fillStyle = '#cfe3ff';
    lines.forEach((l, i) => ctx.fillText(l, 14, 13 + i * 16));
  }
}
