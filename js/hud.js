// Canvas widgets: elevation profiles and the minimap.

export function gradeColor(g) {
  if (g < 1) return '#5fb0e8';
  if (g < 4) return '#58c26b';
  if (g < 6.5) return '#e3cf3f';
  if (g < 8.5) return '#f0983a';
  if (g < 10.5) return '#e5533d';
  return '#b22a4b';
}

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { ctx: canvas.getContext('2d'), w, h, dpr };
}

function drawStrip(ctx, route, from, to, w, h, top, minE, maxE, span) {
  const cols = Math.ceil(w / 2);
  for (let i = 0; i < cols; i++) {
    const d = from + ((i + 0.5) / cols) * (to - from);
    if (d < 0 || d > route.total) continue;
    const y = top + (1 - (route.ele(d) - minE) / (maxE - minE)) * (h - top);
    ctx.fillStyle = gradeColor(route.grade(d, span));
    ctx.fillRect(i * 2, y, 2.4, h - y);
  }
}

// Whole-route profile with landmarks; the part already ridden is brighter.
export class RouteProfile {
  constructor(canvas, route, labels = true) {
    this.canvas = canvas;
    this.route = route;
    this.labels = labels;
    this.cache = document.createElement('canvas');
  }

  draw(dist) {
    const { ctx, w, h, dpr } = fit(this.canvas);
    const route = this.route, top = (this.labels ? 16 : 2) * dpr;
    if (this.cache.width !== w || this.cache.height !== h) {
      this.cache.width = w;
      this.cache.height = h;
      const c = this.cache.getContext('2d');
      drawStrip(c, route, 0, route.total, w, h, top, route.minEle - 120, route.maxEle, 700);
    }
    ctx.clearRect(0, 0, w, h);
    const x = (dist / route.total) * w;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.cache, 0, 0);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, h);
    ctx.clip();
    ctx.drawImage(this.cache, 0, 0);
    ctx.restore();

    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    route.landmarks.forEach((lm, i) => {
      if (!this.labels) return;
      const lx = (lm.dist / route.total) * w;
      const last = i === route.landmarks.length - 1;
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(Math.min(w - dpr, lx), 12 * dpr, dpr, h);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      // the last two landmarks sit close together: hang their labels to the left
      ctx.textAlign = i === 0 ? 'left' : i >= route.landmarks.length - 2 ? 'right' : 'center';
      ctx.fillText(lm.name, i === 0 ? 4 * dpr : last ? w : lx - (i === route.landmarks.length - 2 ? 4 * dpr : 0), 0);
    });
    const y = top + (1 - (route.ele(dist) - (route.minEle - 120)) / (route.maxEle - route.minEle + 120)) * (h - top);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - dpr, y, 2 * dpr, h - y);
    ctx.beginPath();
    ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Zoomed profile of the road just ahead.
export class AheadProfile {
  constructor(canvas, route, behind = 150, ahead = 1350) {
    this.canvas = canvas;
    this.route = route;
    this.behind = behind;
    this.ahead = ahead;
  }

  draw(dist) {
    const { ctx, w, h, dpr } = fit(this.canvas);
    const route = this.route;
    const from = dist - this.behind, to = dist + this.ahead;
    let minE = Infinity, maxE = -Infinity;
    for (let d = from; d <= to; d += 50) {
      const e = route.ele(d);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }
    const mid = (minE + maxE) / 2, range = Math.max(maxE - minE, 150) * 1.15;
    minE = mid - range / 2 - range * 0.25;
    maxE = mid + range / 2;
    ctx.clearRect(0, 0, w, h);
    drawStrip(ctx, route, from, to, w, h, 0, minE, maxE, 40);
    const x = (this.behind / (this.behind + this.ahead)) * w;
    const y = (1 - (route.ele(dist) - minE) / (maxE - minE)) * h;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - dpr, y, 2 * dpr, h - y);
    ctx.beginPath();
    ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    // 500 m ticks
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const m of [500, 1000]) {
      const tx = ((this.behind + m) / (this.behind + this.ahead)) * w;
      ctx.fillRect(tx, h - 5 * dpr, dpr, 5 * dpr);
      ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, tx, h - 6 * dpr);
    }
  }
}

export class MiniMap {
  constructor(canvas, route) {
    this.canvas = canvas;
    this.route = route;
  }

  draw(dist) {
    const { ctx, w, h, dpr } = fit(this.canvas);
    const r = this.route, pad = 10 * dpr;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < r.n; i++) {
      minX = Math.min(minX, r.X[i]); maxX = Math.max(maxX, r.X[i]);
      minZ = Math.min(minZ, r.Z[i]); maxZ = Math.max(maxZ, r.Z[i]);
    }
    const s = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxZ - minZ));
    const ox = (w - (maxX - minX) * s) / 2, oz = (h - (maxZ - minZ) * s) / 2;
    const px = (x) => ox + (x - minX) * s, pz = (z) => oz + (z - minZ) * s;
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = ctx.lineCap = 'round';
    const path = (toDist) => {
      ctx.beginPath();
      for (let i = 0; i < r.n && r.D[i] <= toDist; i += 2) ctx.lineTo(px(r.X[i]), pz(r.Z[i]));
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 3 * dpr;
    path(Infinity);
    ctx.strokeStyle = '#ffb02e';
    path(dist);
    const p = r.at(dist, {});
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(px(p.x), pz(p.z), 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffb02e';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }
}
