import { loadRoute } from './route.js';
import { World } from './world.js';
import { Trainer, HeartRate, bluetoothAvailable } from './ble.js';
import { stepSpeed, estimateTime, airAsGrade, draftSaving, drag, cdaFor, CRR } from './physics.js';
import { Weather } from './weather.js';
import { Net, cleanCode, newCode } from './net.js';
import { loadImagery } from './imagery.js';
import { History, buildRecord, summarise, improvements, WINDOW_NAMES } from './history.js';
import { RouteProfile, AheadProfile, MiniMap, gradeColor } from './hud.js';
import { buildTcx, download } from './tcx.js';
import { PLAN, SESSIONS, Run, Progress, sessionSvg, minutes, testRamp, testSteps, FEEL } from './training.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------- settings ----------
const settings = Object.assign(
  { weight: 75, bike: 8.5, ftp: 220, difficulty: 100, weather: 'live', gender: 'man', kit: '#e8412c', quality: 'auto', autoLevel: 'high', erg: true },
  JSON.parse(localStorage.getItem('sommet.settings') || '{}')
);
// Settings live in this browser; the rider's own numbers also go to their account,
// so two people can share one laptop.
const PROFILE = ['weight', 'bike', 'ftp', 'ftpSet', 'gender', 'kit'];
function saveSettings() {
  localStorage.setItem('sommet.settings', JSON.stringify(settings));
  if (net.user && !net.local) net.saveMeta({ profile: Object.fromEntries(PROFILE.map((k) => [k, settings[k]])) });
}
// Until the fitness test has been ridden (or a number typed in), FTP is only an
// estimate from body weight.
if (settings.ftpSet === undefined) settings.ftpSet = settings.ftp !== 220;
const ftpKnown = () => !!settings.ftpSet;
function guessFtp() {
  if (ftpKnown()) return;
  settings.ftp = Math.round(settings.weight * (settings.gender === 'woman' ? 1.6 : 2.1));
  if (fields.ftp) fields.ftp.value = settings.ftp;
}
const fields = { weight: $('i-weight'), bike: $('i-bike'), ftp: $('i-ftp'), difficulty: $('i-diff') };
for (const [key, el] of Object.entries(fields)) {
  el.value = settings[key];
  el.addEventListener('change', () => {
    const v = parseFloat(el.value);
    if (isFinite(v)) settings[key] = Math.min(+el.max, Math.max(+el.min, v));
    if (key === 'ftp') settings.ftpSet = true;
    guessFtp();
    el.value = settings[key];
    saveSettings();
    trainingUi();
  });
}
guessFtp();
const totalMass = () => settings.weight + settings.bike;
const kitColor = () => parseInt(String(settings.kit).replace('#', ''), 16) || 0xe8412c;
// 'auto' starts high and steps down by itself if the ride is not smooth
const qualityNow = () => params.get('q') || (settings.quality === 'auto' ? settings.autoLevel || 'high' : settings.quality);
const myLook = () => ({ gender: settings.gender, jersey: kitColor() });
// Test mode (temporary): ride at a set power without a trainer. Switched on with the
// small link under the start button, or with ?demo=200 in the address.
let testPower = params.has('demo') ? Math.max(0, parseFloat(params.get('demo')) || 200) : null;
const canRide = () => trainer.connected || testPower !== null;
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
const progress = new Progress(net);
let run = null; // the training session being ridden, if any
let lastNote = '';

const ride = {
  active: false, finished: false, startDist: 0, startDate: null,
  dist: 0, endDist: Infinity, v: 0, crank: 0, power: 0, cadence: 0, hr: 0, shownPower: 0,
  moving: 0, wall: 0, climbed: 0, energy: 0, powerSum: 0, hrSum: 0, hrTime: 0, cadSum: 0, cadTime: 0,
  samples: [], eta: Infinity, recent: [],
  nextLandmark: 0, sentGrade: null, sentPower: null, sentAt: 0, secAcc: 0, etaAcc: 0, windWork: 0, draftWork: 0, braking: false, wasForest: null, trainerTime: 0, saved: false,
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
  sh.textContent = hrm.connected ? `✓ ${hrm.name}` : 'Connect heart rate';
  if (route && !ride.active && !countdown) $('s-go').textContent = goLabel();
  $('s-go').classList.toggle('waiting', !canRide());
  $('test-chip').hidden = testPower === null || trainer.connected || !ride.active || !!run;
  $('test-w').textContent = testPower ?? 0;
  $('s-test').textContent = testPower === null ? 'Test without a trainer' : 'Test mode is on · turn off';
}
trainer.onstatus = () => {
  ride.sentGrade = ride.sentPower = null;
  if (trainer.connected) trainer.setRider(totalMass());
  deviceUi();
  if (ride.active && !trainer.connected && trainer._wanted) toast('Trainer connection lost, reconnecting…');
  if (!ride.active) trainingUi();
};
hrm.onstatus = deviceUi;

