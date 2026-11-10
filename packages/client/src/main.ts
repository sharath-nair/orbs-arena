import { Game, hooks } from './game';
import { Net } from './net';
import { Renderer } from './render';

const params = new URLSearchParams(location.search);
const net = new Net(`${location.protocol}//${location.hostname}:3001`);
net.latency = Number(params.get('lag') ?? 0);
net.jitter = Number(params.get('jitter') ?? 0);

const game = new Game(net);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
renderer.latency = net.latency;

// ---- menu ----
const menu = document.getElementById('menu')!;
const nameInput = document.getElementById('name') as HTMLInputElement;
const play = document.getElementById('play') as HTMLButtonElement;
const msg = document.getElementById('msg')!;
nameInput.value = localStorage.getItem('orbs:name') ?? '';

const start = () => {
  localStorage.setItem('orbs:name', nameInput.value);
  game.join(nameInput.value);
};
play.onclick = start;
nameInput.onkeydown = (e) => { if (e.key === 'Enter') start(); };
net.socket.on('connect', () => { play.disabled = false; play.textContent = 'Play'; });
net.socket.on('disconnect', () => { play.disabled = true; play.textContent = 'Reconnecting…'; menu.classList.remove('hidden'); });
hooks.spawn = () => { menu.classList.add('hidden'); msg.textContent = ''; };
hooks.death = () => {
  msg.textContent = game.killedBy ? `Eaten by ${game.killedBy}` : 'You died';
  play.textContent = 'Play again';
  menu.classList.remove('hidden');
};

// ---- input: mouse/touch -> direction vector (length 0..1) ----
addEventListener('pointermove', (e) => {
  const dx = e.clientX - innerWidth / 2, dy = e.clientY - innerHeight / 2;
  const len = Math.hypot(dx, dy);
  if (len < 1) { game.aim = { x: 0, y: 0 }; return; }
  const mag = Math.min(1, len / (Math.min(innerWidth, innerHeight) * 0.2)); // slow down near the centre
  game.aim = { x: (dx / len) * mag, y: (dy / len) * mag };
});

// ---- debug toggles ----
const LAGS = [0, 50, 100, 200, 400];
addEventListener('keydown', (e) => {
  if (document.activeElement === nameInput) return;
  switch (e.key.toLowerCase()) {
    case 'l': { net.latency = LAGS[(LAGS.indexOf(net.latency) + 1) % LAGS.length] ?? 0; renderer.latency = net.latency; break; }
    case 'p': game.prediction = !game.prediction; break;
    case 'i': game.interpolation = !game.interpolation; break;
    case 'g': game.showGhost = !game.showGhost; break;
    case 'h': renderer.hud = !renderer.hud; break;
  }
});

// ---- main loop ----
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  renderer.draw(game, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
