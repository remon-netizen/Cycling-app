import { loadRoute } from './route.js';
import { World } from './world.js';
import { Trainer, HeartRate, bluetoothAvailable } from './ble.js';
import { stepSpeed, estimateTime, airAsGrade, draftSaving, drag, cdaFor, CRR } from './physics.js';
import { Weather } from './weather.js';
import { Net, cleanCode, newCode } from './net.js';
import { History, buildRecord, summarise, improvements, WINDOW_NAMES } from './history.js';
import { RouteProfile, AheadProfile, MiniMap, gradeColor } from './hud.js';
import { buildTcx, download } from './tcx.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------- settings ----------
const settings = Object.assign(
  { weight: 75, bike: 8.5, ftp: 220, difficulty: 100, weather: 'live' },
  JSON.parse(localStorage.getItem('sommet.settings') || '{}')
);
const fields = { weight: $('i-weight'), bike: $('i-bike'), ftp: $('i-ftp'), difficulty: $('i-diff') };
for (const [key, el] of Object.entries(fields)) {
  el.value = settings[key];
  el.addEventListener('change', () => {
    const v = parseFloat(el.value);
    if (isFinite(v)) settings[key] = Math.min(+el.max, Math.max(+el.min, v));
    el.value = settings[key];
    localStorage.setItem('sommet.settings', JSON.stringify(settings));
  });
}
const totalMass = () => settings.weight + settings.bike;
const toGo = () => (route.climb && ride.endDist >= route.total ? 'to the top' : 'to go');

// ---------- state ----------
const trainer = new Trainer();
const hrm = new HeartRate();
let route, world, profile, ahead, minimap, weather;
const wind = { speed: 0, head: 0, side: 0, wx: 0, wz: 0, temp: 15, cloud: 0, exposure: 1, forest: false, draft: 0 };
const botWind = { draft: 0 }, noDraft = {}, gaps = [];
const net = new Net();
const remotes = new Map(); // peer id -> 3D rider
const history = new History(net);

const ride = {
  active: false, finished: false, startDist: 0, startDate: null,
  dist: 0, endDist: Infinity, v: 0, crank: 0, power: 0, cadence: 0, hr: 0, shownPower: 0,
  moving: 0, wall: 0, climbed: 0, energy: 0, powerSum: 0, hrSum: 0, hrTime: 0, cadSum: 0, cadTime: 0,
  samples: [], demoPower: Math.max(0, parseFloat(params.get('demo')) || 200), eta: Infinity, recent: [],
  nextLandmark: 0, sentGrade: null, sentAt: 0, secAcc: 0, etaAcc: 0, windWork: 0, draftWork: 0, braking: false, wasForest: null, trainerTime: 0, saved: false,
};
const bots = [];