async function connect(dev, statusEl) {
  if (!bluetoothAvailable()) {
    statusEl.hidden = false;
    statusEl.className = 'hint err';
    statusEl.textContent = 'Web Bluetooth is not available. Use Chrome or Edge on a computer with Bluetooth.';
    if (ride.active) toast('Web Bluetooth is not available in this browser');
    return;
  }
  if (dev.connected) return;
  try {
    statusEl.hidden = false;
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
  const pick = pickedSession();
  run = pick ? new Run(pick.workout, settings.ftp, pick.index, settings.weight) : null;
  if (run && !run.test) run.scale = progress.state.scale || 1; // what earlier sessions felt like
  if (run) length = 0; // a session ends on time, not on distance
  lastNote = '';
  // a chosen ride length ends the ride before the end of the route
  ride.endDist = length > 0 ? Math.min(route.total, startDist + length) : route.total;
  Object.assign(ride, {
    active: true, finished: false, startDist, startDate: new Date(), dist: startDist, v: 0,
    moving: 0, wall: 0, climbed: 0, energy: 0, powerSum: 0, hrSum: 0, hrTime: 0, cadSum: 0, cadTime: 0,
    samples: [], recent: [], sentGrade: null, sentPower: null, secAcc: 0, etaAcc: 5, windWork: 0, draftWork: 0, braking: false, wasForest: null, trainerTime: 0, saved: false,
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
  $('wo').hidden = !run;
  $('hud').classList.toggle('training', !!run);
  $('h-eta-label').textContent = run ? (run.test ? 'test' : 'session left') : route.climb ? 'to the top' : 'to go';
  if (run) {
    drawRunChart();
    toast(run.test ? 'Fitness test: warm up first, then it gets a little harder every minute' : `${run.w.name} · ${minutes(run.w)} minutes. Have a good session!`, 7000);
  } else toast(`${route.name} · ${((ride.endDist - startDist) / 1000).toFixed(1)} km ${toGo()}. ${route.climb ? 'Bon courage!' : 'Have a good ride!'}`);
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
    ride.power = run && !run.done ? run.watts() : testPower || 0; // test mode follows the session
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
    if (run) {
      if (ride.dist >= ride.endDist && !run.done) {
        // end of the road before the end of the session: start the route again
        ride.startDist -= ride.dist;
        ride.dist = 0;
        ride.nextLandmark = 0;
        world.snapCamera();
      }
      const ev = run.advance(h, ride.power, ride.cadence);
      if (ev) sessionEvent(ev);
    }
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
  if (!ride.finished && (run ? run.done : ride.dist >= ride.endDist)) {
    ride.finished = true;
    trainer.setGrade(0, CRR);
    if (run) lastNote = closeSession();
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

  control(p.y);
  if (run && !run.done && !run.inRamp && run.left <= 3.5 && run.left > 0.5 && run.next()) beep(620, 0.09);

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

// Resistance. In a training session the trainer holds the target watts; otherwise
// it follows the slope just ahead of the wheel.
const ergOn = () => !!(run && !run.done && settings.erg && trainer.canControl);
function control(ele = route.ele(ride.dist)) {
  if (!trainer.connected || ride.finished) return;
  const now = performance.now();
  if (ergOn()) {
    const w = run.watts();
    if (ride.sentPower !== w || now - ride.sentAt > 4000) {
      trainer.setPower(w);
      ride.sentPower = w;
      ride.sentGrade = null;
      ride.sentAt = now;
    }
    return;
  }
  // a headwind is felt as a little extra slope, a tailwind as a little less
  const windGrade = airAsGrade(ride.v, totalMass(), ele, wind, route.grade(ride.dist), ride.power);
  const g = Math.max(-5, Math.min(16, ((route.grade(ride.dist + 3, 20) + windGrade) * settings.difficulty) / 100));
  if (ride.sentGrade === null || Math.abs(g - ride.sentGrade) >= 0.1 || now - ride.sentAt > 4000) {
    trainer.setGrade(g, CRR);
    ride.sentGrade = g;
    ride.sentPower = null;
    ride.sentAt = now;
  }
}

// ---------- training sessions ----------
const KIND = { warm: 'Warm-up', easy: 'Easy', work: 'Effort', steady: 'Steady', cool: 'Cool-down' };
// ---------- start screen: tabs ----------
// 'ride' or 'training': what the start button starts. It follows the tab you were on last.
let mode = settings.mode === 'training' ? 'training' : 'ride';
function showTab(name) {
  if (!document.querySelector(`.pane[data-pane="${name}"]`)) name = 'ride';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  if (name === 'ride' || name === 'training') mode = settings.mode = name;
  settings.tab = name;
  localStorage.setItem('sommet.settings', JSON.stringify(settings));
  $('home-body').scrollTop = 0;
  if (name === 'progress') showHistory();
  trainingUi();
}
$('tabs').addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));
$('start').addEventListener('click', (e) => e.target.dataset.go && showTab(e.target.dataset.go));
function routeCards() {
  $('route-list').innerHTML = Object.keys(TYPES)
    .map((t) => `<h3>${TYPES[t]}</h3><div class="routes">${ROUTES.filter((r) => r.type === t).map((r) => `<button type="button" class="rt${r.id === routeId ? ' on' : ''}" data-route="${r.id}"><b>${esc(r.name)}</b><span>${r.km} km · ${r.up} m ↑</span></button>`).join('')}</div>`)
    .join('');
}
$('route-list').addEventListener('click', (e) => {
  const id = e.target.closest('.rt')?.dataset.route;
  if (id) chooseRoute(id);
});

const pickedSession = () => (mode === 'training' ? SESSIONS[+$('i-workout').value.slice(1)] || null : null);
let audio = null;
function beep(freq, len) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + len + 0.02);
  } catch {}
}
function drawRunChart() {
  const c = sessionSvg(run.w, { steps: run.steps, height: 40 });
  run.chartTotal = c.total;
  $('wo-svg').innerHTML = c.svg;
  $('wo-svg').style.height = '100%';
}
function sessionEvent(ev) {
  if (ev === 'done') return beep(880, 0.5);
  if (ev === 'test-over') {
    drawRunChart();
    beep(880, 0.5);
    toast(run.result.ftp ? `Test done: your FTP is ${run.result.ftp} W. Now spin the legs out.` : 'Test stopped. Spin the legs out.', 9000);
  } else {
    beep(run.inRamp ? 700 : 880, run.inRamp ? 0.12 : 0.3);
    const s = run.step;
    if (!run.inRamp) toast(`${run.count() || KIND[s.kind]} · ${fmtTime(s.dur)} at ${run.wattsOf(s)} W`, 5000);
  }
  ride.sentPower = null;
  control();
}
// Wrap up a session: count it for the plan, take over a test result. Returns a line for the rider.
function closeSession() {
  if (!run || run.closed) return lastNote;
  run.closed = true;
  const real = realRide();
  if (run.test) {
    if (!run.result && run.inRamp) run.endTest();
    const r = run.result;
    if (!r || !r.ftp) return 'The test was too short for a result: ride the ramp for at least a minute.';
    if (!real) return `Test mode: with a trainer this would set your FTP to ${r.ftp} W.`;
    const prev = progress.state.tests.at(-1)?.ftp;
    settings.ftp = r.ftp;
    settings.ftpSet = true;
    fields.ftp.value = r.ftp;
    saveSettings();
    progress.setFtp(r.ftp);
    if (run.planIndex !== null) progress.complete(run.planIndex, null);
    const d = prev ? r.ftp - prev : 0;
    return `Your FTP is ${r.ftp} W${prev ? (d > 0 ? `: up ${d} W since the last test!` : d < 0 ? ` (${-d} W lower than last time: a tired day happens)` : ', the same as last time') : ''}. Your best minute was ${r.best} W. Every session now uses this number.`;
  }
  const part = run.elapsed / run.total;
  if (part < 0.8) return `You rode ${Math.round(part * 100)}% of this session. It counts for the plan from 80%.`;
  if (!real) return 'Test mode: this session is not counted for the plan.';
  if (run.planIndex !== null) progress.complete(run.planIndex, run.score);
  run.counted = run.planIndex !== null;
  const sc = run.score;
  return `Session done${sc === null ? '' : `: on target ${Math.round(sc * 100)}% of the time`}. ${progress.next ? `Next up: ${progress.next.workout.name}.` : 'That was the last one: plan finished!'}`;
}
function trainingUi() {
  const st = progress.state, next = progress.next, sel = $('i-workout');
  if (!sel.options.length) sel.innerHTML = SESSIONS.map((x) => `<option value="p${x.index}"></option>`).join('');
  if (!sel.dataset.ready || sel.selectedIndex < 0 || !sel.value) sel.value = `p${next ? next.index : 0}`;
  sel.dataset.ready = 1;
  const pick = SESSIONS[+sel.value.slice(1)] || SESSIONS[0];
  $('tr-dots').innerHTML = PLAN.weeks.map((w, wi) => `<span title="Week ${wi + 1} · ${w.theme}">${[0, 1, 2].map((k) => `<i class="${st.done[wi * 3 + k] ? 'done' : next && next.index === wi * 3 + k ? 'next' : ''}"></i>`).join('')}</span>`).join('');
  const tests = st.tests, first = tests[0]?.ftp, lastT = tests.at(-1)?.ftp;
  $('tr-ftp').textContent = ftpKnown() ? settings.ftp : '?';
  $('tr-ftp-label').textContent = ftpKnown() ? 'W FTP' : 'FTP not measured yet';
  $('ftp-hint').textContent = ftpKnown()
    ? 'FTP is the power you can hold for about an hour. The fitness test in Training measures it again every four weeks.'
    : 'Not measured yet: this is an estimate from your weight. The fitness test in Training measures it for you.';
  $('tr-status').textContent = !progress.count
    ? `${PLAN.about}. Each session has one clear goal. Begin with the fitness test.`
    : (next ? `${progress.count} of ${SESSIONS.length} sessions done · week ${next.week} of 12` : `All ${SESSIONS.length} sessions done. Chapeau!`) +
      (tests.length > 1 ? ` · FTP ${first} → ${lastT} W (${lastT >= first ? '+' : '−'}${Math.abs(lastT - first)})` : '') +
      (lastNote ? ` · ${lastNote}` : '');
  $('tr-reset').hidden = !progress.count;
  $('tr-weeks').innerHTML = PLAN.weeks
    .map((w, wi) => `<div class="wk"><span><b>Week ${wi + 1}</b>${w.theme}</span><div>${SESSIONS.filter((x) => x.week === wi + 1).map((x) => `<button type="button" data-s="${x.index}" class="ses${st.done[x.index] ? ' done' : ''}${next && next.index === x.index ? ' next' : ''}${x.index === pick.index ? ' on' : ''}">${st.done[x.index] ? '✓ ' : ''}${esc(x.workout.name)}</button>`).join('')}</div></div>`)
    .join('');
  const w = pick.workout, top = Math.max(...w.steps.filter((x) => !x.abs).map((x) => x.from), 0);
  $('tr-name').textContent = w.name;
  $('tr-meta').textContent = `${next && next.index === pick.index ? 'next up · ' : ''}week ${pick.week}, session ${pick.n} · ${w.test ? '15 to 30' : minutes(w)} min`;
  $('tr-why').textContent = w.why;
  $('tr-chart').innerHTML = sessionSvg(w, w.test ? { steps: testSteps(settings.weight) } : {}).svg;
  $('tr-mind').innerHTML = `<b>Mental focus · ${esc(w.mind.name)}</b> ${esc(w.mind.text)}`;
  const hints = [];
  if (w.test) {
    const r = testRamp(settings.weight);
    hints.push(`For your weight it starts at ${r.start} W and adds ${r.step} W every minute. Ride it rested, and hang on as long as you can: the last minute counts most.`);
  } else if (ftpKnown()) hints.push(`With your FTP of ${settings.ftp} W the hardest part is at ${Math.round(top * settings.ftp * (st.scale || 1))} W.`);
  else hints.push(`Your FTP is not measured yet, so this session would use an estimate from your weight (hardest part ${Math.round(top * settings.ftp)} W). Do the fitness test first.`);
  if (!w.test && (st.scale || 1) !== 1) hints.push(`Set to ${Math.round(st.scale * 100)}% after how your last sessions felt.`);
  hints.push(!trainer.connected || trainer.canControl ? 'The trainer holds the watts for you: choose a light gear and just keep pedalling.' : 'This trainer cannot set resistance: shift gears to reach the target.');
  if (route?.climb) hints.push('A flat route is nicer for a session than a mountain.');
  $('tr-hint').textContent = hints.join(' ');
  if (route && !ride.active && !countdown) $('s-go').textContent = goLabel();
}
$('tr-weeks').addEventListener('click', (e) => {
  const i = e.target.closest('.ses')?.dataset.s;
  if (i === undefined) return;
  $('i-workout').value = `p${i}`;
  trainingUi();
  $('home-body').scrollTop = 0;
});
// the account remembers the rider: their numbers and where they are in the plan
function applyAccount() {
  const pr = net.user?.meta?.profile;
  if (pr) {
    for (const k of PROFILE) if (pr[k] !== undefined && pr[k] !== null) settings[k] = pr[k];
    guessFtp();
    for (const [key, el] of Object.entries(fields)) el.value = settings[key];
    $('i-gender').value = settings.gender;
    $('i-kit').value = settings.kit;
    localStorage.setItem('sommet.settings', JSON.stringify(settings));
    world?.setPlayerLook(myLook());
  } else if (net.user) saveSettings();
  progress.load();
  lastNote = '';
  trainingUi();
}
function updateSessionHud() {
  const s = run.step, target = run.watts(), n = run.next();
  $('wo-name').textContent = run.w.name;
  $('wo-count').textContent = run.test ? (run.result ? 'Result: ' + (run.result.ftp ? `FTP ${run.result.ftp} W` : 'too short') : run.inRamp ? 'Hang on as long as you can' : 'Warm-up') : run.count() || KIND[s.kind];
  $('wo-target').textContent = target;
  $('wo-left').textContent = fmtTime(Math.ceil(run.left));
  // during the efforts the mental cue of the session takes turns with the instruction
  const mind = (s.kind === 'work' || s.kind === 'steady') && Math.floor(run.t / 20) % 3 === 2;
  $('wo-text').textContent = mind ? run.w.mind.cue : s.text + (s.cad ? ` · ${s.cad[0]} to ${s.cad[1]} rpm` : '');
  const diff = (ride.shownPower - target) / target, ok = Math.abs(ride.shownPower - target) <= Math.max(8, target * 0.08);
  $('wo-mark').style.left = `${Math.max(0, Math.min(100, 50 + diff * 100))}%`;
  let cue = ride.power < 1 ? 'Pedal to start the clock' : ok ? 'On target' : diff < -0.2 ? 'Push harder' : diff < 0 ? 'A little more' : diff > 0.2 ? 'Too hard: ease off' : 'Ease off a little';
  if (s.cad && ride.cadence > 0 && ride.power >= 1) cue = ride.cadence < s.cad[0] ? `Spin faster: ${s.cad[0]}+ rpm` : ride.cadence > s.cad[1] ? `Slower legs: under ${s.cad[1]} rpm` : cue;
  else if (ergOn() && ride.power >= 1 && !ok && ride.cadence > 0 && ride.cadence < 60) cue = 'Pedal a bit faster';
  $('wo-cue').textContent = cue;
  $('wo-cursor').style.left = `${Math.min(100, (run.elapsed / run.chartTotal) * 100)}%`;
  $('wo-next').textContent = run.inRamp ? `Next minute: ${n ? run.wattsOf(n) : target} W` : n ? `Next: ${KIND[n.kind].toLowerCase()} · ${fmtTime(n.dur)} at ${run.wattsOf(n)} W` : 'Last part';
  $('wo-adjust').hidden = run.test;
  $('wo-scale').textContent = `${Math.round(run.scale * 100)}%`;
  $('wo-erg').hidden = !trainer.canControl;
  $('wo-erg').textContent = `Trainer holds the watts: ${settings.erg ? 'on' : 'off'}`;
  $('wo-stop').hidden = !run.inRamp;
}
const scaleRun = (d) => {
  if (!run || run.test) return;
  run.scale = Math.max(0.6, Math.min(1.3, Math.round((run.scale + d) * 100) / 100));
  ride.sentPower = null;
  control();
};
$('wo-less').onclick = () => scaleRun(-0.05);
$('wo-more').onclick = () => scaleRun(0.05);
$('wo-erg').onclick = () => {
  settings.erg = !settings.erg;
  saveSettings();
  ride.sentPower = ride.sentGrade = null;
  control();
  toast(settings.erg ? 'The trainer holds the target watts' : 'You set the watts yourself: the road decides the resistance', 4000);
};
$('wo-stop').onclick = () => {
  if (!run?.inRamp) return;
  run.endTest();
  sessionEvent('test-over');
};
$('tr-reset').onclick = () => {
  if (!confirm('Start the plan again from week 1? Your rides and test results are kept.')) return;
  progress.reset();
  $('i-workout').value = '';
  trainingUi();
};

