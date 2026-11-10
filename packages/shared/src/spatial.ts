export interface Positioned {
  id: number;
  x: number;
  y: number;
}

/**
 * Uniform-grid spatial hash. O(1) insert/remove/move, and range queries touch
 * only the cells overlapping the rectangle. Used by the server (AOI, collisions)
 * and by the client (viewport culling).
 */
export class SpatialHash<T extends Positioned> {
  private cells = new Map<number, Set<T>>();
  private where = new Map<T, number>();

  constructor(private readonly cell: number) {}

  get size() {
    return this.where.size;
  }

  private cellKey(cx: number, cy: number) {
    return cx * 100003 + cy;
  }
  private keyOf(x: number, y: number) {
    return this.cellKey(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  insert(item: T) {
    const k = this.keyOf(item.x, item.y);
    let set = this.cells.get(k);
    if (!set) this.cells.set(k, (set = new Set()));
    set.add(item);
    this.where.set(item, k);
  }

  remove(item: T) {
    const k = this.where.get(item);
    if (k === undefined) return;
    const set = this.cells.get(k)!;
    set.delete(item);
    if (set.size === 0) this.cells.delete(k);
    this.where.delete(item);
  }

  /** Call after mutating item.x / item.y. */
  update(item: T) {
    const old = this.where.get(item);
    const k = this.keyOf(item.x, item.y);
    if (old === k) return;
    this.remove(item);
    this.insert(item);
  }

  /** Calls fn for every item whose point lies inside the rectangle. */
  query(minX: number, minY: number, maxX: number, maxY: number, fn: (item: T) => void) {
    const c = this.cell;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const y0 = Math.floor(minY / c), y1 = Math.floor(maxY / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const set = this.cells.get(this.cellKey(cx, cy));
        if (!set) continue;
        for (const it of set) {
          if (it.x >= minX && it.x <= maxX && it.y >= minY && it.y <= maxY) fn(it);
        }
      }
    }
  }
}
