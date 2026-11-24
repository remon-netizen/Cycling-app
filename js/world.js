import * as THREE from '../vendor/three.module.min.js';
import { createRider } from './rider.js';

// The 3D mountain: real terrain from a DEM grid, a finely meshed corridor that
// follows the road, forest below Chalet Reynard and bare limestone above it.

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash2(ix, iz), hash2(ix + 1, iz), u), lerp(hash2(ix, iz + 1), hash2(ix + 1, iz + 1), u), v);
}
const fbm = (x, z) => vnoise(x, z) * 0.5 + vnoise(x * 2.1 + 7, z * 2.1 + 3) * 0.3 + vnoise(x * 4.3 + 1, z * 4.3 + 9) * 0.2;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C = (hex) => new THREE.Color(hex);
const COL = {
  fieldA: C(0x8f9b54), fieldB: C(0xb9a66c), fieldC: C(0x6e8c46),
  forestA: C(0x3c5a30), forestB: C(0x50683a),
  screeA: C(0xd6d2c6), screeB: C(0xe9e6dc),
  meadowA: C(0x7d9a4e), meadowB: C(0x93a35a), meadowC: C(0x5f8a42),
  alpineA: C(0x868c6c), alpineB: C(0xa09f92), snow: C(0xf4f6f8),
  vergeLow: C(0x9c9278), vergeHigh: C(0xcbc6b8),
};
const HORIZON = 0xcfdfec;
const SUN = 3.5; // sunlight strength on a clear day
// Graphics levels. ratio: sharpness cap, shadow: shadow map size (0 = none),
// grass: blades per 30 m of road, range: how far trees and rocks are drawn (m).
export const QUALITY = {
// detail: within this distance trees are drawn in full, beyond it as simple shapes.
  low: { ratio: 1, shadow: 0, grass: 0, range: 1200, detail: 0, near: 'simple', far: 'simple' },
  medium: { ratio: 1.25, shadow: 2048, grass: 3000, range: 3000, detail: 400, near: 'mid', far: 'simple' },
  high: { ratio: 2, shadow: 4096, grass: 8500, range: 9000, detail: 700, near: 'full', far: 'mid' },
};

function merged(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    const c = C(color);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(c.r, c.g, c.b);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

// Like merged(), but each part fades from `color` at its base to `tip` at its top.
function mergedGrad(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color, tip } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    g.computeBoundingBox();
    const a = C(color), b = C(tip ?? color), y0 = g.boundingBox.min.y, y1 = g.boundingBox.max.y, P = g.attributes.position, N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      const c = a.clone().lerp(b, (P.getY(i) - y0) / Math.max(1e-6, y1 - y0));
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
// Nudge every corner of a shape a little, the same way for corners that coincide.
function jitter(geo, amount, seed) {
  const r = rng(seed), p = geo.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) seen.set(key, (d = [(r() - 0.5) * amount, (r() - 0.5) * amount * 0.6, (r() - 0.5) * amount]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  return geo;
}
function firTree(seed, tiers = 8, sides = 10, rings = 2) {
  const parts = [{ geo: new THREE.CylinderGeometry(0.03, 0.05, 0.3, 7).translate(0, 0.15, 0), color: 0x4a3626 }];
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1), rad = lerp(0.3, 0.05, Math.pow(t, 0.85)), hgt = lerp(0.26, 0.14, t);
    parts.push({ geo: jitter(new THREE.ConeGeometry(rad, hgt * (8 / tiers), sides, rings, true).translate(0, 0.17 + t * 0.68 + hgt / 2, 0), 0.045 * (1 - t * 0.6), seed + i), color: 0x16331f, tip: 0x3f6f3c });
  }
  return mergedGrad(parts);
}
// A house: walls, a pitched roof and a chimney. One unit is about 9 m of frontage.
function houseModel(brick) {
  const roof = new THREE.CylinderGeometry(0.46, 0.46, 1.04, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.71, 0);
  return mergedGrad([
    { geo: new THREE.BoxGeometry(1, 0.56, 0.7).translate(0, 0.28, 0), color: brick ? 0x9a5a3c : 0xe6dcc8, tip: brick ? 0xb06a48 : 0xf2ead8 },
    { geo: roof, color: brick ? 0x3b3e45 : 0xa5523a, tip: brick ? 0x4a4e57 : 0xbb6548 },
    { geo: new THREE.BoxGeometry(0.09, 0.3, 0.09).translate(0.28, 0.86, 0.08), color: 0x6b4a3a },
    { geo: new THREE.BoxGeometry(0.14, 0.26, 0.02).translate(-0.2, 0.13, 0.352), color: 0x4a3b30 }, // door
    { geo: new THREE.BoxGeometry(0.2, 0.16, 0.02).translate(0.2, 0.3, 0.352), color: 0x2c3a48 }, // window
  ]);
}
// A Holstein cow, about 2.4 m long at scale 1.
function cowModel() {
  const parts = [
    { geo: new THREE.BoxGeometry(0.62, 0.72, 1.7).translate(0, 1.05, 0), color: 0xf4f2ec },
    { geo: new THREE.BoxGeometry(0.64, 0.5, 0.6).translate(0, 1.12, 0.35), color: 0x18181a }, // patches
    { geo: new THREE.BoxGeometry(0.64, 0.36, 0.42).translate(0, 1.2, -0.55), color: 0x18181a },
    { geo: new THREE.BoxGeometry(0.34, 0.4, 0.62).translate(0, 0.98, 1.08).rotateX(0.5), color: 0x18181a }, // neck and head, grazing
    { geo: new THREE.BoxGeometry(0.26, 0.2, 0.2).translate(0, 0.55, 1.5), color: 0xe8b4a8 }, // muzzle
  ];
  for (const [x, z] of [[-0.22, 0.65], [0.22, 0.65], [-0.22, -0.65], [0.22, -0.65]]) parts.push({ geo: new THREE.BoxGeometry(0.15, 0.72, 0.15).translate(x, 0.36, z), color: 0xf4f2ec });
  return mergedGrad(parts);
}
// A Dutch windmill: body and cap as one shape, the sails as another so they can turn.
function windmillBody() {
  return mergedGrad([
    { geo: new THREE.CylinderGeometry(2.1, 4.2, 12, 8).translate(0, 6, 0), color: 0x4a3a2c, tip: 0x5f4b39 },
    { geo: new THREE.CylinderGeometry(4.6, 4.6, 0.5, 8).translate(0, 4.2, 0), color: 0xeae6dc }, // gallery
    { geo: new THREE.ConeGeometry(2.5, 2.6, 8).translate(0, 13.3, 0), color: 0x2f2a25 },
    { geo: new THREE.BoxGeometry(1.4, 2.2, 0.3).translate(0, 1.1, 4.1), color: 0x2b5a3a }, // door
  ]);
}
function windmillSails() {
  const parts = [{ geo: new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5), color: 0x2f2a25 }];
  for (let i = 0; i < 4; i++) {
    parts.push({ geo: new THREE.BoxGeometry(0.28, 11, 0.2).translate(0, 5.5, 1.1).rotateZ((i * Math.PI) / 2), color: 0x3a2f26 });
    parts.push({ geo: new THREE.BoxGeometry(2, 8.6, 0.08).translate(1.05, 6.4, 1.1).rotateZ((i * Math.PI) / 2), color: 0xe9e2cf });
  }
  return mergedGrad(parts);
}
// A modern wind turbine, hub 95 m up.
function turbineBody() {
  return mergedGrad([
    { geo: new THREE.CylinderGeometry(1.6, 2.8, 95, 10).translate(0, 47.5, 0), color: 0xe9ecef },
    { geo: new THREE.BoxGeometry(3.4, 3.4, 9).translate(0, 96, 1), color: 0xe9ecef },
  ]);
}
function turbineBlades() {
  const parts = [{ geo: new THREE.SphereGeometry(2, 10, 8).translate(0, 0, 6.5), color: 0xe9ecef }];
  for (let i = 0; i < 3; i++) parts.push({ geo: new THREE.BoxGeometry(2.6, 52, 0.5).translate(0, 27, 6.5).rotateZ((i * 2 * Math.PI) / 3), color: 0xf2f4f6 });
  return mergedGrad(parts);
}

