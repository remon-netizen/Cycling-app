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
  constructor(canvas, route) {
    this.route = route;
    const meta = route.meta;
    this.F = meta.forest || [1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3]; // forest: starts, full, thins, gone
    this.B = meta.bare || [1e8, 1e8 + 1]; // open rock: from, to
    this.water = !!meta.water; // sea-level ground is drawn as water
    this.alpine = meta.high !== 'scree';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON, 500, 12000);
    this.camera = new THREE.PerspectiveCamera(58, 1, 1, 30000);
    this.cameraMode = 0;
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camReady = false;
    this._p = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    this._color = new THREE.Color();

    this._prepareGrid();
    this._lights();
    this._sky();
    this._coarseTerrain();
    this._corridor();
    this._road();
    this._vegetation();
    this._furniture();
    this._windFx();

    this.player = createRider({});
    this.scene.add(this.player.group);
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

  addBot(colors) {
    const r = createRider(colors);
    this.scene.add(r.group);
    this.bots.push(r);
    return r;
  }

  // Another real rider, with their name floating above them.
  addRemote(name, colors) {
    const r = createRider(colors);
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
    this.scene.add(new THREE.HemisphereLight(0xdcebff, 0x7d7460, 1.9));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6));
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.64).normalize();
    sun.position.copy(this.sunDir);
    this.scene.add(sun);
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
      s.uniforms.uMask = { value: mask };
      s.uniforms.uMaskRect = { value: new THREE.Vector4(g.x0, zMin, 1 / (cv.width * px), 1 / (cv.height * px)) };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWxz = position.xz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uMask; uniform vec4 uMaskRect; varying vec2 vWxz;')
        .replace('#include <clipping_planes_fragment>', 'if (texture2D(uMask, (vWxz - uMaskRect.xy) * uMaskRect.zw).r > 0.5) discard;\n#include <clipping_planes_fragment>');
    };
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _corridor() {
    const route = this.route, P = this._p, c = this._color;
    const half = [4.2, 7, 12, 20, 32, 50, 75, 110];
    const OFF = [...half.map((v) => -v).reverse(), ...half];
    const cols = OFF.length + 2; // plus a skirt each side
    const STEP = 10;
    const rows = Math.floor((route.total + 220) / STEP) + 2;
    // is the nearest bit of road to this point the bit we are building the strip for?
    const mine = (x, z, along, reach) => {
      const nr = route.nearest(x, z);
      return !nr || Math.abs(nr.dist - along) <= reach * 1.5 + 30;
    };
    const pos = new Float32Array(rows * cols * 3), nor = new Float32Array(rows * cols * 3), col = new Float32Array(rows * cols * 3);
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const s = Math.min(-110 + r * STEP, route.total + 110);
      route.at(s, P);
      const lx = P.tz, lz = -P.tx, sc = Math.min(route.total, Math.max(0, s));
      for (let ci = 0; ci < cols; ci++) {
        const skirt = ci === 0 || ci === cols - 1;
        // On hairpins the strips of two legs of road would overlap and bury
        // each other's tarmac, so each strip stops halfway to the other leg.
        let o = OFF[Math.min(OFF.length - 1, Math.max(0, ci - 1))];
        const reach = Math.abs(o), sgn = Math.sign(o);
        if (reach > 4.2 && !mine(P.x + lx * o, P.z + lz * o, sc, reach)) {
          let lo = 4.2, hi = reach;
          for (let it = 0; it < 9; it++) {
            const mid = (lo + hi) / 2;
            if (mine(P.x + lx * sgn * mid, P.z + lz * sgn * mid, sc, mid)) lo = mid;
            else hi = mid;
          }
          o = sgn * lo;
        }
        const x = P.x + lx * o, z = P.z + lz * o;
        const h = this.height(x, z), d = this.roadDist;
        const hx = this.height(x + 1.5, z) - this.height(x - 1.5, z);
        const hz = this.height(x, z + 1.5) - this.height(x, z - 1.5);
        const nl = Math.hypot(hx / 3, 1, hz / 3);
        pos[k] = x; pos[k + 1] = skirt ? h - 45 : h; pos[k + 2] = z;
        nor[k] = -hx / 3 / nl; nor[k + 1] = 1 / nl; nor[k + 2] = -hz / 3 / nl;
        this.terrainColor(x, z, h, d, c);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
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
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this._chunked(geo, rows - 1, (cols - 1) * 6, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  // Split a strip mesh into draw groups along the road so off-screen parts are culled.
  _chunked(geo, rowCount, indicesPerRow, material, rowsPerChunk = 60) {
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
      this.scene.add(mesh);
    }
  }

  _road() {
    const route = this.route, P = this._p;
    const STEP = 5, HALF = 3.2;
    const rows = Math.ceil(route.total / STEP) + 1;
    const pos = new Float32Array(rows * 6), uv = new Float32Array(rows * 4), nor = new Float32Array(rows * 6);
    for (let r = 0; r < rows; r++) {
      const s = Math.min(r * STEP, route.total);
      route.at(s, P);
      const lx = P.tz, lz = -P.tx;
      pos.set([P.x - lx * HALF, P.y + 0.04, P.z - lz * HALF, P.x + lx * HALF, P.y + 0.04, P.z + lz * HALF], r * 6);
      nor.set([0, 1, 0, 0, 1, 0], r * 6);
      uv.set([0, s / 12, 1, s / 12], r * 4);
    }
    const idx = new Uint32Array((rows - 1) * 6);
    for (let r = 0, q = 0; r < rows - 1; r++) {
      const a = r * 2, b = a + 1, cc = a + 2, d = a + 3;
      idx[q++] = a; idx[q++] = cc; idx[q++] = b;
      idx[q++] = b; idx[q++] = cc; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const tex = textTexture(128, 512, (ctx, w, h) => {
      ctx.fillStyle = '#55565b';
      ctx.fillRect(0, 0, w, h);
      const rand = rng(7);
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)';
        ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 3);
      }
      ctx.fillStyle = '#e9e7df';
      ctx.fillRect(4, 0, 3, h);
      ctx.fillRect(w - 7, 0, 3, h);
      ctx.fillRect(w / 2 - 1.5, 0, 3, h * 0.33);
    });
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this._chunked(geo, rows - 1, 6, mat, 120);
  }

  // ---------- scenery ----------

  _vegetation() {
    const route = this.route, P = this._p, rand = rng(1909), F = this.F, B = this.B, provence = route.meta.lowland === 'provence';
    const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 7).translate(0, y, 0);
    const pine = merged([
      { geo: new THREE.CylinderGeometry(0.025, 0.035, 0.3, 5).translate(0, 0.15, 0), color: 0x5b4632 },
      { geo: cone(0.22, 0.5, 0.45), color: 0x2c5530 },
      { geo: cone(0.16, 0.42, 0.74), color: 0x35633a },
    ]);
    const leafy = merged([
      { geo: new THREE.CylinderGeometry(0.03, 0.04, 0.4, 5).translate(0, 0.2, 0), color: 0x5e4a36 },
      { geo: new THREE.IcosahedronGeometry(0.33, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), color: 0x5f8a3c },
    ]);
    const cypress = merged([
      { geo: new THREE.CylinderGeometry(0.02, 0.025, 0.12, 5).translate(0, 0.06, 0), color: 0x4f3f30 },
      { geo: cone(0.095, 0.92, 0.54), color: 0x2a4a30 },
    ]);
    const rock = merged([{ geo: new THREE.IcosahedronGeometry(1, 0), color: 0xd9d5ca }]);
    const flat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

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
      this.scene.add(mesh);
    };

    for (let c0 = 0; c0 < route.total; c0 += CHUNK) {
      const pines = [], leafies = [], rocks = [], cypresses = [];
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
          const forest = smooth(F[0], F[1], h) * (1 - smooth(F[2], F[3], h));
          const scree = smooth(B[0], B[1], h);
          if (h < Math.min(F[1] + 10, B[0]) && forest < 0.3 && r1 < (provence ? 0.3 : 0.14)) {
            // lowlands: scattered trees (cypresses too in Provence)
            const tall = provence && r2 < 0.4, size = tall ? 8 + r3 * 6 : 5 + r3 * 4;
            e.set(0, r4 * 6.28, 0);
            m.compose(v.set(x, h - 0.2, z), q.setFromEuler(e), sc.set(size, size, size));
            tint.setScalar(0.8 + r4 * 0.35);
            (tall ? cypresses : leafies).push({ m: m.clone(), c: tint.clone() });
          } else if (r1 < forest * 0.85) {
            const broad = r2 < (h < F[1] + 360 ? 0.55 : 0.18);
            const size = (broad ? 6 + r3 * 5 : 7 + r3 * 8) * (1 - 0.45 * smooth(F[2] - 90, F[3], h));
            e.set(0, r4 * 6.28, 0);
            m.compose(v.set(x, h - 0.2, z), q.setFromEuler(e), sc.set(size * (0.8 + r2 * 0.5), size, size * (0.8 + r2 * 0.5)));
            tint.setScalar(0.78 + r4 * 0.4);
            (broad ? leafies : pines).push({ m: m.clone(), c: tint.clone() });
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
    this.sun.intensity = 2.6 * (1 - 0.6 * c);
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
    this._updateWindFx(dt, wind);
  }

  snapCamera() {
    this._camReady = false;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