const fmtTime = (s) => {
  if (!isFinite(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function zoneColor(p) {
  const r = p / settings.ftp;
  if (r < 0.55) return '#c9d0db';
  if (r < 0.76) return '#6fb7ff';
  if (r < 0.91) return '#62d27a';
  if (r < 1.06) return '#f1d94a';
  if (r < 1.21) return '#f79a3e';
  return '#f2594b';
}

let toastTimer;
function toast(text, ms = 6000) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- devices ----------
function deviceUi() {
  const t = $('b-trainer'), h = $('b-hr');
  t.className = 'chip' + (trainer.connected ? ' on' : trainer.device && trainer._wanted ? ' lost' : '');
  t.lastElementChild.textContent = trainer.connected ? trainer.name : trainer.device && trainer._wanted ? 'Trainer reconnecting…' : 'Connect trainer';
  h.className = 'chip' + (hrm.connected ? ' on' : hrm.device && hrm._wanted ? ' lost' : '');
  h.lastElementChild.textContent = hrm.connected ? hrm.name : 'Connect heart rate';
  $('demo-chip').hidden = !!(trainer.device && trainer._wanted) || !ride.active;

  const st = $('s-trainer'), ss = $('s-trainer-status');
  st.classList.toggle('ok', trainer.connected);
  if (trainer.connected) {
    st.textContent = `✓ ${trainer.name}`;
    ss.className = 'hint';
    ss.textContent = trainer.canControl
      ? `Connected via ${trainer.protocol} · the gradient will control resistance`
      : `Connected (${trainer.protocol}) · power only, resistance will not change`;
  } else st.textContent = 'Connect trainer';
  const sh = $('s-hr');
  sh.classList.toggle('ok', hrm.connected);
  sh.textContent = hrm.connected ? `✓ ${hrm.name}` : 'Connect heart rate strap';
  if (hrm.connected) $('s-hr-status').textContent = 'Connected';
  if (route && !ride.active && !countdown) $('s-go').textContent = goLabel();
}
trainer.onstatus = () => {
  ride.sentGrade = null;
  if (trainer.connected) trainer.setRider(totalMass());
  deviceUi();
  if (ride.active && !trainer.connected && trainer._wanted) toast('Trainer connection lost, reconnecting…');
};
hrm.onstatus = deviceUi;

async function connect(dev, statusEl) {
  if (!bluetoothAvailable()) {
    statusEl.className = 'hint err';
    statusEl.textContent = 'Web Bluetooth is not available. Use Chrome or Edge on a computer with Bluetooth.';
    if (ride.active) toast('Web Bluetooth is not available in this browser');
    return;
  }
  if (dev.connected) return;
  try {
    statusEl.className = 'hint';
    statusEl.textContent = 'Connecting…';
    await dev.connect();
  } catch (e) {
    if (e.name === 'NotFoundError') statusEl.textContent = 'No device selected.';
    else {
      console.error(e);
      statusEl.className = 'hint err';
      statusEl.textContent = `Could not connect: ${e.message}`;
      if (ride.active) toast(`Could not connect: ${e.message}`);
    }
  }
  deviceUi();
}
$('s-trainer').onclick = $('b-trainer').onclick = () => connect(trainer, $('s-trainer-status'));
$('s-hr').onclick = $('b-hr').onclick = () => connect(hrm, $('s-hr-status'));

// keep the screen on during a ride; the browser drops the lock whenever the tab is hidden
const keepAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
document.addEventListener('visibilitychange', () => !document.hidden && ride.active && keepAwake());

// ---------- ride ----------
function startRide(startDist, length = +$('i-length').value || 0) {
  // a chosen ride length ends the ride before the end of the route
  ride.endDist = length > 0 ? Math.min(route.total, startDist + length) : route.total;
  Object.assign(ride, {
    active: true, finished: false, startDist, startDate: new Date(), dist: startDist, v: 0,
    moving: 0, wall: 0, climbed: 0, energy: 0, powerSum: 0, hrSum: 0, hrTime: 0, cadSum: 0, cadTime: 0,
    samples: [], recent: [], sentGrade: null, secAcc: 0, etaAcc: 5, windWork: 0, draftWork: 0, braking: false, wasForest: null, trainerTime: 0, saved: false,
  });
  ride.nextLandmark = route.landmarks.findIndex((l) => l.dist > startDist + 50);
  const wkg = [2.1, 2.6, 2.9, 3.2, 3.5, 4.0], offs = [18, 45, 90, 160, 260, 420];
  bots.forEach((b, i) => Object.assign(b, { dist: Math.max(0, startDist + offs[i]), v: 4, power: wkg[i] * 72, crank: i }));
  trainer.setRider(totalMass());
  world.snapCamera();
  $('start').hidden = true;
  $('summary').hidden = true;
  $('hud').hidden = false;
  deviceUi();
  keepAwake();
  toast(`${route.name} · ${((ride.endDist - startDist) / 1000).toFixed(1)} km ${toGo()}. ${route.climb ? 'Bon courage!' : 'Have a good ride!'}`);
}

function readInputs() {
  if (trainer.connected) {
    ride.power = trainer.fresh ? trainer.power : 0;
    ride.cadence = trainer.fresh ? trainer.cadence : 0;
  } else if (trainer.device && trainer._wanted) {
    // a trainer was chosen but its connection dropped: no free watts meanwhile
    ride.power = 0;
    ride.cadence = 0;
  } else {
    ride.power = ride.demoPower;
    ride.cadence = ride.power > 0 ? 68 + Math.min(24, ride.power / 14) : 0;
  }
  ride.hr = hrm.fresh ? hrm.bpm : 0;
}

function simulate(dt) {
  readInputs();
  if (ride.finished) return;
  const mass = totalMass();
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(0.1, left);
    left -= h;
    const eleBefore = route.ele(ride.dist);
    const grade = route.grade(ride.dist), limit = route.speedLimit(ride.dist);
    weather.at(ride.dist, ride.wall, wind);
    // shelter behind whoever is just in front: other people in a room, bots otherwise
    gaps.length = 0;
    if (net.room) { for (const p of net.peers.values()) if (p.riding && here(p)) gaps.push(p.dist - ride.dist); }
    else for (const b of bots) gaps.push(b.dist - ride.dist);
    wind.draft = draftSaving(gaps);
    const before = ride.v;
    ride.v = stepSpeed(ride.v, ride.power, grade, mass, eleBefore, h, wind, limit);
    ride.braking = ride.v >= limit - 0.01 && before >= limit - 0.3 && limit < 26;
    const cda = cdaFor(ride.v, grade, ride.power);
    Object.assign(noDraft, wind, { draft: 0 });
    const alone = drag(ride.v, eleBefore, noDraft, cda);
    ride.windWork += (alone - drag(ride.v, eleBefore, { temp: wind.temp }, cda)) * ride.v * h;
    ride.draftWork += (alone - drag(ride.v, eleBefore, wind, cda)) * ride.v * h;
    ride.wall += h;
    ride.dist = Math.min(ride.endDist, ride.dist + ride.v * h);
    const gain = route.ele(ride.dist) - eleBefore;
    if (gain > 0) ride.climbed += gain;
    if (ride.v > 0.3 || ride.power > 0) {
      ride.moving += h;
      if (trainer.connected) ride.trainerTime += h;
      ride.powerSum += ride.power * h;
      ride.energy += ride.power * h;
      if (ride.cadence > 0) { ride.cadSum += ride.cadence * h; ride.cadTime += h; }
    }
    if (ride.hr > 0) { ride.hrSum += ride.hr * h; ride.hrTime += h; }
    for (const b of bots) {
      if (b.dist >= route.total) continue;
      weather.at(b.dist, ride.wall, botWind);
      gaps.length = 0;
      gaps.push(ride.dist - b.dist);
      for (const o of bots) if (o !== b) gaps.push(o.dist - b.dist);
      botWind.draft = draftSaving(gaps);
      b.v = stepSpeed(b.v, b.power, route.grade(b.dist), 80, route.ele(b.dist), h, botWind, route.speedLimit(b.dist));
      b.dist += b.v * h;
      b.crank += ((70 + b.power / 14) / 60) * 2 * Math.PI * h;
    }
  }
  ride.crank += (ride.cadence / 60) * 2 * Math.PI * dt;
  ride.shownPower += (ride.power - ride.shownPower) * (1 - Math.exp(-dt / 0.8));

  ride.secAcc += dt;
  while (ride.secAcc >= 1) {
    ride.secAcc -= 1;
    everySecond();
  }
  if (!ride.finished && ride.dist >= ride.endDist) {
    ride.finished = true;
    trainer.setGrade(0, CRR);
    showSummary(true);
    saveRide();
  }
}

function everySecond() {
  const p = route.at(ride.dist, {});
  ride.samples.push({
    wall: ride.wall - ride.secAcc, ridden: ride.dist - ride.startDist, ele: p.y, x: p.x, z: p.z,
    power: ride.power, cadence: ride.cadence, hr: ride.hr, speed: ride.v,
  });
  ride.recent.push(ride.power);
  if (ride.recent.length > 60) ride.recent.shift();

  // resistance: follow the slope just ahead of the wheel
  const now = performance.now();
  // a headwind is felt as a little extra slope, a tailwind as a little less
  const windGrade = airAsGrade(ride.v, totalMass(), p.y, wind, route.grade(ride.dist), ride.power);
  const g = Math.max(-5, Math.min(16, ((route.grade(ride.dist + 3, 20) + windGrade) * settings.difficulty) / 100));
  if (trainer.connected && !ride.finished && (ride.sentGrade === null || Math.abs(g - ride.sentGrade) >= 0.1 || now - ride.sentAt > 4000)) {
    trainer.setGrade(g, CRR);
    ride.sentGrade = g;
    ride.sentAt = now;
  }

  ride.etaAcc += 1;
  if (ride.etaAcc >= 5) {
    ride.etaAcc = 0;
    const avg = ride.recent.reduce((a, b) => a + b, 0) / ride.recent.length;
    ride.eta = estimateTime(route, ride.dist, avg, totalMass(), weather, ride.endDist);
  }

  // leaving or entering the shelter of the trees
  if (ride.wasForest !== null && ride.wasForest !== wind.forest && weather.mode !== 'calm') {
    const mean = weather.at(ride.dist + 400, undefined, {});
    if (!wind.forest && mean.speed > 3) toast(`Out of the trees: ${windName(mean)} ${Math.round(mean.speed * 3.6)} km/h`, 7000);
    else if (wind.forest && wind.speed < 3) toast('Into the forest: sheltered from the wind', 6000);
  }
  ride.wasForest = wind.forest;
  if (weather.live && Date.now() - weather.fetchedAt > 10 * 60000) {
    weather.fetchedAt = Date.now();
    weather.refresh().then(() => world.setSky(weather.at(ride.dist, undefined, {}).cloud));
  }

  const lm = route.landmarks[ride.nextLandmark];
  if (lm && ride.dist >= lm.dist - 5 && ride.nextLandmark < route.landmarks.length - 1) {
    toast(`${lm.name} · ${Math.round(route.ele(lm.dist))} m · ${(Math.max(0, ride.endDist - lm.dist) / 1000).toFixed(1)} km to go`, 8000);
    ride.nextLandmark++;
  }
}

function showSummary(finished) {
  const t = ride.moving || 1, km = (ride.dist - ride.startDist) / 1000;
  const avgP = ride.powerSum / t;
  const whole = ride.endDist >= route.total;
  $('sum-title').textContent = !finished ? 'Ride paused' : route.climb && whole ? `${route.meta.sign.top} ! ${route.meta.topEle} m` : 'Finished!';
  $('sum-sub').textContent = finished
    ? route.climb && whole
      ? `You climbed ${route.name}${ride.startDist > 0 ? ' (partial ascent)' : ` from ${route.meta.start}`}. Chapeau!`
      : `You rode ${((ride.dist - ride.startDist) / 1000).toFixed(1)} km on ${route.name}. Nicely done!`
    : `${((ride.endDist - ride.dist) / 1000).toFixed(1)} km left`;
  const cells = [
    [fmtTime(ride.moving), 'time'],
    [km.toFixed(2), 'km'],
    [Math.round(ride.climbed), 'm climbed'],
    [Math.round(avgP), 'avg watts'],
    [(avgP / settings.weight).toFixed(2), 'W/kg'],
    [Math.round((ride.climbed / t) * 3600), 'VAM m/h'],
    [(km / (t / 3600)).toFixed(1), 'km/h avg'],
    [ride.cadTime ? Math.round(ride.cadSum / ride.cadTime) : '–', 'avg rpm'],
    [ride.hrTime ? Math.round(ride.hrSum / ride.hrTime) : '–', 'avg bpm'],
  ];
  if (ride.draftWork / t >= 1) cells.push([Math.round(ride.draftWork / t), 'avg W saved drafting']);
  if (weather.mode !== 'calm') {
    const w = ride.windWork / t;
    cells.push([`${w > 0.5 ? '+' : ''}${Math.round(w)}`, w >= 0 ? 'avg W lost to wind' : 'avg W from tailwind']);
  }
  $('sum-grid').innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  $('sum-continue').hidden = finished;
  if (!ride.saved) $('sum-note').textContent = finished ? '' : worthSaving() ? 'This ride is saved when you go back to the start.' : '';
  $('sum-tcx').disabled = ride.samples.length < 2;
  $('summary').hidden = false;
}

$('b-end').onclick = () => showSummary(ride.finished);
$('sum-continue').onclick = () => ($('summary').hidden = true);
$('sum-again').onclick = () => {
  saveRide();
  trainer.setGrade(0, CRR);
  ride.active = false;
  ride.finished = false;
  $('summary').hidden = true;
  $('hud').hidden = true;
  $('start').hidden = false;
  ride.dist = 0;
  ride.v = 0;
  world.snapCamera();
  deviceUi();
};
$('sum-tcx').onclick = () => {
  const stamp = ride.startDate.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  download(`${routeId}-${stamp}.tcx`, buildTcx(ride.samples, ride.startDate, route));
};
$('b-cam').onclick = () => ($('b-cam').textContent = `Camera: ${world.nextCamera()}`);
$('b-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  if (e.key === 'c' || e.key === 'C') $('b-cam').click();
  if (e.key === 'f' || e.key === 'F') $('b-full').click();
  if (!(trainer.device && trainer._wanted) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const stepW = e.shiftKey ? 50 : 10;
    ride.demoPower = Math.max(0, Math.min(1500, ride.demoPower + (e.key === 'ArrowUp' ? stepW : -stepW)));
    e.preventDefault();
  }
});
addEventListener('resize', () => world?.resize());

// ---------- history ----------
// Only real rides count: at least two minutes, with the watts coming from a trainer.
const worthSaving = () => ride.moving >= 120 && ride.samples.length >= 120 && (ride.trainerTime > ride.moving * 0.6 || net.local);
async function saveRide() {
  if (ride.saved || !worthSaving()) return;
  ride.saved = true;
  const rec = buildRecord(ride, routeId, settings.weight);
  rec.finished = ride.finished && ride.endDist >= route.total;
  const note = $('sum-note');
  note.textContent = 'Saving your ride…';
  try {
    const earlier = await history.load();
    const where = await history.save(rec);
    const wins = improvements(rec, earlier);
    note.innerHTML =
      (where === 'account' ? 'Saved to your account.' : net.user && !net.local ? 'Saved on this device only (the account could not be reached).' : 'Saved on this device. Sign in to keep rides across devices.') +
      wins.map((w) => `<br><b>${esc(w)}</b>`).join('');
  } catch (e) {
    console.error(e);
    note.textContent = 'This ride could not be saved. Download it to keep it.';
  }
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
function drawTrend(el, pts) {
  if (pts.length < 2) {
    el.innerHTML = '<div class="hint">The chart appears after your second ride of ten minutes or more.</div>';
    return;
  }
  const W = 660, H = 190, L = 40, R = 46, T = 12, B = 24;
  const ws = pts.map((p) => p.w), lo = Math.floor((Math.min(...ws) - 10) / 20) * 20, hi = Math.ceil((Math.max(...ws) + 10) / 20) * 20;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (w) => T + (1 - (w - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  const last = pts[pts.length - 1];
  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Power per ride over time">` +
    ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('') +
    `<text class="axis" x="${L}" y="${H - 4}">${fmtDate(new Date(t0).toISOString())}</text><text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${fmtDate(new Date(t1).toISOString())}</text>` +
    `<polyline class="line" points="${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ')}"/>` +
    pts.map((p, i) => `<circle class="dot" data-i="${i}" cx="${x(p.t).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="4.5"/>`).join('') +
    `<text class="last" x="${x(last.t) + 9}" y="${y(last.w) + 4}">${last.w} W</text>` +
    pts.map((p, i) => `<circle class="hit" data-i="${i}" cx="${x(p.t).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="14"/>`).join('') +
    '</svg><div class="tip" hidden></div>';
  const tip = el.querySelector('.tip'), svg = el.querySelector('svg');
  const show = (i) => {
    el.querySelectorAll('.dot').forEach((d) => d.classList.toggle('on', +d.dataset.i === i));
    if (i < 0) return (tip.hidden = true);
    const p = pts[i], box = svg.getBoundingClientRect();
    tip.innerHTML = `<b>${p.w} W</b> ${p.twenty ? 'best 20 min' : 'whole ride'}<br>${fmtDate(new Date(p.t).toISOString())} · ${esc(routeName(p.route))}`;
    tip.style.left = `${(x(p.t) / W) * box.width}px`;
    tip.style.top = `${(y(p.w) / H) * box.height}px`;
    tip.hidden = false;
  };
  el.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('pointerenter', () => show(+h.dataset.i));
    h.addEventListener('pointerleave', () => show(-1));
  });
}
async function showHistory() {
  $('history').hidden = false;
  $('hist-where').textContent = 'Loading…';
  const rides = await history.load();
  $('hist-where').textContent =
    history.where === 'account' ? `Rides saved to ${net.user.name}'s account` : net.user && !net.local ? 'Showing rides saved on this device (the account could not be reached)' : 'Rides saved on this device. Sign in to keep them across devices.';
  $('hist-empty').hidden = rides.length > 0;
  $('hist-body').hidden = rides.length === 0;
  if (!rides.length) return;
  const s = summarise(rides);
  const tile = (v, l, extra = '') => `<div class="tile"><b>${v}</b><span>${l}</span>${extra ? `<i>${extra}</i>` : ''}</div>`;
  $('hist-tiles').innerHTML =
    tile(s.count, 'rides', `${s.last28} in the last 4 weeks`) +
    tile(s.hours.toFixed(1), 'hours', `${Math.round(s.km)} km`) +
    tile(Math.round(s.climbed).toLocaleString(), 'm climbed') +
    tile(s.ftp ? `${s.ftp} W` : '–', 'estimated FTP', s.ftp ? `${s.weight ? (s.ftp / s.weight).toFixed(2) + ' W/kg · ' : ''}95% of your best 20 min` : 'needs a 20-minute effort');
  $('hist-chart-sub').textContent = 'One dot per ride: your best 20 minutes, or the whole ride if it was shorter.';
  drawTrend($('hist-chart'), s.trend);
  $('hist-bests').innerHTML =
    '<tr><th>Held for</th><th>Best ever</th><th>Last 6 weeks</th><th>Change</th></tr>' +
    s.bests
      .filter((b) => b.ever)
      .map((b) => {
        const d = b.recent && b.before ? b.recent - b.before : null;
        const change = d === null ? '–' : `<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲ +' : d < 0 ? '▼ −' : ''}${Math.abs(d)} W</span>`;
        return `<tr><td>${WINDOW_NAMES[b.w]}</td><td>${b.ever} W</td><td>${b.recent ? b.recent + ' W' : '–'}</td><td>${change}</td></tr>`;
      })
      .join('');
  $('hist-routes').innerHTML =
    '<tr><th>Climb</th><th>Rides</th><th>Fastest full ascent</th><th class="opt">Set on</th></tr>' +
    s.routes.map((r) => `<tr><td>${esc(routeName(r.route))}</td><td>${r.rides}</td><td>${r.best ? fmtTime(r.best) : '–'}</td><td class="opt">${r.bestAt ? fmtDate(r.bestAt) : '–'}</td></tr>`).join('');
  $('hist-rides').innerHTML =
    '<tr><th>Ride</th><th>Time</th><th class="opt">km</th><th>Avg W</th><th class="opt">NP</th><th class="opt">Avg bpm</th><th></th></tr>' +
    rides
      .slice(0, 40)
      .map((r) => `<tr><td>${fmtDate(r.started_at)} · ${esc(routeName(r.route))}${r.finished ? '' : ' (part)'}</td><td>${fmtTime(r.duration_s)}</td><td class="opt">${(r.distance_m / 1000).toFixed(1)}</td><td>${r.avg_power ?? '–'}</td><td class="opt">${r.np ?? '–'}</td><td class="opt">${r.avg_hr ?? '–'}</td><td><button class="x" data-id="${esc(String(r.id))}" title="Delete this ride">✕</button></td></tr>`)
      .join('');
}
$('s-history').onclick = showHistory;
$('hist-close').onclick = () => ($('history').hidden = true);
$('hist-rides').addEventListener('click', async (e) => {
  const id = e.target.closest('.x')?.dataset.id;
  if (!id || !confirm('Delete this ride for good?')) return;
  try {
    await history.remove(id);
  } catch (err) {
    alert(`Could not delete the ride: ${err.message}`);
  }
  showHistory();
});

// ---------- riding together ----------
const KITS = [
  { jersey: 0x2b8a5a, frame: 0x222222 }, { jersey: 0xf2c21a, frame: 0xc93a2e }, { jersey: 0x3d6fd9, frame: 0xdddddd },
  { jersey: 0xf2f2f2, frame: 0x1f8a8a, helmet: 0xc93a2e }, { jersey: 0x8a3fd1, frame: 0x333333 }, { jersey: 0xff7a1a, frame: 0x224488, helmet: 0x222222 },
];
let countdown = null;
const here = (p) => p.route === routeId; // on the same climb as me
const othersRiding = () => [...net.peers.values()].some((p) => here(p) && p.riding && !p.finished);
function goLabel() {
  if (net.room && othersRiding()) return 'Join the ride';
  if (net.room) return net.peers.size ? 'Start for everyone' : 'Start ride (nobody else here yet)';
  return trainer.connected ? 'Start ride' : 'Start in demo mode';
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mpStatus = (text, err = false) => {
  $('mp-status').textContent = text;
  $('mp-status').className = err ? 'hint err' : 'hint';
};
function mpUi() {
  $('mp').hidden = !net.available;
  $('mp-auth').hidden = !!net.user;
  $('mp-room').hidden = !net.user;
  if (net.user) $('mp-user').textContent = net.user.name;
  $('mp-out').hidden = net.local;
  $('mp-pick').hidden = !!net.room;
  $('mp-in').hidden = !net.room;
  if (net.room) {
    $('mp-roomname').textContent = net.room;
    const names = [...net.peers.values()].map((p) => esc(p.name) + (p.riding && !here(p) ? ` (riding ${esc(routeName(p.route))})` : p.finished ? ' (at the top)' : p.riding ? ' (riding)' : ''));
    $('mp-peers').innerHTML = names.length ? `Here with you: ${names.join(', ')}` : 'Nobody else here yet. Send them the invite link.';
  }
  deviceUi();
}
async function joinRoom(code) {
  try {
    mpStatus('Joining…');
    await net.join(code);
    mpStatus('');
    sendState();
  } catch (e) {
    mpStatus(e.message, true);
  }
  mpUi();
}
function sendState() {
  if (!net.room) return;
  net.sendState({
    route: routeId, riding: ride.active, finished: ride.finished, dist: Math.round(ride.dist * 10) / 10,
    v: $('summary').hidden ? Math.round(ride.v * 100) / 100 : 0,
    power: Math.round(ride.power), wkg: Math.round((ride.shownPower / settings.weight) * 10) / 10, cadence: Math.round(ride.cadence),
  });
}
setInterval(sendState, 1000);
addEventListener('pagehide', () => net.leave());

function startCountdown(seconds, startDist) {
  if (ride.active || countdown) return;
  let left = Math.max(1, Math.round(seconds));
  const show = () => ($('s-go').textContent = `Starting in ${left}…`);
  show();
  $('s-go').disabled = true;
  countdown = setInterval(() => {
    if (--left > 0) return show();
    clearInterval(countdown);
    countdown = null;
    $('s-go').disabled = false;
    startRide(startDist);
  }, 1000);
}
function goClicked() {
  const startDist = route.landmarks[+$('i-start').value].dist;
  if (net.room && [...net.peers.values()].some((p) => !p.riding) && !othersRiding()) {
    net.send('start', { id: net.user.id, in: 5, startDist, route: routeId, length: +$('i-length').value || 0 });
    startCountdown(5, startDist);
  } else startRide(startDist);
}
net.onstart = async (p) => {
  if (ride.active || countdown || !isFinite(p.startDist)) return;
  const began = performance.now();
  if (p.route !== routeId) {
    if (!ROUTES.some((r) => r.id === p.route)) return;
    mpStatus(`The group is riding ${routeName(p.route)}. Loading it…`);
    if (!(await chooseRoute(p.route))) return;
    mpStatus('');
  }
  if (ride.active || countdown) return;
  const left = Math.min(10, +p.in || 5) - (performance.now() - began) / 1000;
  const len = Math.max(0, +p.length || 0);
  if ([...$('i-length').options].some((o) => +o.value === len)) $('i-length').value = len;
  startCountdown(Math.max(1, left), Math.min(route.total - 50, Math.max(0, +p.startDist)));
};
net.onpeers = mpUi;
net.onauth = () => {
  mpUi();
  const invited = cleanCode(params.get('room'));
  if (net.user && invited && !net.room) joinRoom(invited);
  else if (invited && !net.user) mpStatus(`You are invited to room ${invited}. Sign in or create an account to join.`);
};

$('mp-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    mpStatus('Signing in…');
    await net.signIn($('mp-email').value.trim(), $('mp-pass').value);
    mpStatus('');
  } catch (err) {
    mpStatus(err.message, true);
  }
});
$('mp-signup').onclick = async () => {
  if (!$('mp-auth').reportValidity()) return;
  const name = $('mp-name').value.trim();
  if (!name) return mpStatus('Fill in the name other riders will see.', true);
  try {
    mpStatus('Creating your account…');
    const r = await net.signUp($('mp-email').value.trim(), $('mp-pass').value, name);
    mpStatus(r === 'confirm' ? 'Almost there: open the confirmation link in the e-mail you just got, then sign in.' : '');
  } catch (err) {
    mpStatus(err.message, true);
  }
};
$('mp-out').onclick = () => net.signOut();
$('mp-join').onclick = () => joinRoom($('mp-code').value);
$('mp-new').onclick = () => joinRoom(newCode());
$('mp-leave').onclick = () => {
  net.leave();
  mpUi();
};
$('mp-copy').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${net.room}`;
  try {
    await navigator.clipboard.writeText(link);
    mpStatus('Invite link copied.');
  } catch {
    mpStatus(link);
  }
};

// Other riders on the road, and the list with the gaps to them.
function updateRemotes(dt) {
  net.tick(dt, route.total);
  for (const [id, r] of remotes) {
    if (!net.peers.has(id)) {
      world.removeRemote(r);
      remotes.delete(id);
    }
  }
  let i = 0;
  for (const p of net.peers.values()) {
    let r = remotes.get(p.id);
    if (!r) {
      let h = 0;
      for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      remotes.set(p.id, (r = world.addRemote(p.name, KITS[h % KITS.length])));
    }
    const visible = p.riding && here(p) && Math.abs(p.shown - ride.dist) < 1200;
    world.placeRider(r, p.shown, -0.6 - (i++ % 3) * 0.8, p.crank, visible);
  }
}
function updateRiderList() {
  const el = $('h-riders');
  const riding = [...net.peers.values()].filter((p) => p.riding && here(p));
  el.hidden = !net.room || !riding.length;
  if (el.hidden) return;
  const rows = [{ me: true, name: net.user.name, dist: ride.dist, wkg: ride.shownPower / settings.weight }, ...riding].sort((a, b) => b.dist - a.dist);
  el.innerHTML = rows
    .slice(0, 8)
    .map((r) => {
      const gap = r.dist - ride.dist;
      const g = r.me ? '' : Math.abs(gap) >= 1000 ? `${gap > 0 ? '+' : '−'}${(Math.abs(gap) / 1000).toFixed(1)} km` : `${gap > 0 ? '+' : '−'}${Math.abs(Math.round(gap))} m`;
      return `<div class="${r.me ? 'me' : ''}"><span class="n">${esc(r.name)}</span><span class="g">${g}</span><span class="w">${(r.wkg || 0).toFixed(1)}</span></div>`;
    })
    .join('');
}

// ---------- weather ----------
function windName(w) {
  if (w.speed < 1.4) return 'Calm';
  const r = w.head / w.speed;
  if (r > 0.75) return 'Headwind';
  if (r < -0.75) return 'Tailwind';
  if (r > 0.3) return 'Cross-headwind';
  if (r < -0.3) return 'Cross-tailwind';
  return 'Crosswind';
}
async function loadWeather() {
  const el = $('rc-wx');
  el.textContent = settings.weather === 'live' ? 'Checking the weather on the mountain…' : '';
  const ok = await weather.load(settings.weather);
  el.textContent = ok
    ? `${settings.weather === 'live' ? 'Now: ' : ''}${weather.describe()}`
    : 'Live weather could not be loaded, so this ride has no wind.';
  world?.setSky(weather.at(ride.dist, undefined, {}).cloud);
}
$('i-weather').value = settings.weather;
$('i-weather').addEventListener('change', () => {
  settings.weather = $('i-weather').value;
  localStorage.setItem('sommet.settings', JSON.stringify(settings));
  loadWeather();
});

// ---------- HUD ----------
let hudAcc = 1, canvasAcc = 1;
function updateHud(dt) {
  hudAcc += dt;
  canvasAcc += dt;
  if (hudAcc < 0.2) return;
  hudAcc = 0;
  const g = route.grade(ride.dist);
  $('h-dist').textContent = ((ride.dist - ride.startDist) / 1000).toFixed(2);
  $('h-togo').textContent = `${((ride.endDist - ride.dist) / 1000).toFixed(1)} km ${toGo()}`;
  $('h-ele').textContent = Math.round(route.ele(ride.dist));
  $('h-climb').textContent = Math.round(ride.climbed);
  $('h-time').textContent = fmtTime(ride.moving);
  $('h-eta').textContent = ride.finished ? '0:00' : fmtTime(ride.eta);
  const pw = Math.round(ride.shownPower);
  $('h-power').textContent = pw;
  $('h-power').style.color = zoneColor(pw);
  $('h-wkg').textContent = (ride.shownPower / settings.weight).toFixed(1);
  $('h-cad').textContent = ride.cadence > 0 ? Math.round(ride.cadence) : '–';
  $('h-hr').textContent = ride.hr > 0 ? Math.round(ride.hr) : '–';
  $('h-speed').textContent = (ride.v * 3.6).toFixed(1);
  $('h-avg').textContent = ride.moving > 0 ? Math.round(ride.powerSum / ride.moving) : 0;
  $('h-grade').textContent = (Math.abs(g) < 0.05 ? 0 : g).toFixed(1);
  $('h-grade-box').style.background = gradeColor(g);
  const span = Math.min(1000, ride.endDist - ride.dist);
  $('h-next').textContent = ride.braking ? 'braking for the bend' : span > 100 ? `next ${span >= 1000 ? 'km' : Math.round(span) + ' m'} ${route.grade(ride.dist + span / 2, span).toFixed(1)}%` : 'almost there';
  $('h-wind').textContent = Math.round(wind.speed * 3.6);
  $('h-wind-label').textContent = windName(wind);
  // arrow shows where the air goes, with "up" being the way you ride
  $('h-wind-arrow').style.transform = `rotate(${(Math.atan2(wind.side, -wind.head) * 180) / Math.PI}deg)`;
  $('h-wind-arrow').style.opacity = wind.speed < 1.4 ? 0.25 : 1;
  const eleNow = route.ele(ride.dist), cdaNow = cdaFor(ride.v, g, ride.power);
  Object.assign(noDraft, wind, { draft: 0 });
  const aloneNow = drag(ride.v, eleNow, noDraft, cdaNow);
  const cost = (aloneNow - drag(ride.v, eleNow, { temp: wind.temp }, cdaNow)) * ride.v;
  const saved = (aloneNow - drag(ride.v, eleNow, wind, cdaNow)) * ride.v;
  $('h-draft').hidden = wind.draft < 0.05;
  $('h-draft').textContent = `Drafting · saving ${Math.round(saved)} W`;
  const where = wind.forest ? 'sheltered by the forest' : wind.exposure > 0.8 ? 'fully exposed' : 'open country';
  $('h-wx').textContent = `${Math.round(wind.temp)}°C · ${where}${Math.abs(cost) >= 3 ? ` · ${cost > 0 ? '+' : '−'}${Math.abs(Math.round(cost))} W` : ''}`;
  $('h-wind-box').hidden = weather.mode === 'calm' && !weather.live;
  $('demo-w').textContent = ride.demoPower;
  $('paused').hidden = !(ride.active && !ride.finished && ride.v < 0.3 && ride.power < 1);
  if (canvasAcc >= 0.5) {
    canvasAcc = 0;
    profile.draw(ride.dist);
    ahead.draw(ride.dist);
    minimap.draw(ride.dist);
    updateRiderList();
  }
}

// ---------- main loop ----------
let last = performance.now(), lastFrame = 0; // lastFrame: when the screen was last drawn
function tick(now) {
  // without frames there is only a timer tick now and then, so allow long steps
  const dt = Math.min(Math.max((now - last) / 1000, 0), now - lastFrame > 800 ? 120 : 3);
  last = now;
  if (ride.active && $('summary').hidden) simulate(dt);
  else if (ride.active) readInputs();
  return dt;
}
function frame(now) {
  const dt = tick(now);
  lastFrame = now;
  world.update(dt, ride, wind);
  bots.forEach((b, i) => {
    const near = ride.active && !net.room && Math.abs(b.dist - ride.dist) < 700 && b.dist < route.total;
    world.placeRider(b.rider, b.dist, -0.7 - (i % 3) * 0.75, b.crank, near);
  });
  updateRemotes(dt);
  world.render();
  if (ride.active) updateHud(dt);
  requestAnimationFrame(frame);
}
// keep the ride going if the tab is in the background
setInterval(() => {
  // no frames are being drawn (tab hidden or window covered): keep the ride going on a timer
  if (!world || performance.now() - lastFrame < 800) return;
  net.tick(tick(performance.now()), route.total);
}, 500);

// ---------- routes ----------
// km and metres of climbing are only for the picker; the real numbers come from the route file
const ROUTES = [
  { id: 'amstel', name: 'Along the Amstel', type: 'Flat', km: 24, up: 36 },
  { id: 'afsluitdijk', name: 'Afsluitdijk', type: 'Flat', km: 34, up: 0 },
  { id: 'posbank', name: 'Posbank', type: 'Rolling', km: 16, up: 145 },
  { id: 'limburg', name: 'Limburg hills', type: 'Hilly', km: 32, up: 368 },
  { id: 'alpe-dhuez', name: "Alpe d'Huez", type: 'Mountain', km: 13, up: 1118 },
  { id: 'galibier', name: 'Col du Galibier', type: 'Mountain', km: 18, up: 1237 },
  { id: 'tourmalet', name: 'Col du Tourmalet', type: 'Mountain', km: 19, up: 1397 },
  { id: 'ventoux', name: 'Mont Ventoux', type: 'Mountain', km: 21, up: 1597 },
  { id: 'stelvio', name: 'Passo dello Stelvio', type: 'Mountain', km: 24, up: 1853 },
];
const TYPES = { Flat: 'Flat · easy spinning', Rolling: 'Rolling · moderate hills', Hilly: 'Hilly · short steep climbs', Mountain: 'Mountain · one long climb' };
function lengthOptions() {
  const left = route.total - route.landmarks[+$('i-start').value || 0].dist;
  $('i-length').innerHTML =
    `<option value="0">Whole route · ${(left / 1000).toFixed(1)} km</option>` +
    [5, 10, 15, 20, 25, 30, 40].filter((k) => k * 1000 < left - 1500).map((k) => `<option value="${k * 1000}">${k} km</option>`).join('');
}
const routeName = (id) => ROUTES.find((r) => r.id === id)?.name || id;
let routeId = null, routeLoading = null;

// Load a climb and rebuild the 3D world for it. Not possible during a ride.
async function setRoute(id) {
  if (!ROUTES.some((r) => r.id === id)) id = ROUTES[0].id;
  if (id === routeId) return true;
  if (ride.active) return false;
  $('s-go').disabled = true;
  $('rc-facts').textContent = 'Loading route…';
  let next;
  try {
    next = await loadRoute(`data/${id}.json`);
  } catch (e) {
    $('rc-facts').textContent = `${e.message}. Serve this folder over http (see start.command).`;
    $('i-route').value = routeId || id;
    $('s-go').disabled = !route;
    return false;
  }
  if (ride.active) return false;
  route = next;
  routeId = id;
  settings.route = id;
  localStorage.setItem('sommet.settings', JSON.stringify(settings));
  $('i-route').value = id;
  const avg = ((route.E[route.n - 1] - route.E[0]) / route.total) * 100;
  let steep = 0;
  for (let d = 250; d < route.total; d += 100) steep = Math.max(steep, route.grade(d, 500));
  $('h-eta-label').textContent = route.climb ? 'to the top' : 'to go';
  $('rc-title').textContent = $('h-route').textContent = route.name;
  $('rc-sub').textContent = route.meta.sub;
  document.title = `Sommet · ${route.name}`;
  $('rc-facts').textContent = `${(route.total / 1000).toFixed(1)} km  ·  ${Math.round(route.ascent)} m ↑  ·  ${route.climb ? `${avg.toFixed(1)}% avg` : `steepest 500 m ${steep.toFixed(1)}%`}`;
  $('i-start').innerHTML = route.landmarks
    .slice(0, -1)
    .map((l, i) => `<option value="${i}">${esc(l.name)} · ${((route.total - l.dist) / 1000).toFixed(1)} km</option>`)
    .join('');
  lengthOptions();
  new RouteProfile($('rc-profile'), route, false).draw(route.total);
  await new Promise((r) => setTimeout(r, 30));

  for (const r of remotes.values()) world?.removeRemote(r);
  remotes.clear();
  bots.length = 0;
  world?.dispose();
  weather = new Weather(route);
  world = new World($('scene'), route);
  profile = new RouteProfile($('profile'), route);
  ahead = new AheadProfile($('ahead'), route);
  minimap = new MiniMap($('minimap'), route);
  KITS.forEach((k) => bots.push({ rider: world.addBot(k), dist: 0, v: 0, power: 200, crank: 0 }));
  ride.dist = 0;
  await loadWeather();
  $('s-go').disabled = false;
  deviceUi();
  sendState();
  return true;
}
const chooseRoute = (id) => (routeLoading = (routeLoading || Promise.resolve()).then(() => setRoute(id)));

async function init() {
  if (!bluetoothAvailable()) {
    $('s-foot').className = 'foot err';
    $('s-foot').textContent = 'This browser has no Web Bluetooth, so the trainer cannot connect. Open this page in Chrome or Edge. Demo mode still works.';
  }
  $('i-route').innerHTML = Object.keys(TYPES)
    .map((t) => `<optgroup label="${TYPES[t]}">${ROUTES.filter((r) => r.type === t).map((r) => `<option value="${r.id}">${esc(r.name)} · ${r.km} km · ${r.up} m↑</option>`).join('')}</optgroup>`)
    .join('');
  $('i-start').addEventListener('change', lengthOptions);
  $('i-route').addEventListener('change', () => chooseRoute($('i-route').value));
  if (params.get('wx')) settings.weather = $('i-weather').value = params.get('wx');
  if (!(await chooseRoute(params.get('route') || settings.route || 'ventoux'))) return;

  $('s-go').onclick = goClicked;
  net.init().catch((e) => {
    console.error(e);
    $('mp').hidden = false;
    mpStatus(`Riding together is unavailable: ${e.message}`, true);
  });
  deviceUi();
  requestAnimationFrame(frame);

  // dev helpers: ?autostart=1&km=16&demo=250&cam=2&route=galibier
  if (params.get('autostart')) {
    for (let i = 0; i < (+params.get('cam') || 0); i++) $('b-cam').click();
    startRide(Math.min(route.total - 50, (+params.get('km') || 0) * 1000), (+params.get('len') || 0) * 1000);
    ride.v = 4;
    for (let i = 0; i < (+params.get('ff') || 0); i++) simulate(1);
  }
}
init();
window.sommet = { net, ride, get routeId() { return routeId; } }; // handy in the browser console
