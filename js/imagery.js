// Satellite imagery for the terrain: Sentinel-2 cloudless by EOX
// (https://s2maps.eu, CC BY-NC-SA 4.0, contains modified Copernicus Sentinel
// data). Free for non-commercial use with that credit; about 7-10 m a pixel,
// which is plenty for hillsides and valleys but soft right next to the road.
//
// The same picture tells us where the real forest is, which drives the trees
// and how much wind reaches the road.

const LAYER = 's2cloudless-2021_3857';
const tileUrl = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/${LAYER}/default/g/${z}/${y}/${x}.jpg`;
const MAX_SIDE = 4096;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const mercX = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const mercY = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z * 256;

function loadTile(url, timeout) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), timeout);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

// Returns null when the pictures cannot be loaded; the world then falls back
// to its own colours.
export async function loadImagery(route, timeout = 9000) {
  try {
    const g = route.grid;
    const KX = 111320 * Math.cos((route.lat0 * Math.PI) / 180), KY = 111132;
    const lon = (x) => route.lon0 + x / KX, lat = (y) => route.lat0 + y / KY;
    const west = g.x0, east = g.x0 + (g.nx - 1) * g.dx, south = g.y0, north = g.y0 + (g.ny - 1) * g.dx;
    let z = 14;
    while (z > 10 && Math.max(mercX(lon(east), z) - mercX(lon(west), z), mercY(lat(south), z) - mercY(lat(north), z)) > MAX_SIDE - 512) z--;
    const tx0 = Math.floor(mercX(lon(west), z) / 256), tx1 = Math.floor(mercX(lon(east), z) / 256);
    const ty0 = Math.floor(mercY(lat(north), z) / 256), ty1 = Math.floor(mercY(lat(south), z) / 256);
    const canvas = document.createElement('canvas');
    canvas.width = (tx1 - tx0 + 1) * 256;
    canvas.height = (ty1 - ty0 + 1) * 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#5d6b4a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(loadTile(tileUrl(z, tx, ty), timeout).then((img) => {
      if (img) ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
      return !!img;
    }));
    const done = await Promise.all(jobs);
    if (done.filter(Boolean).length < done.length * 0.7) return null;

    // Straight-line mapping from world metres to picture pixels (the map
    // projection is close enough to linear over a few tens of kilometres).
    const px0 = tx0 * 256, py0 = ty0 * 256;
    const ax = (mercX(lon(east), z) - mercX(lon(west), z)) / (east - west), bx = mercX(lon(west), z) - px0 - ax * west;
    const ay = (mercY(lat(south), z) - mercY(lat(north), z)) / (north - south), by = mercY(lat(north), z) - py0 - ay * -north; // world z = -north
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    const out = [0, 0, 0];
    const scale = route.meta.forestScale ?? 1; // dark crops read as forest in farmland; tone it down there
    const img = {
      canvas,
      // for shaders: uv = (worldXZ - rect.xy) * rect.zw
      rect: [-bx / ax, -by / ay, ax / W, ay / H],
      // colour (0-255) at a world position
      sample(x, zw) {
        const u = Math.min(W - 1, Math.max(0, Math.round(ax * x + bx))), v = Math.min(H - 1, Math.max(0, Math.round(ay * zw + by)));
        const k = (v * W + u) * 4;
        out[0] = data[k]; out[1] = data[k + 1]; out[2] = data[k + 2];
        return out;
      },
      // 0 = open ground, 1 = closed forest: forest is dark and green from above
      forest(x, zw) {
        const [r, gr, b] = img.sample(x, zw);
        const bright = (r + gr + b) / 3, green = (gr - Math.max(r, b)) / Math.max(gr, 1);
        return smooth(-0.02, 0.1, green) * (1 - smooth(52, 92, bright)) * scale;
      },
      // 0..1: looks built-up (grey and fairly bright: roofs, streets, yards)
      urban(x, zw) {
        const [r, gr, b] = img.sample(x, zw);
        const mx = Math.max(r, gr, b), mn = Math.min(r, gr, b);
        return smooth(72, 105, (r + gr + b) / 3) * (1 - smooth(0.13, 0.25, (mx - mn) / Math.max(mx, 1)));
      },
    };
    return img;
  } catch (e) {
    console.warn('Satellite imagery unavailable:', e);
    return null;
  }
}
