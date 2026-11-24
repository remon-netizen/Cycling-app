// Ride history and progress. Rides are saved to the rider's Supabase account
// when signed in (table: supabase/rides.sql), otherwise in this browser.

export const WINDOWS = [5, 60, 300, 1200, 3600]; // seconds
export const WINDOW_NAMES = { 5: '5 sec', 60: '1 min', 300: '5 min', 1200: '20 min', 3600: '60 min' };
const LOCAL_KEY = 'sommet.rides';
const COLUMNS = 'id,started_at,route,finished,start_m,distance_m,duration_s,climbed_m,avg_power,np,max_power,avg_hr,max_hr,avg_cadence,weight_kg,best';
const DAY = 86400000;

// Best average power held for `len` seconds, from one-a-second samples.
function bestAverage(p, len) {
  if (p.length < len) return null;
  let sum = 0, best = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    if (i >= len) sum -= p[i - len];
    if (i >= len - 1 && sum > best) best = sum;
  }
  return Math.round(best / len);
}

// Normalised power: what the ride "cost", weighting hard efforts more.
function normalised(p) {
  if (p.length < 60) return null;
  let sum = 0, acc = 0, n = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    if (i >= 30) sum -= p[i - 30];
    if (i >= 29) { acc += (sum / 30) ** 4; n++; }
  }
  return Math.round((acc / n) ** 0.25);
}

// Turn a finished (or abandoned) ride into the row that gets stored.
export function buildRecord(ride, routeId, weight) {
  const s = ride.samples;
  const p = s.map((x) => Math.round(x.power)), hr = s.map((x) => Math.round(x.hr)), cad = s.map((x) => Math.round(x.cadence));
  const hrOn = hr.filter((x) => x > 0);
  const best = {};
  for (const w of WINDOWS) {
    const b = bestAverage(p, w);
    if (b) best[w] = b;
  }
  const t = ride.moving || 1;
  return {
    started_at: ride.startDate.toISOString(), route: routeId, finished: ride.finished, start_m: Math.round(ride.startDist),
    distance_m: Math.round(ride.dist - ride.startDist), duration_s: Math.round(t), climbed_m: Math.round(ride.climbed),
    avg_power: Math.round(ride.powerSum / t), np: normalised(p), max_power: p.length ? Math.max(...p) : 0,
    avg_hr: hrOn.length ? Math.round(hrOn.reduce((a, b) => a + b, 0) / hrOn.length) : null, max_hr: hrOn.length ? Math.max(...hrOn) : null,
    avg_cadence: ride.cadTime ? Math.round(ride.cadSum / ride.cadTime) : null, weight_kg: weight, best,
    samples: { p, hr, cad, d: s.map((x) => Math.round(x.ridden)) },
  };
}

export class History {
  constructor(net) {
    this.net = net;
    this.rides = []; // newest first, without the per-second samples
    this.where = 'device';
  }
  get account() {
    return !!(this.net.sb && this.net.user);
  }
  _local() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
  }
  _saveLocal(rec) {
    const { samples, ...light } = rec; // the browser's storage is small: keep the summary only
    const all = [{ id: 'local-' + Date.now(), ...light }, ...this._local()].slice(0, 400);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  }

  async load() {
    this.where = 'device';
    this.rides = this._local();
    if (this.account) {
      const { data, error } = await this.net.sb.from('rides').select(COLUMNS).order('started_at', { ascending: false }).limit(500);
      if (error) console.warn('Could not load rides from the account:', error.message);
      else {
        this.where = 'account';
        this.rides = [...data, ...this.rides].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      }
    }
    return this.rides;
  }

  // Returns 'account' or 'device': where the ride ended up.
  async save(rec) {
    if (this.account) {
      const { error } = await this.net.sb.from('rides').insert(rec);
      if (!error) return 'account';
      console.warn('Could not save the ride to the account:', error.message);
    }
    this._saveLocal(rec);
    return 'device';
  }

  async remove(id) {
    if (String(id).startsWith('local-')) localStorage.setItem(LOCAL_KEY, JSON.stringify(this._local().filter((r) => r.id !== id)));
    else {
      const { error } = await this.net.sb.from('rides').delete().eq('id', id);
      if (error) throw error;
    }
    this.rides = this.rides.filter((r) => r.id !== id);
  }
}

const maxBest = (rides, w) => rides.reduce((m, r) => Math.max(m, r.best?.[w] || 0), 0);

// Everything the progress screen shows, from the list of rides.
export function summarise(rides, now = Date.now()) {
  const age = (r) => now - Date.parse(r.started_at);
  const recent = rides.filter((r) => age(r) <= 42 * DAY), before = rides.filter((r) => age(r) > 42 * DAY && age(r) <= 84 * DAY);
  const bests = WINDOWS.map((w) => ({ w, ever: maxBest(rides, w), recent: maxBest(recent, w), before: maxBest(before, w) }));
  const twenty = bests.find((b) => b.w === 1200);
  const ftp = Math.round((twenty.recent || twenty.ever) * 0.95) || null;
  const weight = rides.find((r) => r.weight_kg)?.weight_kg || null;
  const routes = {};
  for (const r of rides) {
    const e = (routes[r.route] ||= { route: r.route, rides: 0, best: null, bestAt: null, last: null });
    e.rides++;
    if (r.finished && r.start_m < 50) {
      if (!e.last) e.last = r.duration_s;
      if (!e.best || r.duration_s < e.best) { e.best = r.duration_s; e.bestAt = r.started_at; }
    }
  }
  return {
    count: rides.length,
    hours: rides.reduce((a, r) => a + r.duration_s, 0) / 3600,
    km: rides.reduce((a, r) => a + r.distance_m, 0) / 1000,
    climbed: rides.reduce((a, r) => a + r.climbed_m, 0),
    last28: rides.filter((r) => age(r) <= 28 * DAY).length,
    bests, ftp, weight, routes: Object.values(routes),
    // one point a ride for the trend chart, oldest first
    trend: rides.filter((r) => r.duration_s >= 600).map((r) => ({ t: Date.parse(r.started_at), w: r.best?.[1200] || r.np || r.avg_power, twenty: !!r.best?.[1200], route: r.route })).reverse(),
  };
}

// What this ride improved on, compared with the rides before it.
export function improvements(rec, earlier) {
  const out = [];
  for (const w of WINDOWS) {
    const prev = maxBest(earlier, w), now = rec.best?.[w];
    if (now && prev && now > prev) out.push(`Best ${WINDOW_NAMES[w]} power: ${now} W (+${now - prev})`);
  }
  if (rec.finished && rec.start_m < 50) {
    const times = earlier.filter((r) => r.route === rec.route && r.finished && r.start_m < 50).map((r) => r.duration_s);
    if (times.length && rec.duration_s < Math.min(...times)) out.unshift(`Fastest ascent yet, by ${Math.round(Math.min(...times) - rec.duration_s)} s`);
  }
  return out;
}
