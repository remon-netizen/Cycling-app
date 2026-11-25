// Training: half-hour sessions with power targets, a 12-week winter plan built
// from them, and a fitness test that sets the targets to the rider's own level.
//
// Every target is a share of FTP (the power you could hold for about an hour),
// so the same session suits a beginner and a strong rider alike.

const M = 60;
const CAD_FAST = [95, 105], CAD_SLOW = [60, 68];

// kind: warm | easy | work | cool.  from/to: share of FTP (or watts when abs).
const warm = (min, to = 0.6) => ({ kind: 'warm', dur: min * M, from: 0.42, to, text: 'Warm up: easy pedalling, let the legs wake up' });
const cool = (min, from = 0.55) => ({ kind: 'cool', dur: min * M, from, to: 0.4, text: 'Cool down: spin the legs out' });
const easy = (min, f = 0.55, text = 'Easy: get your breath back') => ({ kind: 'easy', dur: min * M, from: f, to: f, text });
const work = (min, f, text, cad = null) => ({ kind: 'work', dur: min * M, from: f, to: f, text, cad });
const steady = (min, f, text = 'Steady: you should be able to talk in full sentences') => ({ kind: 'steady', dur: min * M, from: f, to: f, text });
// n efforts with a rest between them (not after the last)
const reps = (n, on, off) => Array.from({ length: n }, (_, i) => (i < n - 1 ? [{ ...on }, { ...off }] : [{ ...on }])).flat();

const TXT = {
  tempo: 'Tempo: brisk but controlled, short sentences only',
  sweet: 'Sweet spot: firm and steady, breathe deep, relax the shoulders',
  thr: 'Threshold: hard but even. Do not start too fast',
  hard: 'Hard: strong for one minute, stay seated',
  fast: 'Fast legs: spin quickly, keep the hips still on the saddle',
  slow: 'Strength: slow cadence, push smoothly over the top',
  surge: 'Surge: lift the pace',
};

const W = (id, name, why, steps) => ({ id, name, why, steps: steps.flat() });

// The fitness test: watts go up a little every minute until you cannot follow.
function testWorkout() {
  const steps = [{ kind: 'warm', abs: true, dur: 5 * M, from: 50, to: 50, text: 'Warm up: easy pedalling. The test starts after this' }];
  for (let w = 60; w <= 460; w += 10) steps.push({ kind: 'work', abs: true, dur: M, from: w, to: w, text: 'Every minute a little harder. Keep going until you really cannot' });
  return {
    id: 'test', test: true, name: 'Fitness test',
    why: 'Starts very easy and gets 10 watts harder every minute. Ride until you cannot keep up; that takes 5 to 20 minutes. It sets the watts of every session to your level.',
    steps,
  };
}

