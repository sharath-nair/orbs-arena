/**
 * Determinism check: replays the same inputs locally with the shared
 * applyInput and compares against the server's authoritative position.
 * Run with the server up:  npm run smoke
 */
import { io } from 'socket.io-client';
import { TICK_DT, applyInput, type Snapshot, type Welcome } from '@orbs/shared';

const socket = io(`http://localhost:${process.env.PORT ?? 3001}`, { transports: ['websocket'] });
const N = 90;
const local = { x: 0, y: 0, mass: 0 };
const sent: { seq: number; dx: number; dy: number }[] = [];
let snaps = 0;
let lastSnap: Snapshot | null = null;

socket.on('connect', () => socket.emit('join', { name: 'smoke' }));
socket.on('welcome', (w: Welcome) => {
  Object.assign(local, w.spawn);
  let seq = 0;
  const timer = setInterval(() => {
    seq++;
    const c = { seq, dx: Math.cos(seq / 20), dy: Math.sin(seq / 20) };
    sent.push(c);
    socket.emit('input', [c]);
    if (seq >= N) clearInterval(timer);
  }, TICK_DT * 1000);
});
socket.on('snap', (s: Snapshot) => {
  snaps++;
  lastSnap = s;
  if (s.ack >= N) finish(s);
});

let done = false;
function finish(s: Snapshot) {
  if (done) return;
  done = true;
  const sim = { ...local };
  for (const c of sent.filter((c) => c.seq <= s.ack)) applyInput(sim, c);
  const err = Math.hypot(sim.x - s.me[0], sim.y - s.me[1]);
  console.log(`snapshots=${snaps} ack=${s.ack} visible players=${s.p.length} food in AOI=${s.fa.length}`);
  console.log(`server=(${s.me[0].toFixed(2)}, ${s.me[1].toFixed(2)}) local replay=(${sim.x.toFixed(2)}, ${sim.y.toFixed(2)}) error=${err.toFixed(3)}`);
  const ok = err < 3; // small slack: eating food changes mass -> speed
  console.log(ok ? 'PASS: prediction matches server' : 'FAIL: prediction diverged');
  process.exit(ok ? 0 : 1);
}
setTimeout(() => { console.log('FAIL: timeout', lastSnap?.ack); process.exit(1); }, 8000);
