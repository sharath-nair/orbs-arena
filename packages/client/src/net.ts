import { io, type Socket } from 'socket.io-client';

/**
 * Thin socket wrapper with an optional simulated one-way latency + jitter in
 * BOTH directions. Delivery is kept in order (like TCP/WebSocket would), so
 * jitter shows up as bursts rather than reordering.
 */
export class Net {
  readonly socket: Socket;
  latency = 0; // one-way ms
  jitter = 0;
  private lastIn = 0;
  private lastOut = 0;

  constructor(url: string) {
    this.socket = io(url, { transports: ['websocket'] });
  }

  private schedule(kind: 'in' | 'out', fn: () => void) {
    if (this.latency <= 0 && this.jitter <= 0) return fn();
    const at = Math.max(
      performance.now() + this.latency + Math.random() * this.jitter,
      kind === 'in' ? this.lastIn : this.lastOut,
    );
    if (kind === 'in') this.lastIn = at; else this.lastOut = at;
    setTimeout(fn, Math.max(0, at - performance.now()));
  }

  onRaw(ev: string, fn: (...a: any[]) => void) { this.socket.on(ev, fn); }
  on<T>(ev: string, fn: (data: T) => void) { this.socket.on(ev, (d: T) => this.schedule('in', () => fn(d))); }
  emit(ev: string, data?: unknown) { this.schedule('out', () => this.socket.emit(ev, data)); }

  ping(): Promise<number> {
    const t0 = performance.now();
    return new Promise((res) => {
      this.schedule('out', () => this.socket.emit('ping', t0, () => this.schedule('in', () => res(performance.now() - t0))));
    });
  }
}