const WORKOUTS = [
  testWorkout(),
  W('spin', 'Easy spin', 'Gentle riding. Easy days are where the body builds on the harder ones.', [warm(5, 0.58), steady(20, 0.6, 'Easy: relaxed, breathing through the nose is fine'), cool(5)]),
  W('cadence', 'Fast legs', 'Short spells of quick pedalling teach the legs to turn smoothly, which makes every ride feel easier.', [warm(5), reps(6, work(1, 0.65, TXT.fast, CAD_FAST), easy(2)), steady(4, 0.6), cool(5)]),
  W('steps', 'Endurance steps', 'Steady riding with small steps up: the base that everything else stands on.', [warm(5), reps(3, steady(4, 0.65), steady(2, 0.72, 'A touch harder, still comfortable')), steady(4, 0.62), cool(5)]),
  W('tempo-3x3', 'Tempo taster 3 × 3', 'A first taste of riding a bit harder than comfortable, in short blocks.', [warm(6), reps(3, work(3, 0.8, TXT.tempo), easy(3)), steady(4, 0.6), cool(5)]),
  W('steady-20', 'Steady 20', 'Twenty unbroken minutes at an easy, steady effort.', [warm(5), steady(20, 0.65), cool(5)]),
  W('tempo-3x4', 'Tempo 3 × 4', 'Longer tempo blocks: you learn to hold an effort.', [warm(6), reps(3, work(4, 0.82, TXT.tempo), easy(3)), cool(6)]),
  W('cadence-8', 'Fast legs 8 × 1', 'More quick-pedalling practice, with shorter rests.', [warm(5), reps(8, work(1, 0.7, TXT.fast, CAD_FAST), easy(1.5)), cool(6.5)]),
  W('steady-22', 'Endurance 22', 'A slightly longer steady ride.', [warm(4), steady(22, 0.68), cool(4)]),
  W('light-tempo', 'Light tempo 2 × 4', 'An easier week: a little effort to keep the legs awake while the body catches up.', [warm(6), reps(2, work(4, 0.78, TXT.tempo), easy(4)), steady(7, 0.6), cool(5)]),
  W('pickups', 'Easy with pick-ups', 'Easy riding with three short lifts in pace.', [warm(5), steady(5, 0.6), reps(3, work(1, 0.85, TXT.surge), easy(3)), steady(6, 0.6), cool(5)]),
  W('ss-3x4', 'Sweet spot 3 × 4', 'Sweet spot is just below your limit: the most fitness for the least time.', [warm(6), reps(3, work(4, 0.88, TXT.sweet), easy(3)), cool(6)]),
  W('steady-70', 'Endurance 22 +', 'Steady riding, a notch higher than before.', [warm(4), steady(22, 0.7), cool(4)]),
  W('ss-3x5', 'Sweet spot 3 × 5', 'Five-minute blocks at sweet spot.', [warm(5), reps(3, work(5, 0.88, TXT.sweet), easy(3)), cool(4)]),
  W('strength', 'Strength 4 × 3', 'Slow, strong pedalling builds leg strength, like climbing a hill in a big gear.', [warm(6), reps(4, work(3, 0.8, TXT.slow, CAD_SLOW), easy(3)), cool(3)]),
  W('surges', 'Endurance with surges', 'Steady riding with a short lift every few minutes, as on a rolling road.', [warm(5), reps(4, steady(4, 0.68), work(1, 0.9, TXT.surge)), steady(1, 0.6), cool(5)]),
  W('ss-2x8', 'Sweet spot 2 × 8', 'Two long blocks: now you are training stamina.', [warm(5), reps(2, work(8, 0.88, TXT.sweet), easy(4)), cool(5)]),
  W('thr-4x3', 'Threshold taster 4 × 3', 'Short blocks at about the hardest effort you could hold for an hour.', [warm(6), reps(4, work(3, 0.95, TXT.thr), easy(3)), cool(3)]),
  W('light-tempo-5', 'Light tempo 2 × 5', 'An easier week again, to arrive fresh at the next test.', [warm(6), reps(2, work(5, 0.8, TXT.tempo), easy(4)), steady(5, 0.6), cool(5)]),
  W('thr-3x5', 'Threshold 3 × 5', 'Five-minute blocks at threshold: this raises the power you can hold for long.', [warm(5), reps(3, work(5, 0.95, TXT.thr), easy(3)), cool(4)]),
  W('thr-2x8', 'Threshold 2 × 8', 'Two long threshold blocks.', [warm(5), reps(2, work(8, 0.95, TXT.thr), easy(4)), cool(5)]),
  W('hard-6x1', 'Short and hard 6 × 1', 'One-minute efforts above your limit, with plenty of rest. Short, sharp, and over quickly.', [warm(7), reps(6, work(1, 1.1, TXT.hard), easy(2)), steady(3, 0.6), cool(4)]),
  W('ss-2x9', 'Sweet spot 2 × 9', 'Nine-minute blocks: nearly twenty minutes of quality work.', [warm(5), reps(2, work(9, 0.9, TXT.sweet), easy(3)), cool(4)]),
  W('thr-2x9', 'Threshold 2 × 9', 'The hardest session of the plan. Even pacing is everything.', [warm(5), reps(2, work(9, 0.97, TXT.thr), easy(3)), cool(4)]),
  W('hard-8x1', 'Short and hard 8 × 1', 'Eight one-minute efforts with short rests.', [warm(6), reps(8, work(1, 1.12, TXT.hard), easy(1.5)), cool(5.5)]),
  W('tempo-20', 'Tempo 20', 'Twenty minutes of tempo in one go. In week one this would have been unthinkable.', [warm(5), work(20, 0.82, TXT.tempo), cool(5)]),
  W('openers', 'Easy with openers', 'Easy riding with three one-minute efforts to be sharp for the final test.', [warm(5), steady(8, 0.6), reps(3, work(1, 1.0, TXT.surge), easy(3)), steady(3, 0.6), cool(5)]),
];
export const workout = (id) => WORKOUTS.find((w) => w.id === id) || null;