function showSummary(finished) {
  const t = ride.moving || 1, km = (ride.dist - ride.startDist) / 1000;
  const avgP = ride.powerSum / t;
  const whole = ride.endDist >= route.total;
  $('sum-title').textContent = run ? (!finished ? 'Session paused' : run.test ? 'Test done!' : 'Session done!') : !finished ? 'Ride paused' : route.climb && whole ? `${route.meta.sign.top} ! ${route.meta.topEle} m` : 'Finished!';
  $('sum-sub').textContent = run
    ? finished ? lastNote : run.test ? 'The fitness test is not finished yet' : `${fmtTime(run.total - run.elapsed)} of ${run.w.name} left`
    : finished
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
  $('sum-feel').hidden = !(finished && run && run.counted && !run.felt);
  $('sum-continue').hidden = finished;
  if (!ride.saved) $('sum-note').textContent = finished ? '' : worthSaving() ? 'This ride is saved when you go back to the start.' : '';
  $('sum-tcx').disabled = ride.samples.length < 2;
  $('summary').hidden = false;
}

$('sum-feel-btns').innerHTML = Object.entries(FEEL).map(([k, v]) => `<button type="button" class="mini" data-f="${k}">${v.label}</button>`).join('');
$('sum-feel-btns').addEventListener('click', (e) => {
  const f = e.target.dataset.f;
  if (!f || !run || run.felt) return;
  run.felt = f;
  const before = progress.state.scale || 1, now = progress.feel(run.planIndex, f);
  $('sum-feel').hidden = true;
  $('sum-sub').textContent +=
    ' ' + (now > before ? `Noted: the next sessions get a little harder (${Math.round(now * 100)}%).` : now < before ? `Noted: the next sessions get a little lighter (${Math.round(now * 100)}%).` : f === 'hard' ? 'Noted. Hard but done is exactly right.' : 'Noted.');
});
$('b-end').onclick = () => showSummary(ride.finished);
$('sum-continue').onclick = () => ($('summary').hidden = true);
$('sum-again').onclick = () => {
  saveRide();
  if (run) {
    lastNote = closeSession();
    const next = progress.next;
    if (run.planIndex !== null && progress.state.done[run.planIndex]) {
      $('i-workout').dataset.ready = 1;
      $('i-workout').value = `p${next ? next.index : 0}`;
    }
    run = null;
    $('wo').hidden = true;
    $('hud').classList.remove('training');
    trainingUi();
  }
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
  if (run && ride.active && (e.key === 'e' || e.key === 'E')) $('wo-erg').click();
  if (run && ride.active && (e.key === '+' || e.key === '=')) scaleRun(0.05);
  if (run && ride.active && e.key === '-') scaleRun(-0.05);
  if (testPower !== null && !run && !trainer.connected && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    testPower = Math.max(0, Math.min(1500, testPower + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 50 : 10)));
    $('test-w').textContent = testPower;
    e.preventDefault();
  }
});
addEventListener('resize', () => world?.resize());