// Much simpler versions of the same trees, for the low graphics level.
function firTreeSimple() {
  const parts = [{ geo: new THREE.CylinderGeometry(0.03, 0.05, 0.3, 5).translate(0, 0.15, 0), color: 0x4a3626 }];
  for (let i = 0; i < 3; i++) parts.push({ geo: new THREE.ConeGeometry(0.3 - i * 0.085, 0.42, 6, 1, true).translate(0, 0.38 + i * 0.25, 0), color: 0x16331f, tip: 0x3f6f3c });
  return mergedGrad(parts);
}
function leafTreeSimple() {
  return mergedGrad([
    { geo: new THREE.CylinderGeometry(0.035, 0.06, 0.45, 5).translate(0, 0.22, 0), color: 0x54402e },
    { geo: new THREE.IcosahedronGeometry(0.33, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), color: 0x2f5a26, tip: 0x86ac4d },
  ]);
}
function leafTree(seed) {
  const r = rng(seed), parts = [{ geo: new THREE.CylinderGeometry(0.035, 0.06, 0.45, 7).translate(0, 0.22, 0), color: 0x54402e }];
  for (let i = 0; i < 6; i++) {
    const a = r() * 6.28, d = r() * 0.18, y = 0.5 + r() * 0.28, rad = 0.19 + r() * 0.12;
    parts.push({ geo: jitter(new THREE.IcosahedronGeometry(rad, 1).translate(Math.cos(a) * d, y, Math.sin(a) * d), 0.05, seed + i * 7), color: 0x2f5a26, tip: 0x86ac4d });
  }
  return mergedGrad(parts);
}
// Tarmac: grain, worn wheel tracks, cracks and slightly worn paint.
function asphaltTextures(anisotropy) {
  const n = 1024, rand = rng(7);
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const k = (y * n + x) * 4, g = 104 + (hash2(x, y) - 0.5) * 34 + (fbm((x / n) * 6, (y / n) * 6) - 0.5) * 34 + (hash2(x >> 1, y >> 1) > 0.93 ? 30 : 0);
    img.data[k] = g * 0.98; img.data[k + 1] = g; img.data[k + 2] = g * 1.04; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (const cx of [0.3, 0.7]) {
    const gr = ctx.createLinearGradient((cx - 0.09) * n, 0, (cx + 0.09) * n, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, n, n);
  }
  ctx.strokeStyle = 'rgba(15,15,18,0.55)'; ctx.lineWidth = 1.4;
  for (let i = 0; i < 9; i++) {
    let x = rand() * n, y = rand() * n;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let j = 0; j < 14; j++) { x += (rand() - 0.5) * 34; y += rand() * 30; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(232,230,220,0.92)';
  ctx.fillRect(n * 0.045, 0, n * 0.022, n); ctx.fillRect(n * 0.933, 0, n * 0.022, n); ctx.fillRect(n * 0.492, 0, n * 0.016, n * 0.42);
  for (let i = 0; i < 2600; i++) { ctx.fillStyle = 'rgba(60,60,64,0.5)'; ctx.fillRect([0.045, 0.933, 0.492][i % 3] * n + rand() * n * 0.022, rand() * n, 2, 2 + rand() * 4); }
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  // bumps
  const m = 512, cn = document.createElement('canvas');
  cn.width = cn.height = m;
  const cx2 = cn.getContext('2d'), im = cx2.createImageData(m, m), H = (x, y) => hash2(x & 511, y & 511) * 0.6 + hash2((x & 511) >> 1, (y & 511) >> 1) * 0.4;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const nx = (H(x - 1, y) - H(x + 1, y)) * 1.6, ny = (H(x, y - 1) - H(x, y + 1)) * 1.6, nl = Math.hypot(nx, ny, 1), k = (y * m + x) * 4;
    im.data[k] = (nx / nl * 0.5 + 0.5) * 255; im.data[k + 1] = (ny / nl * 0.5 + 0.5) * 255; im.data[k + 2] = (1 / nl * 0.5 + 0.5) * 255; im.data[k + 3] = 255;
  }
  cx2.putImageData(im, 0, 0);
  const normal = new THREE.CanvasTexture(cn);
  for (const t of [map, normal]) { t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy; }
  normal.wrapS = THREE.RepeatWrapping;
  return { map, normal };
}

function textTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const CAMERAS = [
  { name: 'Chase', back: 7.5, up: 2.9, ahead: 8, side: 0.4 },
  { name: 'Close', back: 3.6, up: 1.75, ahead: 12, side: 0.9 },
  { name: 'Handlebar', back: -0.5, up: 1.62, ahead: 20, side: 0 },
  { name: 'Side', back: -2, up: 1.6, ahead: 1.5, side: -7 },
  { name: 'Helicopter', back: 38, up: 26, ahead: 14, side: 6 },
];

export class World {
  constructor(canvas, route, imagery = null, look = {}, quality = 'high') {
    this._scenery = []; // batches of trees and rocks, switched off beyond the draw range
    this.route = route;
    this.imagery = imagery; // satellite picture of the area, or null
    const meta = route.meta;
    this.F = meta.forest || [1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3]; // forest: starts, full, thins, gone
    this.B = meta.bare || [1e8, 1e8 + 1]; // open rock: from, to
    this.water = !!meta.water; // sea-level ground is drawn as water
    this.alpine = meta.high !== 'scree';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.88;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xa9c3dc, 0.000075); // haze that thickens with distance
    this.camera = new THREE.PerspectiveCamera(58, 1, 1, 30000);
    this.cameraMode = 0;
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camReady = false;
    this._p = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    this._color = new THREE.Color();

    if (imagery) {
      const t = (this.satTex = new THREE.CanvasTexture(imagery.canvas));
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = 8;
    }
    // shared by the ground shaders: the satellite picture and how strongly to use it
    this.satUniforms = { uSat: { value: this.satTex || null }, uSatRect: { value: new THREE.Vector4(...(imagery ? imagery.rect : [0, 0, 0, 0])) }, uSatMix: { value: imagery ? 0.88 : 0 } };
    this._prepareGrid();
    this._lights();
    this._sky();
    this._coarseTerrain();
    this._corridor();
    this._road();
    this._vegetation();
    this._furniture();
    this._extras();
    this._windFx();
    this._clouds();
    this._grass();

