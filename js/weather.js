// Weather on the climb: live conditions from Open-Meteo (free, no key) at three
// heights on the mountain, plus a wind model that knows the road is sheltered in
// the forest and fully exposed on the bare limestone above Chalet Reynard.

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// Forecast wind is given 10 m above open ground; a rider sits at about 1.5 m.
const RIDER_HEIGHT = 0.75;
// Share of that wind that reaches the road.
const EXPOSURE_OPEN = 0.65; // vineyards and villages below the forest
const EXPOSURE_FOREST = 0.12; // cedar and beech close in on both sides
const EXPOSURE_BARE = 0.95; // nothing but scree

// speed/gust in m/s, dir = where the wind comes from (degrees from north).
const PRESETS = {
  mistral: [
    { speed: 6, gust: 11, dir: 340, temp: 15, cloud: 5 },
    { speed: 11, gust: 18, dir: 345, temp: 8, cloud: 5 },
    { speed: 19, gust: 29, dir: 350, temp: 3, cloud: 5 },
  ],
  calm: [
    { speed: 0, gust: 0, dir: 0, temp: 18, cloud: 10 },
    { speed: 0, gust: 0, dir: 0, temp: 12, cloud: 10 },
    { speed: 0, gust: 0, dir: 0, temp: 8, cloud: 10 },
  ],
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export class Weather {
  constructor(route) {
    this.route = route;
    const meta = route.meta;
    this.F = meta.forest;
    this.B = meta.bare || [1e8, 1e8 + 1];
    // foot of the climb, a point halfway up, and the top
    let mid = route.total / 2;
    if (route.climb) {
      const midEle = meta.midEle || (route.ele(0) + meta.topEle) / 2;
      for (let d = 0; d < route.total; d += 50) if (route.ele(d) >= midEle) { mid = d; break; }
    }
    this.stations = [0, mid, route.total].map((dist) => {
      const p = route.at(dist, {});
      return { dist, ele: route.ele(dist), ...route.latLon(p.x, p.z) };
    });
    this.names = [meta.start, meta.top];
    this.mode = 'calm';
    this.live = false;
    this.fetchedAt = 0;
    this._p = {};
    this._set(PRESETS.calm);
  }

  _set(obs) {
    this.obs = obs.map((o, i) => {
      const r = (o.dir * Math.PI) / 180;
      // u = towards east, n = towards north (the way the air moves)
      return { ...o, ele: this.stations[i].ele, dist: this.stations[i].dist, u: -Math.sin(r) * o.speed, n: -Math.cos(r) * o.speed, gustRatio: o.speed > 0.5 ? Math.max(1, o.gust / o.speed) : 1 };
    });
  }

  async _fetchLive() {
    const s = this.stations;
    const q = (f) => s.map(f).join(',');
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${q((x) => x.lat.toFixed(4))}&longitude=${q((x) => x.lon.toFixed(4))}` +
      `&elevation=${q((x) => Math.round(x.ele))}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code&wind_speed_unit=ms`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`weather service answered ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== s.length) throw new Error('unexpected weather answer');
    return data.map(({ current: c }) => ({
      speed: c.wind_speed_10m, gust: Math.max(c.wind_gusts_10m ?? 0, c.wind_speed_10m), dir: c.wind_direction_10m,
      temp: c.temperature_2m, cloud: c.cloud_cover ?? 0, code: c.weather_code,
    }));
  }

  // mode: 'live' | 'mistral' | 'calm'. Returns true if the requested weather is in use.
  async load(mode) {
    const turn = (this._turn = (this._turn || 0) + 1); // a later choice wins over a slow answer
    this.mode = mode;
    this.live = false;
    if (mode !== 'live') {
      this._set(PRESETS[mode] || PRESETS.calm);
      return true;
    }
    this._set(PRESETS.calm);
    try {
      const obs = await this._fetchLive();
      if (turn !== this._turn) return true;
      this._set(obs);
      this.live = true;
      this.fetchedAt = Date.now();
      return true;
    } catch (e) {
      console.warn('Live weather unavailable:', e);
      return turn !== this._turn;
    }
  }

  // Update live weather during a ride. If it fails, the last conditions stay.
  async refresh() {
    const turn = this._turn;
    try {
      const obs = await this._fetchLive();
      if (turn === this._turn && this.live) this._set(obs);
    } catch (e) {
      console.warn('Weather refresh failed, keeping the last conditions:', e);
    }
  }

  // How much of the wind reaches the road at this height.
  exposure(ele) {
    if (this.route.meta.exposure) return this.route.meta.exposure; // e.g. a dike in open water
    const F = this.F, B = this.B;
    const forest = F ? smooth(F[0], F[1], ele) * (1 - smooth(F[2], F[3], ele)) : 0;
    const bare = smooth(B[0], B[1], ele);
    return EXPOSURE_OPEN + forest * (EXPOSURE_FOREST - EXPOSURE_OPEN) + bare * (EXPOSURE_BARE - EXPOSURE_OPEN);
  }
  inForest(ele) {
    return this.exposure(ele) < 0.3;
  }

  // Forecast conditions at a height, blended between the three stations.
  _blend(ele, out, dist = 0) {
    const o = this.obs;
    // climbs: by height. other rides: by how far along the road you are
    const key = this.route.climb ? 'ele' : 'dist', at = this.route.climb ? ele : dist;
    const i = at < o[1][key] ? 0 : 1;
    const t = Math.min(1, Math.max(0, (at - o[i][key]) / (o[i + 1][key] - o[i][key] || 1)));
    for (const k of ['u', 'n', 'gustRatio', 'temp', 'cloud']) out[k] = lerp(o[i][k], o[i + 1][k], t);
    return out;
  }

  // 0 in a lull, 1 at the peak of a gust.
  _gust(time) {
    const s = 0.55 * Math.sin(time / 7.3) + 0.35 * Math.sin(time / 2.9 + 1.3) + 0.3 * Math.sin(time / 17 + 2.1);
    return s > 0 ? Math.pow(Math.min(1, s), 1.4) : s * 0.18;
  }

  // Wind felt on the road at `dist`. With `time` (seconds) the wind gusts,
  // without it you get the steady average. Fills and returns `out`:
  //   speed  m/s at rider height      head   m/s against the rider (negative = tailwind)
  //   side   m/s from the rider's left wx/wz  world-space velocity of the air
  //   temp   °C   cloud 0..1   exposure 0..1
  at(dist, time, out = {}) {
    const P = this.route.at(dist, this._p);
    const ele = this.route.ele(dist);
    this._blend(ele, out, dist);
    const exposure = this.exposure(ele);
    let k = RIDER_HEIGHT * exposure;
    if (time !== undefined) k *= 1 + (out.gustRatio - 1) * this._gust(time + dist / 40);
    const wx = out.u * k, wz = -out.n * k; // world z points south
    out.wx = wx;
    out.wz = wz;
    out.speed = Math.hypot(wx, wz);
    out.head = -(wx * P.tx + wz * P.tz);
    out.side = wx * -P.tz + wz * P.tx; // positive = blowing towards the rider's right
    out.exposure = exposure;
    out.forest = exposure < 0.3;
    out.cloud /= 100;
    return out;
  }

  // One line for the start screen.
  describe() {
    if (this.mode === 'calm' && !this.live) return 'No wind';
    const part = (i, name) => {
      const o = this.obs[i];
      return `${name} ${Math.round(o.temp)}°C, ${compass(o.dir)} ${Math.round(o.speed * 3.6)} km/h (gusts ${Math.round(o.gust * 3.6)})`;
    };
    return `${part(0, this.names[0])} · ${part(2, this.names[1])}`;
  }
}