// Twelve weeks, three sessions a week. Weeks 4 and 8 are lighter; a test every four weeks.
export const PLAN = {
  name: 'Winter plan',
  about: '12 weeks · 3 sessions of 30 minutes a week',
  weeks: [
    { theme: 'Getting started', ids: ['test', 'spin', 'cadence'] },
    { theme: 'Building the habit', ids: ['steps', 'tempo-3x3', 'steady-20'] },
    { theme: 'A little more', ids: ['tempo-3x4', 'cadence-8', 'steady-22'] },
    { theme: 'Easier week', ids: ['spin', 'light-tempo', 'pickups'] },
    { theme: 'New test, sweet spot', ids: ['test', 'ss-3x4', 'steady-70'] },
    { theme: 'Sweet spot and strength', ids: ['ss-3x5', 'strength', 'surges'] },
    { theme: 'Longer blocks', ids: ['ss-2x8', 'thr-4x3', 'steady-70'] },
    { theme: 'Easier week', ids: ['spin', 'light-tempo-5', 'cadence'] },
    { theme: 'New test, threshold', ids: ['test', 'thr-3x5', 'surges'] },
    { theme: 'Stronger', ids: ['thr-2x8', 'hard-6x1', 'ss-2x9'] },
    { theme: 'The big week', ids: ['thr-2x9', 'hard-8x1', 'tempo-20'] },
    { theme: 'Sharpen and test', ids: ['ss-2x8', 'openers', 'test'] },
  ],
};
export const SESSIONS = PLAN.weeks.flatMap((w, wi) => w.ids.map((id, si) => ({ index: wi * 3 + si, week: wi + 1, n: si + 1, theme: w.theme, workout: workout(id) })));
export const minutes = (w) => Math.round(w.steps.reduce((a, s) => a + s.dur, 0) / 60);

// Share of FTP -> colour, the same zones as the power number on screen.
export function zoneOf(r) {
  if (r < 0.55) return '#c9d0db';
  if (r < 0.76) return '#6fb7ff';
  if (r < 0.91) return '#62d27a';
  if (r < 1.06) return '#f1d94a';
  if (r < 1.21) return '#f79a3e';
  return '#f2594b';
}

// The shape of a session as an SVG: one block per step, taller = harder.
export function sessionSvg(w, { steps = w.steps, height = 46 } = {}) {
  const shown = w.test ? steps.slice(0, Math.max(26, steps.findIndex((s) => s.kind === 'cool') + 1 || 0)) : steps;
  const total = shown.reduce((a, s) => a + s.dur, 0);
  const share = (s, v) => (s.abs ? v / 220 : v);
  const top = Math.max(1.15, ...shown.map((s) => Math.max(share(s, s.from), share(s, s.to))));
  const Wd = 600, y = (f) => height - (f / top) * (height - 2);
  let x = 0, out = '';
  for (const s of shown) {
    const w2 = (s.dur / total) * Wd, a = share(s, s.from), b = share(s, s.to);
    out += `<polygon points="${x.toFixed(1)},${height} ${x.toFixed(1)},${y(a).toFixed(1)} ${(x + w2 - 0.8).toFixed(1)},${y(b).toFixed(1)} ${(x + w2 - 0.8).toFixed(1)},${height}" fill="${zoneOf(Math.max(a, b))}"/>`;
    x += w2;
  }
  return { svg: `<svg viewBox="0 0 ${Wd} ${height}" preserveAspectRatio="none" aria-hidden="true">${out}</svg>`, total };
}

// One session being ridden.
export class Run {
  constructor(w, ftp, planIndex = null) {
    this.w = w;
    this.test = !!w.test;
    this.ftp = ftp;
    this.planIndex = planIndex;
    this.steps = w.steps.map((s) => ({ ...s }));
    this.i = 0;
    this.t = 0; // seconds into the current step
    this.elapsed = 0;
    this.scale = 1; // "make it easier / harder"
    this.good = 0;
    this.judged = 0;
    this.done = false;
    this.result = null; // fitness test outcome
    this._log = []; // watts, one a second, during the test ramp
    this._acc = 0;
    this._sum = 0;
    this._low = 0;
  }
  get step() {
    return this.steps[Math.min(this.i, this.steps.length - 1)];
  }
  get total() {
    return this.steps.reduce((a, s) => a + s.dur, 0);
  }
  get left() {
    return Math.max(0, this.step.dur - this.t);
  }
  get inRamp() {
    return this.test && !this.result && this.step.kind === 'work';
  }
  wattsOf(s, t = 0) {
    const f = s.from + (s.to - s.from) * Math.min(1, t / s.dur);
    return Math.max(25, Math.round(s.abs ? f : f * this.ftp * this.scale));
  }
  watts() {
    return this.wattsOf(this.step, this.t);
  }
  // "Effort 2 of 3"
  count() {
    if (this.step.kind !== 'work' || this.test) return '';
    const all = this.steps.filter((s) => s.kind === 'work').length;
    return all > 1 ? `Effort ${this.steps.slice(0, this.i + 1).filter((s) => s.kind === 'work').length} of ${all}` : '';
  }
  next() {
    return this.steps[this.i + 1] || null;
  }

