// Route geometry: real GPS trace of the climb, projected to local metres.
// World coordinates: x = east, z = -north (so y is up), all in metres.

const SUMMIT_ELEVATION = 1909;

const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
const crd = (p0, p1, p2, p3, t) =>
  0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t * t);

export async function loadRoute(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load route (${res.status})`);
  return new Route(await res.json());
}

export class Route {
  constructor(data) {
    const pts = data.route, n = pts.length;
    this.name = data.name;
    this.sub = data.sub;
    this.lat0 = data.lat0;
    this.lon0 = data.lon0;
    this.grid = data.grid;
    this.n = n;
    const X = (this.X = new Float64Array(n));
    const Z = (this.Z = new Float64Array(n));
    const E = (this.E = new Float64Array(n));
    const D = (this.D = new Float64Array(n));

    // Horizontal geometry first.
    for (let i = 0; i < n; i++) {
      X[i] = pts[i][0];
      Z[i] = -pts[i][1];
      if (i > 0) D[i] = D[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
    }

    // DEM samples along a road cut into a steep slope are noisy at the
    // 100-300 m scale (they would give fake 20% ramps). Smooth them, then
    // limit the slope to what the real road has.
    const raw = pts.map((p) => p[2]);
    const SIGMA = 18, R = SIGMA * 3; // samples (~10 m each)
    const sample = (i) => (i < 0 ? 2 * raw[0] - raw[-i] : i >= n ? 2 * raw[n - 1] - raw[2 * (n - 1) - i] : raw[i]);
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0, wsum = 0;
      for (let k = -R; k <= R; k++) {
        const w = Math.exp(-0.5 * (k / SIGMA) ** 2);
        acc += sample(i + k) * w;
        wsum += w;
      }
      sm[i] = acc / wsum;
    }
    const MAX_SLOPE = 0.118;
    raw[0] = sm[0];
    for (let i = 1; i < n; i++) {
      const ds = D[i] - D[i - 1];
      const minSlope = D[i] < 5000 ? -0.04 : 0.005;
      raw[i] = raw[i - 1] + Math.min(MAX_SLOPE, Math.max(minSlope, (sm[i] - sm[i - 1]) / ds)) * ds;
    }

    // The DEM underestimates the summit a little; rescale so the top is right.
    const e0 = raw[0];
    const k = (SUMMIT_ELEVATION - e0) / (raw[n - 1] - e0);
    const kGrid = (SUMMIT_ELEVATION - e0) / (pts[n - 1][2] - e0);
    this.scaleEle = (h) => e0 + (h - e0) * kGrid;

    let ascent = 0;
    for (let i = 0; i < n; i++) {
      E[i] = e0 + (raw[i] - e0) * k;
      if (i > 0 && E[i] > E[i - 1]) ascent += E[i] - E[i - 1];
    }
    this.total = D[n - 1];
    this.ascent = ascent;
    this.minEle = Math.min(...E);
    this.maxEle = Math.max(...E);

    // Spatial hash for nearest-road queries.
    this.cell = 120;
    this.hash = new Map();
    for (let i = 0; i < n; i++) {
      const key = this._key(Math.floor(X[i] / this.cell), Math.floor(Z[i] / this.cell));
      let a = this.hash.get(key);
      if (!a) this.hash.set(key, (a = []));
      a.push(i);
    }
    this._nr = { d: 0, ele: 0, dist: 0 };

    const firstAbove = (ele) => {
      for (let i = 0; i < n; i++) if (E[i] >= ele) return D[i];
      return this.total;
    };
    this.landmarks = [
      { name: 'Bédoin', dist: 0 },
      { name: 'Saint-Estève', dist: this._forestStart() },
      { name: 'Chalet Reynard', dist: firstAbove(1417) },
      { name: 'Stèle Tom Simpson', dist: this.total - 1350 },
      { name: 'Sommet', dist: this.total },
    ];
  }

  // The famous hairpin where the gentle approach ends and the forest ramps begin.
  _forestStart() {
    for (let d = 3000; d < 9000; d += 50) {
      if ((this.ele(d + 1000) - this.ele(d)) / 10 > 8) return d;
    }
    return 5800;
  }

  _key(cx, cz) {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  _index(dist) {
    const D = this.D;
    let lo = 0, hi = this.n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (D[mid] <= dist) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  ele(dist) {
    if (dist <= 0) return this.E[0];
    if (dist >= this.total) return this.E[this.n - 1];
    const i = this._index(dist);
    const t = (dist - this.D[i]) / (this.D[i + 1] - this.D[i]);
    return this.E[i] + (this.E[i + 1] - this.E[i]) * t;
  }

  // Gradient in percent, measured over `span` metres centred on dist.
  grade(dist, span = 24) {
    const a = Math.max(0, dist - span / 2), b = Math.min(this.total, dist + span / 2);
    if (b - a < 1) return 0;
    return ((this.ele(b) - this.ele(a)) / (b - a)) * 100;
  }

  // Position and unit tangent at a distance along the road. Extrapolates
  // in a straight, level line beyond either end.
  at(dist, out) {
    const { X, Z, E, D, n } = this;
    if (dist <= 0 || dist >= this.total) {
      const i = dist <= 0 ? 0 : n - 2;
      let tx = X[i + 1] - X[i], tz = Z[i + 1] - Z[i];
      const l = Math.hypot(tx, tz);
      tx /= l; tz /= l;
      const b = dist <= 0 ? 0 : n - 1;
      const extra = dist <= 0 ? dist : dist - this.total;
      out.x = X[b] + tx * extra; out.z = Z[b] + tz * extra; out.y = E[b];
      out.tx = tx; out.tz = tz;
      return out;
    }
    const i = this._index(dist);
    const t = (dist - D[i]) / (D[i + 1] - D[i]);
    const a = Math.max(0, i - 1), c = i + 1, d = Math.min(n - 1, i + 2);
    out.x = cr(X[a], X[i], X[c], X[d], t);
    out.z = cr(Z[a], Z[i], Z[c], Z[d], t);
    out.y = E[i] + (E[c] - E[i]) * t;
    let tx = crd(X[a], X[i], X[c], X[d], t), tz = crd(Z[a], Z[i], Z[c], Z[d], t);
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    return out;
  }

  // Nearest point on the road within ~120 m, or null. Returns a shared object.
  nearest(x, z) {
    const { X, Z, E, D, n, cell } = this;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best = Infinity, bi = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = this.hash.get(this._key(cx + dx, cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const d2 = (X[i] - x) * (X[i] - x) + (Z[i] - z) * (Z[i] - z);
          if (d2 < best) { best = d2; bi = i; }
        }
      }
    }
    if (bi < 0) return null;
    const out = this._nr;
    out.ele = E[bi]; out.dist = D[bi];
    for (let a = Math.max(0, bi - 1); a <= Math.min(n - 2, bi); a++) {
      const b = a + 1;
      const sx = X[b] - X[a], sz = Z[b] - Z[a];
      const len2 = sx * sx + sz * sz;
      if (len2 === 0) continue;
      const t = Math.min(1, Math.max(0, ((x - X[a]) * sx + (z - Z[a]) * sz) / len2));
      const px = X[a] + sx * t, pz = Z[a] + sz * t;
      const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d2 <= best) {
        best = d2;
        out.ele = E[a] + (E[b] - E[a]) * t;
        out.dist = D[a] + (D[b] - D[a]) * t;
      }
    }
    out.d = Math.sqrt(best);
    return out;
  }

  latLon(x, z) {
    return {
      lat: this.lat0 + -z / 111132,
      lon: this.lon0 + x / (111320 * Math.cos((this.lat0 * Math.PI) / 180)),
    };
  }
}