    this.setPlayerLook(look);
    this.setQuality(quality);
    this.bots = [];
    this.resize();
  }

  get cameraName() {
    return CAMERAS[this.cameraMode].name;
  }
  nextCamera() {
    this.cameraMode = (this.cameraMode + 1) % CAMERAS.length;
    this.player.group.visible = CAMERAS[this.cameraMode].name !== 'Handlebar';
    return this.cameraName;
  }

  // The rider you are: { gender, jersey }.
  setPlayerLook(look) {
    if (this.player) {
      this.scene.remove(this.player.group);
      this.player.group.traverse((o) => [].concat(o.material || []).forEach((m) => m.dispose()));
    }
    this.player = createRider(look);
    this._shadows(this.player.group);
    this.player.group.visible = CAMERAS[this.cameraMode].name !== 'Handlebar';
    this.scene.add(this.player.group);
  }

  // everything in a model throws a shadow (name tags excepted)
  _shadows(group) {
    group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }

  addBot(colors) {
    const r = createRider(colors);
    this._shadows(r.group);
    this.scene.add(r.group);
    this.bots.push(r);
    return r;
  }

  // Another real rider, with their name floating above them.
  addRemote(name, colors) {
    const r = createRider(colors);
    this._shadows(r.group);
    const tex = textTexture(256, 64, (ctx, w, h) => {
      ctx.fillStyle = 'rgba(14, 20, 32, 0.78)';
      ctx.beginPath();
      ctx.roundRect(2, 6, w - 4, h - 12, 26);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name.slice(0, 13), w / 2, h / 2 + 2);
    });
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    tag.scale.set(2.3, 0.575, 1);
    tag.position.y = 2.3;
    r.group.add(tag);
    this.scene.add(r.group);
    return r;
  }
  removeRemote(r) {
    this.scene.remove(r.group);
    r.group.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        m.map?.dispose();
        m.dispose();
      }
    });
  }

  setQuality(level) {
    const q = (this.quality = QUALITY[level] || QUALITY.high);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.ratio));
    this.sun.castShadow = q.shadow > 0;
    if (q.shadow && this.sun.shadow.mapSize.x !== q.shadow) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (this.grass) {
      this._g.use = Math.min(this._g.PER, q.grass);
      this._g.held.fill(-1e9); // replant everything at the new density
      this._g.queue.length = 0;
      this.grass.visible = q.grass > 0;
      this.grass.count = this._g.use * this._g.NSEG;
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Free everything, so a world for another route can take over the canvas.
  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        m.map?.dispose();
        m.dispose();
      }
    });
    this.satTex?.dispose();
    this.renderer.dispose();
  }

  // ---------- terrain ----------

  _prepareGrid() {
    const g = this.route.grid;
    const H = new Float32Array(g.h.length);
    let base = Infinity;
    const nd = g.nodata ?? 0, ok = (v) => (nd === 0 ? v > 0 : v > nd); // older files used 0 for "no data"
    for (const v of g.h) if (ok(v) && v < base) base = v;
    if (this.water) base = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        const edge = Math.min(i, g.nx - 1 - i, j, g.ny - 1 - j) * g.dx;
        const h = ok(g.h[k]) ? this.route.scaleEle(g.h[k]) : base;
        H[k] = lerp(base, h, smooth(0, 1500, edge));
      }
    }
    this.gridH = H;
    this.baseLevel = base;
  }

  // Elevation of the raw terrain, interpolated on the same triangles the
  // coarse mesh uses so the two surfaces coincide.
  dem(x, z) {
    const g = this.route.grid;
    let gx = (x - g.x0) / g.dx, gy = (-z - g.y0) / g.dx;
    gx = Math.min(g.nx - 1.0001, Math.max(0, gx));
    gy = Math.min(g.ny - 1.0001, Math.max(0, gy));
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const H = this.gridH, k = j * g.nx + i;
    const h00 = H[k], h10 = H[k + 1], h01 = H[k + g.nx], h11 = H[k + g.nx + 1];
    return fx + fy <= 1
      ? h00 + (h10 - h00) * fx + (h01 - h00) * fy
      : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fy);
  }

  // Ground height anywhere: the DEM, flattened onto the road near the road.
  // Sets this.roadDist to the distance from the road (999 if far away).
  height(x, z) {
    const base = this.dem(x, z);
    const nr = this.route.nearest(x, z);
    if (!nr || nr.d >= 110) {
      this.roadDist = 999;
      return base;
    }
    const d = (this.roadDist = nr.d);
    const w = smooth(4.5, 60, d);
    let h = lerp(nr.ele - 0.05, base, w);
    h += (fbm(x / 23, z / 23) - 0.5) * 7 * smooth(8, 45, d) * (1 - smooth(70, 100, d));
    return h;
  }

  terrainColor(x, z, h, d, out) {
    const n1 = vnoise(x / 420, z / 420), n2 = vnoise(x / 130 + 50, z / 130 + 80);
    const hj = h + (n2 - 0.5) * 120;
    const F = this.F, B = this.B, al = this.alpine;
    const forest = smooth(F[0], F[1] + 10, hj) * (1 - smooth(F[2], F[3] + 10, hj)), scree = smooth(B[0], B[1] + 20, hj);
    out.copy(al ? COL.meadowA : COL.fieldA).lerp(al ? COL.meadowB : COL.fieldB, smooth(0.35, 0.45, n1)).lerp(al ? COL.meadowC : COL.fieldC, smooth(0.6, 0.7, n1));
    out.lerp(this._c2.copy(COL.forestA).lerp(COL.forestB, n2), forest);
    out.lerp(this._c2.copy(al ? COL.alpineA : COL.screeA).lerp(al ? COL.alpineB : COL.screeB, n2), scree);
    if (al) out.lerp(COL.snow, smooth(2450, 2750, hj) * 0.75);
    if (this.water && h < 0.6 && d > 14) out.setRGB(0.2, 0.42, 0.56).multiplyScalar(0.9 + n2 * 0.2);
    if (d < 95) {
      const fade = 1 - smooth(60, 95, d);
      out.multiplyScalar(1 + (vnoise(x / 5, z / 5) - 0.5) * 0.22 * fade);
      out.lerp(this._c2.copy(COL.vergeLow).lerp(COL.vergeHigh, scree), (1 - smooth(3.5, 9, d)) * 0.85);
    }
    return out;
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xc8ddff, 0x80765a, 2.9));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0d8, SUN));
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.64).normalize();
    sun.position.copy(this.sunDir);
    // real shadows in a box that travels with the rider
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -55; sc.right = sc.top = 55; sc.near = 1; sc.far = 420;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 1.5;
    this.scene.add(sun, sun.target);
  }

  _sky() {
    const hz = new THREE.Vector3(((HORIZON >> 16) & 255) / 255, ((HORIZON >> 8) & 255) / 255, (HORIZON & 255) / 255);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Vector3(0.2, 0.46, 0.84) }, horizon: { value: hz }, sunDir: { value: this.sunDir }, sun: { value: 1 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float sun; varying vec3 vDir;
        void main(){ vec3 d = normalize(vDir); float h = max(d.y, 0.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(d, sunDir), 0.0);
          c += vec3(1.0, 0.93, 0.78) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18) * sun;
          gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 24, 12), mat);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const plain = new THREE.Mesh(new THREE.CircleGeometry(28000, 48), new THREE.MeshLambertMaterial({ color: 0x8a9760 }));
    plain.rotation.x = -Math.PI / 2;
    plain.position.y = this.baseLevel - 2;
    this.scene.add(plain);
    this.plain = plain;
  }

  _coarseTerrain() {
    const g = this.route.grid, route = this.route;
    this._c2 = new THREE.Color();
    const n = g.nx * g.ny;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const c = this._color;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        const x = g.x0 + i * g.dx, z = -(g.y0 + j * g.dx), h = this.gridH[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        this.terrainColor(x, z, h, 999, c);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    }
    const idx = new Uint32Array((g.nx - 1) * (g.ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < g.ny - 1; j++) {
      for (let i = 0; i < g.nx - 1; i++) {
        const a = j * g.nx + i, b = a + 1, cc = a + g.nx, d = cc + 1;
        idx[q++] = a; idx[q++] = b; idx[q++] = cc;
        idx[q++] = b; idx[q++] = d; idx[q++] = cc;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // Mask: cut the coarse mesh away where the detailed road corridor takes over.
    const W = (g.nx - 1) * g.dx, Hh = (g.ny - 1) * g.dx, px = 8;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(W / px); cv.height = Math.ceil(Hh / px);
    const zMin = -(g.y0 + Hh);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 200 / px;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < route.n; i++) ctx.lineTo((route.X[i] - g.x0) / px, (route.Z[i] - zMin) / px);
    ctx.stroke();
    const mask = new THREE.CanvasTexture(cv);
    mask.flipY = false;
    mask.generateMipmaps = false;
    mask.minFilter = mask.magFilter = THREE.LinearFilter;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
    mat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.satUniforms);
      s.uniforms.uMask = { value: mask };
      s.uniforms.uMaskRect = { value: new THREE.Vector4(g.x0, zMin, 1 / (cv.width * px), 1 / (cv.height * px)) };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWxz = position.xz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uMask; uniform vec4 uMaskRect; varying vec2 vWxz;\nuniform sampler2D uSat; uniform vec4 uSatRect; uniform float uSatMix;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uSatMix > 0.0) { vec3 sat = texture2D(uSat, (vWxz - uSatRect.xy) * uSatRect.zw).rgb; diffuseColor.rgb = mix(diffuseColor.rgb, sat * 1.85 + 0.02, uSatMix); }`)
        .replace('#include <clipping_planes_fragment>', 'if (texture2D(uMask, (vWxz - uMaskRect.xy) * uMaskRect.zw).r > 0.5) discard;\n#include <clipping_planes_fragment>');
    };
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _corridor() {
    const route = this.route, P = this._p, c = this._color;
    const half = [4.2, 7, 12, 20, 32, 50, 75, 110];
    const OFF = [...half.map((v) => -v).reverse(), ...half];
    const cols = OFF.length + 2; // plus a skirt each side
    const STEP = 5; // same rows as the road surface, so the two cannot cross on steep bends
    const rows = Math.floor((route.total + 220) / STEP) + 2;
    // is the nearest bit of road to this point the bit we are building the strip for?
    const mine = (x, z, along, reach) => {
      const nr = route.nearest(x, z);
      return !nr || Math.abs(nr.dist - along) <= 4 + reach * 0.15;
    };
    const pos = new Float32Array(rows * cols * 3), nor = new Float32Array(rows * cols * 3), col = new Float32Array(rows * cols * 3);
    const sat = new Float32Array(rows * cols); // 0 on the verge (keep our gravel), 1 away from the road
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const s = Math.min(-110 + r * STEP, route.total + 110);
      route.at(s, P);
      const lx = P.tz, lz = -P.tx, sc = Math.min(route.total, Math.max(0, s));
      for (let ci = 0; ci < cols; ci++) {
        const skirt = ci === 0 || ci === cols - 1;
        // On hairpins the strips of two legs of road would overlap and bury
        // each other's tarmac, so each strip stops halfway to the other leg.
        let o = OFF[Math.min(OFF.length - 1, Math.max(0, ci - 1))], clamped = false;
        const reach = Math.abs(o), sgn = Math.sign(o);
        if (!mine(P.x + lx * o, P.z + lz * o, sc, reach)) {
          let lo = 0.5, hi = reach;
          for (let it = 0; it < 9; it++) {
            const mid = (lo + hi) / 2;
            if (mine(P.x + lx * sgn * mid, P.z + lz * sgn * mid, sc, mid)) lo = mid;
            else hi = mid;
          }
          o = sgn * lo;
          clamped = true;
        }
        const x = P.x + lx * o, z = P.z + lz * o;
        const h = this.height(x, z), d = this.roadDist;
        const hx = this.height(x + 1.5, z) - this.height(x - 1.5, z);
        const hz = this.height(x, z + 1.5) - this.height(x, z - 1.5);
        const nl = Math.hypot(hx / 3, 1, hz / 3);
        // under the tarmac the ground sits a little lower; the road's own shoulders hide the step
        const under = Math.abs(o) <= 4.2 ? 0.3 : 0;
        // the skirt hides gaps at the outer edge; where two strips meet it only needs to be shallow
        pos[k] = x; pos[k + 1] = skirt ? h - (clamped ? 1.5 : 45) : h - under; pos[k + 2] = z;
        nor[k] = -hx / 3 / nl; nor[k + 1] = 1 / nl; nor[k + 2] = -hz / 3 / nl;
        this.terrainColor(x, z, h, d, c);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
        sat[k / 3] = smooth(5, 16, d);
        k += 3;
      }
    }
    const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
    let q = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let ci = 0; ci < cols - 1; ci++) {
        const a = r * cols + ci, b = a + 1, cc = a + cols, d = cc + 1;
        idx[q++] = a; idx[q++] = cc; idx[q++] = b;
        idx[q++] = b; idx[q++] = cc; idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSat', new THREE.BufferAttribute(sat, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    // Mottle the ground so grass and scree are not one flat colour up close.
    const ground = new THREE.MeshLambertMaterial({ vertexColors: true });
    ground.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.satUniforms);
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGround; attribute float aSat; varying float vSat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = position; vSat = aSat;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGround; varying float vSat;
          uniform sampler2D uSat; uniform vec4 uSatRect; uniform float uSatMix;
          float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uSatMix > 0.0) { vec3 sat = texture2D(uSat, (vGround.xz - uSatRect.xy) * uSatRect.zw).rgb; diffuseColor.rgb = mix(diffuseColor.rgb, sat * 1.85 + 0.02, uSatMix * vSat); }
          float gFine = gNoise(vGround.xz * 1.7) * 0.6 + gNoise(vGround.xz * 6.0) * 0.4;
          float gBroad = gNoise(vGround.xz * 0.11);
          float gFade = 1.0 - smoothstep(60.0, 220.0, length(vGround - cameraPosition));
          diffuseColor.rgb *= 1.0 + ((gFine - 0.5) * 0.34 * gFade + (gBroad - 0.5) * 0.16);`);
    };
    this._chunked(geo, rows - 1, (cols - 1) * 6, ground, 120);
  }

  // Split a strip mesh into draw groups along the road so off-screen parts are culled.
  _chunked(geo, rowCount, indicesPerRow, material, rowsPerChunk = 60, kind = 'ground') {
    const pos = geo.attributes.position, index = geo.index;
    for (let r = 0; r < rowCount; r += rowsPerChunk) {
      const start = r * indicesPerRow, count = Math.min(rowsPerChunk, rowCount - r) * indicesPerRow;
      const g = new THREE.BufferGeometry();
      for (const name in geo.attributes) g.setAttribute(name, geo.attributes[name]);
      g.setIndex(index);
      g.setDrawRange(start, count);
      const box = new THREE.Box3(), v = new THREE.Vector3();
      for (let i = start; i < start + count; i++) box.expandByPoint(v.fromBufferAttribute(pos, index.getX(i)));
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, material);
      mesh.userData.kind = kind;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  _road() {
    const route = this.route, P = this._p;
    // four vertices a row: shoulder, edge, edge, shoulder. The shoulders slope
    // down to the ground so the tarmac never floats.
    const STEP = 5, HALF = 3.2, SHOULDER = 4.3, DROP = 0.42;
    const rows = Math.ceil(route.total / STEP) + 1;
    const pos = new Float32Array(rows * 12), uv = new Float32Array(rows * 8), nor = new Float32Array(rows * 12);
    for (let r = 0; r < rows; r++) {
      const s = Math.min(r * STEP, route.total);
      route.at(s, P);
      const lx = P.tz, lz = -P.tx, y = P.y + 0.04;
      pos.set([
        P.x - lx * SHOULDER, y - DROP, P.z - lz * SHOULDER, P.x - lx * HALF, y, P.z - lz * HALF,
        P.x + lx * HALF, y, P.z + lz * HALF, P.x + lx * SHOULDER, y - DROP, P.z + lz * SHOULDER,
      ], r * 12);
      nor.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], r * 12);
      uv.set([-0.04, s / 9, 0, s / 9, 1, s / 9, 1.04, s / 9], r * 8);
    }
    const idx = new Uint32Array((rows - 1) * 18);
    for (let r = 0, q = 0; r < rows - 1; r++) {
      for (let c = 0; c < 3; c++) {
        const a = r * 4 + c, b = a + 1, cc = a + 4, d = a + 5;
        idx[q++] = a; idx[q++] = cc; idx[q++] = b;
        idx[q++] = b; idx[q++] = cc; idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const { map, normal } = asphaltTextures(this.renderer.capabilities.getMaxAnisotropy());
    const mat = new THREE.MeshStandardMaterial({ map, normalMap: normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.84, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this._chunked(geo, rows - 1, 18, mat, 120, 'road');
  }

  // ---------- scenery ----------

  _vegetation() {
    const route = this.route, P = this._p, rand = rng(1909), F = this.F, B = this.B, provence = route.meta.lowland === 'provence', img = this.imagery;
    const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 7).translate(0, y, 0);
    const pine = firTree(1), leafy = leafTree(60);
    const house = houseModel(route.meta.houses === 'brick'), cow = cowModel();
    const treeMix = route.meta.trees, wantCows = (route.meta.extras || []).includes('cows');
    const simple = new Map([[pine, firTreeSimple()], [leafy, leafTreeSimple()]]);
    const mid = new Map([[pine, firTree(1, 5, 7, 1)]]);
    const cypress = merged([
      { geo: new THREE.CylinderGeometry(0.02, 0.025, 0.12, 5).translate(0, 0.06, 0), color: 0x4f3f30 },
      { geo: cone(0.095, 0.92, 0.54), color: 0x2a4a30 },
    ]);
    const rock = merged([{ geo: new THREE.IcosahedronGeometry(1, 0), color: 0xd9d5ca }]);
    const flat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

    const CHUNK = 500, m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const v = new THREE.Vector3(), sc = new THREE.Vector3(), tint = new THREE.Color();
    const flush = (geo, items) => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(geo, flat, items.length);
      items.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        mesh.setColorAt(i, it.c);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.userData.full = geo;
      mesh.userData.simple = simple.get(geo) || geo;
      mesh.userData.mid = mid.get(geo) || geo;
      this._scenery.push(mesh);
      this.scene.add(mesh);
    };

    for (let c0 = 0; c0 < route.total; c0 += CHUNK) {
      const pines = [], leafies = [], rocks = [], cypresses = [], houses = [], cows = [];
      for (let s = c0; s < Math.min(c0 + CHUNK, route.total); s += 10) {
        route.at(s, P);
        const lx = P.tz, lz = -P.tx, px = P.x, pz = P.z;
        for (let t = 0; t < 13; t++) {
          const side = rand() < 0.5 ? -1 : 1;
          const o = side * (6.5 + Math.pow(rand(), 1.5) * 96);
          const x = px + lx * o, z = pz + lz * o;
          const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
          const h = this.height(x, z);
          if (this.roadDist < 6 || this.water) continue; // no trees on a sea dike
          const rd = this.roadDist;
          // villages: houses where the satellite picture looks built-up and the ground is fairly level
          if (img && rd > 11 && h < B[0] && img.urban(x, z) > 0.4) {
            if (r1 < 0.22 && Math.abs(this.height(x + 5, z) - this.height(x - 5, z)) < 2.6) {
              const size = 8 + r3 * 5;
              e.set(0, Math.atan2(P.tx, P.tz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2) + (r4 - 0.5) * 0.5, 0);
              m.compose(v.set(x, h - 0.3, z), q.setFromEuler(e), sc.set(size, size * (0.9 + r2 * 0.5), size));
              tint.setScalar(0.82 + r4 * 0.3);
              houses.push({ m: m.clone(), c: tint.clone() });
            }
            continue; // no forest in the middle of a village
          }
          // real forest from the satellite picture when we have it, else by altitude
          const forest = img ? img.forest(x, z) * (1 - smooth(B[0] - 60, B[0] + 60, h)) : smooth(F[0], F[1], h) * (1 - smooth(F[2], F[3], h));
          const scree = smooth(B[0], B[1], h);
          if ((img ? forest < 0.3 && scree < 0.5 : h < Math.min(F[1] + 10, B[0]) && forest < 0.3) && r1 < (provence ? 0.3 : 0.14) * (img ? 0.35 + forest * 2 : 1)) {
            // lowlands: scattered trees (cypresses too in Provence)
            const tall = provence && r2 < 0.4, size = tall ? 8 + r3 * 6 : 5 + r3 * 4;
            e.set(0, r4 * 6.28, 0);
            m.compose(v.set(x, h - 0.2, z), q.setFromEuler(e), sc.set(size, size, size));
            tint.setScalar(0.8 + r4 * 0.35);
            (tall ? cypresses : leafies).push({ m: m.clone(), c: tint.clone() });
          } else if (r1 < forest * 0.85) {
            const broad = r2 < (treeMix === 'broadleaf' ? 0.93 : treeMix === 'mixed' ? 0.5 : h < (img ? 900 : F[1] + 360) ? 0.55 : 0.18);
            const size = (broad ? 6 + r3 * 5 : 7 + r3 * 8) * (1 - 0.45 * smooth(F[2] - 90, F[3], h));
            e.set(0, r4 * 6.28, 0);
            m.compose(v.set(x, h - 0.2, z), q.setFromEuler(e), sc.set(size * (0.8 + r2 * 0.5), size, size * (0.8 + r2 * 0.5)));
            tint.setScalar(0.78 + r4 * 0.4);
            (broad ? leafies : pines).push({ m: m.clone(), c: tint.clone() });
          } else if (wantCows && t >= 5 && t <= 7 && r2 < 0.1 && rd > 14 && forest < 0.25) {
            // a few cows in the meadows
            e.set(0, r4 * 6.28, 0);
            m.compose(v.set(x, h, z), q.setFromEuler(e), sc.setScalar(0.95 + r3 * 0.25));
            tint.setScalar(0.92 + r4 * 0.12);
            cows.push({ m: m.clone(), c: tint.clone() });
          } else if (t < 4 && r1 > 1 - scree * 0.5) {
            const size = 0.25 + r3 * r3 * 1.6;
            e.set(r2 * 3, r4 * 6.28, r3 * 3);
            m.compose(v.set(x, h, z), q.setFromEuler(e), sc.set(size, size * 0.6, size * 1.2));
            tint.setScalar(0.8 + r4 * 0.3);
            rocks.push({ m: m.clone(), c: tint.clone() });
          }
        }
      }
      flush(pine, pines);
      flush(leafy, leafies);
      flush(rock, rocks);
      flush(cypress, cypresses);
      flush(house, houses);
      flush(cow, cows);
    }
  }

  _furniture() {
    const route = this.route, P = this._p;
    const lam = (color) => new THREE.MeshLambertMaterial({ color });
    const place = (obj, dist, lateral, yaw = 0) => {
      route.at(dist, P);
      const x = P.x + P.tz * lateral, z = P.z - P.tx * lateral;
      obj.position.set(x, Math.abs(lateral) < 4.5 ? P.y : this.height(x, z), z);
      obj.rotation.y = Math.atan2(P.tx, P.tz) + yaw;
      this.scene.add(obj);
      return obj;
    };

    // Snow poles on the bare upper slopes
    const meta = route.meta, sign = meta.sign, isVentoux = meta.id === 'ventoux';
    let chalet = route.total;
    for (let d = 0; d < route.total; d += 50) if (route.ele(d) >= this.B[0]) { chalet = d; break; }
    const poleGeo = merged([
      { geo: new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6).translate(0, 1.1, 0), color: 0xf2c21a },
      { geo: new THREE.CylinderGeometry(0.052, 0.052, 0.5, 6).translate(0, 2.45, 0), color: 0x1a1a1a },
    ]);
    const poleCount = Math.max(0, Math.floor((route.total - chalet - 30) / 25));
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), poleCount);
    const m = new THREE.Matrix4();
    for (let i = 0; i < poleCount; i++) {
      route.at(chalet + 20 + i * 25, P);
      const o = i % 2 ? 4.1 : -4.1;
      m.makeTranslation(P.x + P.tz * o, P.y - 0.05, P.z - P.tx * o);
      poles.setMatrixAt(i, m);
    }
    poles.frustumCulled = false;
    this.scene.add(poles);

    // Kilometre stones, in the style of the roadside bornes
    const postGeo = new THREE.BoxGeometry(0.12, 1.2, 0.12).translate(0, 0.6, 0);
    const boardGeo = new THREE.PlaneGeometry(1.7, 1.15).translate(0, 1.75, 0.07);
    const backGeo = new THREE.BoxGeometry(1.76, 1.21, 0.06).translate(0, 1.75, 0.03);
    const mPost = lam(0xdddddd);
    for (let km = 1; km * 1000 < route.total - 300; km++) {
      const d = km * 1000;
      const left = (route.total - d) / 1000;
      const next = route.grade(d + 500, 1000);
      const tex = textTexture(256, 176, (ctx, w, h) => {
        ctx.fillStyle = '#f6f4ec';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#f2c21a';
        ctx.fillRect(0, 0, w, 50);
        ctx.fillStyle = '#1a1a1a';
        ctx.textAlign = 'center';
        ctx.font = '700 27px system-ui, sans-serif';
        ctx.font = `700 ${meta.name.length > 14 ? 21 : 27}px system-ui, sans-serif`;
        ctx.fillText(meta.name.toUpperCase(), w / 2, 35);
        ctx.font = '700 32px system-ui, sans-serif';
        ctx.fillText(`${sign.top} ${left.toFixed(1)} km`, w / 2, 90);
        ctx.font = '500 24px system-ui, sans-serif';
        ctx.fillText(`${sign.alt} ${Math.round(route.ele(d))} m`, w / 2, 126);
        ctx.fillText(`${sign.grade} ${next.toFixed(1)} %`, w / 2, 158);
      });
      const g = new THREE.Group();
      g.add(new THREE.Mesh(postGeo, mPost), new THREE.Mesh(backGeo, mPost), new THREE.Mesh(boardGeo, new THREE.MeshBasicMaterial({ map: tex })));
      place(g, d, -4.9, Math.PI);
    }

    // Start and finish arches
    const arch = (dist, text, color) => {
      const g = new THREE.Group();
      const post = new THREE.CylinderGeometry(0.22, 0.22, 5.6, 10).translate(0, 2.8, 0);
      const mat = lam(color);
      for (const x of [-4.2, 4.2]) {
        const p = new THREE.Mesh(post, mat);
        p.position.x = x;
        g.add(p);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(8.9, 1.3, 0.3), mat);
      beam.position.y = 5.5;
      g.add(beam);
      const tex = textTexture(1024, 150, (ctx, w, h) => {
        ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '800 92px system-ui, sans-serif';
        ctx.fillText(text, w / 2, h / 2 + 6);
      });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 1.2), new THREE.MeshBasicMaterial({ map: tex }));
      banner.position.set(0, 5.5, -0.16);
      banner.rotation.y = Math.PI;
      g.add(banner);
      place(g, dist, 0);
    };
    const fit = (t) => (t.length > 24 ? t.slice(0, 24) : t);
    arch(30, fit(`${sign.start}  ·  ${meta.start.toUpperCase()}`), 0x2b6fd6);
    arch(route.total - 6, fit(route.climb ? `${sign.top.toUpperCase()}  ·  ${meta.topEle} m` : `${sign.top.toUpperCase()}  ·  ${meta.top.toUpperCase()}`), 0xd63a2b);

    // Numbered hairpin signs, counting down to the top
    (route.climb ? route.hairpins : []).forEach((d, i) => {
      const num = route.hairpins.length - i;
      const tex = textTexture(256, 176, (ctx, w, h) => {
        ctx.fillStyle = '#1d4f9c';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = '600 26px system-ui, sans-serif';
        ctx.fillText(meta.hairpinWord || 'Virage', w / 2, 38);
        ctx.font = '800 78px system-ui, sans-serif';
        ctx.fillText(String(num), w / 2, 112);
        ctx.font = '500 24px system-ui, sans-serif';
        ctx.fillText(`${Math.round(route.ele(d))} m`, w / 2, 156);
      });
      const g = new THREE.Group();
      g.add(new THREE.Mesh(postGeo, mPost), new THREE.Mesh(backGeo, mPost), new THREE.Mesh(boardGeo, new THREE.MeshBasicMaterial({ map: tex })));
      place(g, Math.max(0, d - 35), 4.9, Math.PI);
    });
    if (!isVentoux) return;

    // Summit observatory with its red-and-white mast
    const tower = new THREE.Group();
    const white = lam(0xf1efe8), red = lam(0xc93a2e);
    const body = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 11), white);
    body.position.y = 4.5;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 30, 14), white);
    shaft.position.y = 15;
    tower.add(body, shaft);
    for (const [y, h, r] of [[24, 4, 3.1], [31.5, 3, 2.9]]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), red);
      band.position.y = y;
      tower.add(band);
    }
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 4, 8), i % 2 ? white : red);
      seg.position.y = 35 + i * 4;
      tower.add(seg);
    }
    place(tower, route.total + 16, 22);

    // Chalet Reynard
    const hut = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(18, 5, 9), lam(0xe6d9bf));
    walls.position.y = 2.5;
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 6.6, 3.2, 4, 1).rotateY(Math.PI / 4).scale(1.95, 1, 1), lam(0x8a4b32));
    roof.position.y = 6.6;
    hut.add(walls, roof);
    place(hut, chalet + 30, 15);

    // Tom Simpson memorial
    const stele = new THREE.Group();
    const stone = lam(0xa9a59b);
    for (let i = 0; i < 3; i++) {
      const stepMesh = new THREE.Mesh(new THREE.BoxGeometry(3.4 - i * 0.7, 0.3, 2.4 - i * 0.5), stone);
      stepMesh.position.y = 0.15 + i * 0.3;
      stele.add(stepMesh);
    }
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.9, 0.35), lam(0x6f6c66));
    slab.position.y = 1.85;
    stele.add(slab);
    place(stele, route.landmarks[3].dist, -8.5, Math.PI);
  }

  // Overcast skies: greyer, with a weaker sun. cloud = 0 (clear) .. 1 (overcast).
  setSky(cloud) {
    const c = Math.min(1, Math.max(0, cloud)) * 0.9;
    this.sky.material.uniforms.top.value.set(lerp(0.2, 0.6, c), lerp(0.46, 0.64, c), lerp(0.84, 0.7, c));
    this.sky.material.uniforms.sun.value = 1 - c;
    this.sun.intensity = SUN * (1 - 0.6 * c);
    if (this.clouds) this.clouds.material.uniforms.uCover.value = cloud;
    if (this.sea) this.sea.material.uniforms.uCloud.value = Math.min(1, cloud);
  }

  // Things that belong to particular landscapes: windmills in the polder, wind
  // turbines and open sea beside the Afsluitdijk.
  _extras() {
    const route = this.route, P = this._p, extras = route.meta.extras || [], rand = rng(271);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this._spinners = [];
    const stand = (body, rotor, dist, lateral, hubY, hubZ, speed) => {
      route.at(dist, P);
      const x = P.x + P.tz * lateral, z = P.z - P.tx * lateral, g = new THREE.Group();
      g.position.set(x, Math.max(this.height(x, z), this.water ? 0 : -1e9) - 0.3, z);
      g.rotation.y = rand() * 6.28;
      const b = new THREE.Mesh(body, mat), r = new THREE.Mesh(rotor, mat);
      r.position.set(0, hubY, hubZ);
      r.rotation.z = rand() * 6.28;
      b.castShadow = r.castShadow = true;
      g.add(b, r);
      this.scene.add(g);
      this._spinners.push({ rotor: r, speed });
    };
    if (extras.includes('windmills')) {
      const body = windmillBody(), sails = windmillSails();
      for (let d = 900; d < route.total - 400; d += 1500 + rand() * 1200) stand(body, sails, d, (rand() < 0.5 ? -1 : 1) * (26 + rand() * 40), 12.4, 2.2, 1);
    }
    if (extras.includes('turbines')) {
      const body = turbineBody(), blades = turbineBlades();
      for (let d = route.total * 0.34; d < route.total * 0.74; d += 620) for (const row of [1, 2]) stand(body, blades, d + row * 210, -(520 + row * 560 + rand() * 120), 96, 0, 0.55);
    }
    if (extras.includes('sea')) {
      // open water with moving ripples and the sun glinting on it
      const sea = new THREE.ShaderMaterial({
        uniforms: { uTime: (this._seaTime = { value: 0 }), uSun: { value: this.sunDir }, uCloud: { value: 0 } },
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: `varying vec3 vW; uniform float uTime; uniform vec3 uSun; uniform float uCloud;
          float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
          void main(){
            vec3 v = normalize(cameraPosition - vW); float dist = length(cameraPosition - vW);
            vec2 p = vW.xz; float fade = 1.0 / (1.0 + dist * 0.004);
            float w1 = n(p * 0.35 + vec2(uTime * 0.6, uTime * 0.25)), w2 = n(p * 0.9 - vec2(uTime * 0.5, 0.0)), w3 = n(p * 0.05 + uTime * 0.05);
            vec3 nrm = normalize(vec3((w1 - 0.5) * 0.5 * fade + (w2 - 0.5) * 0.3 * fade, 1.0, (w2 - 0.5) * 0.5 * fade + (w3 - 0.5) * 0.2));
            float fres = pow(1.0 - max(dot(nrm, v), 0.0), 4.0);
            vec3 deep = mix(vec3(0.07, 0.2, 0.3), vec3(0.14, 0.2, 0.24), uCloud), skyc = mix(vec3(0.55, 0.72, 0.9), vec3(0.62, 0.66, 0.7), uCloud);
            vec3 c = mix(deep, skyc, clamp(fres + 0.06, 0.0, 1.0)) * (0.92 + w3 * 0.16);
            c += vec3(1.0, 0.93, 0.8) * pow(max(dot(reflect(-uSun, nrm), v), 0.0), 220.0) * 1.6 * (1.0 - uCloud);
            c = mix(c, vec3(0.66, 0.76, 0.86), 1.0 - exp(-dist * 0.000075));
            gl_FragColor = vec4(c, 1.0); }`,
      });
      this.sea = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), sea);
      this.sea.position.y = 0.35;
      this.scene.add(this.sea);
    }
  }

  // A drifting cloud layer; how much of the sky it fills follows the weather.
  _clouds() {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { uTime: (this._time = { value: 0 }), uCover: { value: 0.2 } },
      vertexShader: 'varying vec2 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec2 vP; uniform float uTime; uniform float uCover;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += n(p) * a; p *= 2.02; a *= 0.5; } return s; }
        void main(){ vec2 p = vP / 2600.0 + vec2(uTime * 0.004, 0.0); float d = fbm(p) + fbm(p * 2.7) * 0.35;
          float lo = mix(0.95, 0.42, uCover); float a = smoothstep(lo, lo + 0.3, d);
          vec3 c = mix(vec3(0.74, 0.78, 0.86), vec3(1.0), smoothstep(lo, lo + 0.45, d)) * mix(1.0, 0.72, uCover);
          gl_FragColor = vec4(c, a * 0.92); }`,
    });
    const geo = new THREE.CircleGeometry(17000, 40).rotateX(-Math.PI / 2);
    this.clouds = new THREE.Mesh(geo, mat);
    this.clouds.renderOrder = 2;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);
  }

  // Grass: blades that sway, kept only around the rider. The road is cut into
  // 30 m pieces; each piece owns a fixed share of the blades and gets replanted
  // when the rider has moved on.
  _grass() {
    const off = new URLSearchParams(location.search).get('grass') === '0';
    const SEG = 30, NSEG = 12, PER = off ? 0 : 8500;
    this._g = { SEG, NSEG, PER, use: PER, held: new Int32Array(NSEG).fill(-1e9), queue: [] };
    if (!PER) return;
    const blade = new THREE.PlaneGeometry(0.055, 1, 1, 3).translate(0, 0.5, 0), pa = blade.attributes.position, bc = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) {
      const t = pa.getY(i);
      pa.setX(i, pa.getX(i) * (1 - t * 0.85));
      pa.setZ(i, t * t * 0.22);
      bc.set([lerp(0.55, 1.25, t), lerp(0.6, 1.3, t), lerp(0.5, 1.0, t)], i * 3);
    }
    blade.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    blade.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this._time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 gp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sway = sin(uTime * 1.7 + gp.x * 0.35 + gp.z * 0.27) * 0.5 + sin(uTime * 3.1 + gp.x * 0.9) * 0.2;
          transformed.x += sway * 0.16 * position.y * position.y; transformed.z += sway * 0.07 * position.y * position.y;`);
    };
    const mesh = (this.grass = new THREE.InstancedMesh(blade, mat, NSEG * PER));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this._color.setRGB(0.3, 0.45, 0.2));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < NSEG * PER; i++) mesh.setMatrixAt(i, zero);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  _plantGrass(slot, seg) {
    const { SEG, NSEG, PER, use } = this._g, route = this.route, P = this._gp || (this._gp = {}), img = this.imagery, B = this.B;
    const rand = rng(seg * 7919 + 13), mesh = this.grass;
    const m = this._gm || (this._gm = new THREE.Matrix4()), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), v = new THREE.Vector3(), c = this._color;
    for (let i = 0; i < use; i++) {
      const k = i * NSEG + slot, s = (seg + rand()) * SEG, side = rand() < 0.5 ? -1 : 1, off = 4.5 + Math.pow(rand(), 2.3) * 46;
      const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
      let show = i < use && s > -40 && s < route.total + 40, tall = 0.14 + r1 * 0.26, x = 0, z = 0, h = 0;
      if (show) {
        route.at(s, P);
        x = P.x + P.tz * side * off; z = P.z - P.tx * side * off;
        h = this.height(x, z);
        if (this.roadDist < 4.45 || (this.water && h < 0.7)) show = false;
      }
      if (show) {
        const patch = vnoise(x / 6, z / 6);
        tall += patch * 0.3;
        if (patch < 0.3 && off > 7) show = false; // clumps, with bare patches between
        if (img) {
          const [cr, cg, cb] = img.sample(x, z), mx = Math.max(cr, cg, cb), mn = Math.min(cr, cg, cb);
          if ((cr + cg + cb) / 3 > 150 || (mx > 120 && (mx - mn) / mx < 0.16)) show = false; // bare rock, scree, buildings
          if (smooth(B[0], B[1], h) > 0.5 && r2 < 0.8) show = false; // only tufts above the tree line
          // blades take the colour of the ground they stand on
          c.setRGB((cr / 255) * 2.3 + 0.04, (cg / 255) * 2.5 + 0.07, (cb / 255) * 1.9 + 0.02);
        } else {
          if (smooth(B[0], B[1], h) > 0.6) show = false;
          c.setRGB(0.3 + r2 * 0.12, 0.44 + r2 * 0.14, 0.2);
        }
      }
      if (!show) m.makeScale(0, 0, 0);
      else {
        e.set((r3 - 0.5) * 0.5, r4 * 6.28, (r2 - 0.5) * 0.5);
        m.compose(v.set(x, h - 0.03, z), q.setFromEuler(e), sc.set(0.8 + r3 * 0.9, tall, 1));
        mesh.setColorAt(k, c);
      }
      mesh.setMatrixAt(k, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  _updateGrass(dist) {
    const g = this._g;
    if (!g.PER || !g.use) return;
    const cur = Math.floor(dist / g.SEG);
    for (let seg = cur - 1; seg < cur - 1 + g.NSEG; seg++) {
      const slot = ((seg % g.NSEG) + g.NSEG) % g.NSEG;
      if (g.held[slot] !== seg && !g.queue.some((j) => j.seg === seg)) {
        g.held[slot] = seg;
        g.queue.push({ slot, seg });
      }
    }
    // plant the nearest piece first, one a frame, so there is never a hitch
    g.queue.sort((a, b) => Math.abs(a.seg - cur) - Math.abs(b.seg - cur));
    const job = g.queue.shift();
    if (job && g.held[job.slot] === job.seg) this._plantGrass(job.slot, job.seg);
  }

  // Streaks of dust carried by the wind, in a box that travels with the camera.
  _windFx() {
    const N = (this._wfN = 240);
    const rand = rng(77);
    this._wf = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this._wf[i * 3] = (rand() - 0.5) * 70;
      this._wf[i * 3 + 1] = rand() * 14 - 2;
      this._wf[i * 3 + 2] = (rand() - 0.5) * 70;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.windFx = new THREE.LineSegments(geo, mat);
    this.windFx.frustumCulled = false;
    this.scene.add(this.windFx);
    this._wfCam = new THREE.Vector3();
  }

  _updateWindFx(dt, wind) {
    const fx = this.windFx, speed = wind ? wind.speed : 0;
    const target = Math.min(0.55, Math.max(0, (speed - 2) / 14));
    fx.material.opacity += (target - fx.material.opacity) * Math.min(1, dt * 1.5);
    fx.visible = fx.material.opacity > 0.01;
    // keep the box centred on the camera without dragging the dust along
    const dx = this._camPos.x - this._wfCam.x, dy = this._camPos.y - this._wfCam.y, dz = this._camPos.z - this._wfCam.z;
    this._wfCam.copy(this._camPos);
    fx.position.copy(this._camPos);
    if (!fx.visible) return;
    const p = this._wf, out = fx.geometry.attributes.position.array;
    const wx = wind.wx, wz = wind.wz, len = 0.07;
    const wrap = (v, half) => ((((v + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
    for (let i = 0; i < this._wfN; i++) {
      const j = i * 3, o = i * 6;
      p[j] = wrap(p[j] + wx * dt - dx, 35);
      p[j + 1] = wrap(p[j + 1] - 5 - dy + Math.sin(i * 12.9 + p[j] * 0.15) * dt * 0.8, 7) + 5;
      p[j + 2] = wrap(p[j + 2] + wz * dt - dz, 35);
      out[o] = p[j]; out[o + 1] = p[j + 1]; out[o + 2] = p[j + 2];
      out[o + 3] = p[j] - wx * len; out[o + 4] = p[j + 1]; out[o + 5] = p[j + 2] - wz * len;
    }
    fx.geometry.attributes.position.needsUpdate = true;
  }

  // ---------- per-frame ----------

  placeRider(rider, dist, lateral, crank, visible = true) {
    const P = this.route.at(Math.min(dist, this.route.total), this._p);
    const g = rider.group;
    g.visible = visible;
    if (!visible) return;
    g.position.set(P.x + P.tz * lateral, P.y + 0.05, P.z - P.tx * lateral);
    g.rotation.set(-Math.atan(this.route.grade(dist, 8) / 100), Math.atan2(P.tx, P.tz), 0, 'YXZ');
    rider.pose(crank, dist / 0.34);
  }

  update(dt, player, wind) {
    const route = this.route;
    this.placeRider(this.player, player.dist, -1.5, player.crank, CAMERAS[this.cameraMode].name !== 'Handlebar');

    const P = route.at(player.dist, this._p);
    const cam = CAMERAS[this.cameraMode];
    const lx = P.tz, lz = -P.tx;
    const slope = route.grade(player.dist, 30) / 100;
    const rx = P.x - lx * 1.5, rz = P.z - lz * 1.5;
    const tx = rx - P.tx * cam.back + lx * cam.side, tz = rz - P.tz * cam.back + lz * cam.side;
    let ty = P.y - slope * cam.back + cam.up;
    // keep the camera out of the hillside, also on the way to the rider
    const ground = Math.max(this.height(tx, tz), this.height((tx * 2 + rx) / 3, (tz * 2 + rz) / 3) - 1.5);
    if (ty < ground + 2.2) ty = ground + 2.2;
    const lookX = rx + P.tx * cam.ahead, lookZ = rz + P.tz * cam.ahead;
    const lookY = P.y + slope * cam.ahead + 1.15;

    const k = this._camReady ? 1 - Math.exp(-dt * 4) : 1;
    this._camReady = true;
    this._camPos.x += (tx - this._camPos.x) * k;
    this._camPos.y += (ty - this._camPos.y) * k;
    this._camPos.z += (tz - this._camPos.z) * k;
    this._camLook.x += (lookX - this._camLook.x) * k;
    this._camLook.y += (lookY - this._camLook.y) * k;
    this._camLook.z += (lookZ - this._camLook.z) * k;
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
    this.sky.position.copy(this._camPos);
    this.plain.position.x = this._camPos.x;
    this.plain.position.z = this._camPos.z;
    this.sun.target.position.set(P.x, P.y, P.z);
    this.sun.position.set(P.x + this.sunDir.x * 200, P.y + this.sunDir.y * 200, P.z + this.sunDir.z * 200);
    this._updateWindFx(dt, wind);
    this._time.value += dt;
    if (this._seaTime) this._seaTime.value += dt;
    if (this.sea) this.sea.position.set(this._camPos.x, 0.35, this._camPos.z);
    const breeze = 0.35 + (wind ? wind.speed : 0) * 0.09; // sails and blades turn faster in more wind
    for (const sp of this._spinners) sp.rotor.rotation.z += dt * breeze * sp.speed;
    this.clouds.position.set(this._camPos.x, Math.max(2600, this._camPos.y + 1500), this._camPos.z);
    this._updateGrass(player.dist);
    const range2 = this.quality.range ** 2, detail2 = this.quality.detail ** 2;
    for (const m of this._scenery) {
      const d2 = m.boundingSphere.center.distanceToSquared(this._camPos);
      m.visible = d2 < range2;
      m.geometry = m.userData[d2 < detail2 ? this.quality.near : this.quality.far];
    }
  }

  snapCamera() {
    this._camReady = false;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