  // Returns 'step' when a new step begins, 'done' at the end, 'test-over' when
  // the rider could not follow the test any longer.
  advance(dt, power, cadence) {
    if (this.done) return null;
    const target = this.watts();
    if (this.inRamp) {
      // log the ramp and notice when the rider cannot follow any more
      this._acc += dt;
      this._sum += power * dt;
      if (this._acc >= 1) {
        this._log.push(this._sum / this._acc);
        this._sum = this._acc = 0;
      }
      this._low = power < target * 0.82 || (cadence > 0 && cadence < 45) ? this._low + dt : 0;
      if (this._low > 10 && this._log.length > 90) {
        this.endTest();
        return 'test-over';
      }
    } else if (power < 1) return null; // the clock waits while you are off the pedals
    if (this.step.kind !== 'warm' && this.step.kind !== 'cool' && !this.test) {
      this.judged += dt;
      if (Math.abs(power - target) <= Math.max(8, target * 0.08)) this.good += dt;
    }
    this.t += dt;
    this.elapsed += dt;
    if (this.t < this.step.dur) return null;
    this.t -= this.step.dur;
    this.i++;
    if (this.i >= this.steps.length) {
      if (this.test && !this.result) {
        this.i = this.steps.length - 1;
        this.t = this.step.dur;
        this.endTest();
        return 'test-over';
      }
      this.i = this.steps.length - 1;
      this.t = this.step.dur;
      this.done = true;
      return 'done';
    }
    return 'step';
  }

  // Stop the test ramp: work out the result and go to the cool-down.
  endTest() {
    if (!this.test || this.result) return this.result;
    const p = this._log;
    let best = 0, sum = 0;
    for (let i = 0; i < p.length; i++) {
      sum += p[i];
      if (i >= 60) sum -= p[i - 60];
      if (i >= 59) best = Math.max(best, sum / 60);
    }
    // FTP is about three quarters of the best minute of a ramp test
    this.result = best > 0 ? { best: Math.round(best), ftp: Math.min(500, Math.max(40, Math.round(best * 0.75))) } : { best: 0, ftp: null };
    const c = Math.max(40, Math.round((this.result.ftp || 100) * 0.5));
    const cur = this.step;
    this.steps = [...this.steps.slice(0, this.i), ...(this.t > 1 ? [{ ...cur, dur: this.t }] : []), { kind: 'cool', abs: true, dur: 4 * M, from: c, to: Math.max(35, c - 10), text: 'Well done! Spin the legs out' }];
    this.i = this.steps.length - 1;
    this.t = 0;
    this._low = 0;
    return this.result;
  }
  // share of the judged time spent on target, 0..1 (null when there was nothing to judge)
  get score() {
    return this.judged > 30 ? this.good / this.judged : null;
  }
}

// Where the rider is in the plan. Kept in the browser and, when signed in, in
// the account (Supabase user metadata), so it follows the rider to any device.
const blank = () => ({ ftp: null, done: {}, tests: [], updated: 0 });
export class Progress {
  constructor(net) {
    this.net = net;
    this.state = blank();
  }
  get _key() {
    return 'sommet.training.' + (this.net.user?.id || 'device');
  }
  load() {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(this._key) || 'null'); } catch {}
    const remote = this.net.user?.meta?.training || null;
    const pick = remote && (!local || (remote.updated || 0) >= (local.updated || 0)) ? remote : local;
    this.state = Object.assign(blank(), pick ? JSON.parse(JSON.stringify(pick)) : {});
    return this.state;
  }
  save() {
    this.state.updated = Date.now();
    localStorage.setItem(this._key, JSON.stringify(this.state));
    this.net.saveMeta?.({ training: this.state });
  }
  get count() {
    return Object.keys(this.state.done).length;
  }
  get next() {
    return SESSIONS.find((s) => !this.state.done[s.index]) || null;
  }
  complete(index, score) {
    this.state.done[index] = { at: new Date().toISOString().slice(0, 10), ...(score === null || score === undefined ? {} : { s: Math.round(score * 100) }) };
    this.save();
  }
  setFtp(ftp) {
    this.state.ftp = ftp;
    this.state.tests = [...this.state.tests, { at: new Date().toISOString().slice(0, 10), ftp }].slice(-24);
    this.save();
  }
  reset() {
    this.state = Object.assign(blank(), { ftp: this.state.ftp, tests: this.state.tests });
    this.save();
  }
}