// ---------- history ----------
// Only real rides count: at least two minutes, with the watts coming from a trainer.
const realRide = () => ride.trainerTime > ride.moving * 0.6 || net.local;
const worthSaving = () => ride.moving >= 120 && ride.samples.length >= 120 && realRide();
async function saveRide() {
  if (ride.saved || !worthSaving()) return;
  ride.saved = true;
  const rec = buildRecord(ride, routeId, settings.weight);
  rec.finished = !run && ride.finished && ride.endDist >= route.total;
  rec.start_m = Math.max(0, rec.start_m);
  if (run) rec.best.wo = run.w.name; // shown in the list of rides
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
      .map((r) => `<tr><td>${fmtDate(r.started_at)} · ${esc(routeName(r.route))}${r.best?.wo ? ` · ${esc(String(r.best.wo))}` : r.finished ? '' : ' (part)'}</td><td>${fmtTime(r.duration_s)}</td><td class="opt">${(r.distance_m / 1000).toFixed(1)}</td><td>${r.avg_power ?? '–'}</td><td class="opt">${r.np ?? '–'}</td><td class="opt">${r.avg_hr ?? '–'}</td><td><button class="x" data-id="${esc(String(r.id))}" title="Delete this ride">✕</button></td></tr>`)
      .join('');
}
$('s-test').onclick = () => {
  testPower = testPower === null ? 200 : null;
  $('test-w').textContent = testPower ?? 0;
  deviceUi();
};
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
  if (!canRide()) return 'Connect your trainer to start';
  const pick = pickedSession();
  return pick ? `Start session · ${pick.workout.name}` : `Start ride · ${route.name}`;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mpStatus = (text, err = false) => {
  for (const id of ['mp-status', 'acc-status']) {
    $(id).textContent = text;
    $(id).className = err ? 'hint err' : 'hint';
  }
};
function mpUi() {
  $('tab-together').hidden = $('acc').hidden = !net.available;
  $('mp-auth').hidden = !!net.user;
  $('acc-in').hidden = !net.user;
  $('mp-need').hidden = !!net.user;
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
    gender: settings.gender, kit: kitColor(), route: routeId, riding: ride.active, finished: ride.finished, dist: Math.round(ride.dist * 10) / 10,
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
function needTrainer() {
  if (canRide()) return false;
  const ss = $('s-trainer-status');
  ss.className = 'hint err';
  ss.textContent = 'Connect your trainer first: pedal a few strokes to wake it, then click "Connect trainer".';
  $('s-trainer').scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}
function goClicked() {
  if (needTrainer()) return;
  const startDist = route.landmarks[+$('i-start').value].dist;
  if (net.room && [...net.peers.values()].some((p) => !p.riding) && !othersRiding()) {
    net.send('start', { id: net.user.id, in: 5, startDist, route: routeId, length: +$('i-length').value || 0 });
    startCountdown(5, startDist);
  } else startRide(startDist);
}
net.onstart = async (p) => {
  if (ride.active || countdown || !isFinite(p.startDist)) return;
  if (!canRide()) return mpStatus('The group ride is starting. Connect your trainer, then click "Join the ride".', true);
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
  applyAccount();
  mpUi();
  const invited = cleanCode(params.get('room'));
  if (net.user && invited && !net.room) joinRoom(invited);
  else if (invited && !net.user) {
    mpStatus(`You are invited to room ${invited}. Sign in or create an account to join.`);
    showTab('profile');
  }
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
    const look = `${p.name}|${p.gender}|${p.kit}`;
    if (r && r.look !== look) {
      world.removeRemote(r);
      r = null;
    }
    if (!r) {
      let h = 0;
      for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      const kit = KITS[h % KITS.length];
      remotes.set(p.id, (r = world.addRemote(p.name, { ...kit, gender: p.gender, ...(p.kit >= 0 ? { jersey: p.kit } : {}) })));
      r.look = look;
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
for (const [id, key] of [['i-gender', 'gender'], ['i-kit', 'kit']]) {
  $(id).value = settings[key];
  $(id).addEventListener('input', () => {
    settings[key] = $(id).value;
    guessFtp();
    saveSettings();
    trainingUi();
    world?.setPlayerLook(myLook());
  });
}
// show which level Auto has settled on
const qualityLabel = () => ($('i-quality').options[0].textContent = settings.quality === 'auto' && settings.autoLevel !== 'high' ? `Auto (now ${settings.autoLevel})` : 'Auto (adjusts itself)');
$('i-quality').value = settings.quality;
qualityLabel();
$('i-quality').addEventListener('change', () => {
  settings.quality = $('i-quality').value;
  if (settings.quality === 'auto') settings.autoLevel = 'high';
  saveSettings();
  world?.setQuality(qualityNow());
  qualityLabel();
});
$('i-weather').value = settings.weather;
$('i-weather').addEventListener('change', () => {
  settings.weather = $('i-weather').value;
  saveSettings();
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
  $('h-togo').textContent = run ? run.w.name : `${((ride.endDist - ride.dist) / 1000).toFixed(1)} km ${toGo()}`;
  if (run) updateSessionHud();
  $('h-ele').textContent = Math.round(route.ele(ride.dist));
  $('h-climb').textContent = Math.round(ride.climbed);
  $('h-time').textContent = fmtTime(ride.moving);
  $('h-eta').textContent = ride.finished ? '0:00' : run ? (run.inRamp ? `${run.watts()} W` : fmtTime(run.total - run.elapsed)) : fmtTime(ride.eta);
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
// Smoothness watch for the 'auto' graphics level.
const perf = { warm: 0, t: 0, n: 0 };
function watchSmoothness(ms) {
  const riding = ride.active && !ride.finished && $('summary').hidden && document.visibilityState === 'visible' && document.hasFocus();
  if (!riding || ms > 400) { perf.warm = perf.t = perf.n = 0; return; } // not riding, or a stall that says nothing about the graphics
  if ((perf.warm += ms) < 5000) return; // let the scene settle first
  perf.t += ms;
  perf.n++;
  if (perf.t < 4000) return;
  const fps = (perf.n * 1000) / perf.t;
  perf.t = perf.n = 0;
  const level = qualityNow();
  if (settings.quality !== 'auto' || fps >= 38 || level === 'low') return;
  settings.autoLevel = level === 'high' ? 'medium' : 'low';
  saveSettings();
  world.setQuality(settings.autoLevel);
  qualityLabel();
  perf.warm = 0;
  toast(`Graphics set to ${settings.autoLevel} to keep the ride smooth`, 5000);
}
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
  if (lastFrame) watchSmoothness(now - lastFrame);
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
  { id: 'posbank', name: 'Posbank', type: 'Rolling', km: 15, up: 145 },
  { id: 'limburg', name: 'Limburg hills', type: 'Hilly', km: 30, up: 366 },
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
  saveSettings();
  $('i-route').value = id;
  routeCards();
  const avg = ((route.E[route.n - 1] - route.E[0]) / route.total) * 100;
  let steep = 0;
  for (let d = 250; d < route.total; d += 100) steep = Math.max(steep, route.grade(d, 500));
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

  $('rc-facts').textContent += '  ·  loading scenery…';
  const imagery = params.get('sat') === '0' ? null : await loadImagery(route);
  if (ride.active) return false;
  $('rc-facts').textContent = $('rc-facts').textContent.replace('  ·  loading scenery…', '');
  for (const r of remotes.values()) world?.removeRemote(r);
  remotes.clear();
  bots.length = 0;
  world?.dispose();
  weather = new Weather(route, imagery);
  world = new World($('scene'), route, imagery, myLook(), qualityNow());
  profile = new RouteProfile($('profile'), route);
  ahead = new AheadProfile($('ahead'), route);
  minimap = new MiniMap($('minimap'), route);
  KITS.forEach((k) => bots.push({ rider: world.addBot(k), dist: 0, v: 0, power: 200, crank: 0 }));
  ride.dist = 0;
  await loadWeather();
  $('s-go').disabled = false;
  deviceUi();
  trainingUi();
  sendState();
  return true;
}
const chooseRoute = (id) => (routeLoading = (routeLoading || Promise.resolve()).then(() => setRoute(id)));

async function init() {
  if (!bluetoothAvailable()) {
    $('s-foot').hidden = false;
    $('s-foot').textContent = 'This browser has no Web Bluetooth, so the trainer cannot connect. Open this page in Chrome or Edge.';
  }
  $('i-route').innerHTML = Object.keys(TYPES)
    .map((t) => `<optgroup label="${TYPES[t]}">${ROUTES.filter((r) => r.type === t).map((r) => `<option value="${r.id}">${esc(r.name)} · ${r.km} km · ${r.up} m↑</option>`).join('')}</optgroup>`)
    .join('');
  progress.load();
  if (params.get('autostart')) mode = params.get('session') ? 'training' : 'ride';
  showTab(params.get('autostart') ? mode : settings.tab || 'ride');
  $('i-start').addEventListener('change', lengthOptions);
  $('i-route').addEventListener('change', () => chooseRoute($('i-route').value));
  if (params.get('wx')) settings.weather = $('i-weather').value = params.get('wx');
  if (!(await chooseRoute(params.get('route') || settings.route || 'ventoux'))) return;

  $('s-go').onclick = goClicked;
  net.init().catch((e) => {
    console.error(e);
    $('tab-together').hidden = $('acc').hidden = false;
    mpStatus(`Riding together is unavailable: ${e.message}`, true);
  });
  deviceUi();
  requestAnimationFrame(frame);

  // dev helpers: ?autostart=1&km=16&demo=250&cam=2&route=galibier
  if (params.get('autostart')) {
    for (let i = 0; i < (+params.get('cam') || 0); i++) $('b-cam').click();
    if (params.get('session')) $('i-workout').value = `p${params.get('session')}`; // &session=0 rides the plan's first session
    startRide(Math.min(route.total - 50, (+params.get('km') || 0) * 1000), (+params.get('len') || 0) * 1000);
    ride.v = 4;
    for (let i = 0; i < (+params.get('ff') || 0); i++) simulate(1);
  }
}
init();
window.sommet = { net, ride, progress, get run() { return run; }, get routeId() { return routeId; }, get world() { return world; }, get route() { return route; } }; // handy in the browser console
