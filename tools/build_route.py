#!/usr/bin/env python3
"""Build the data file for a climb: the road from OSRM, heights from the
EU-DEM 25 m model (opentopodata.org) and a coarse terrain grid around it.

    python3 tools/build_route.py alpe-dhuez        # writes data/alpe-dhuez.json

Both services are free and rate limited, so this takes a few minutes a route.
"""
import json, math, os, subprocess, sys, time

FR = {'top': 'Sommet', 'alt': 'Altitude', 'grade': 'Pente', 'start': 'DÉPART'}
IT = {'top': 'Cima', 'alt': 'Altitudine', 'grade': 'Pendenza', 'start': 'PARTENZA'}
NL = {'top': 'Finish', 'alt': 'Hoogte', 'grade': 'Helling', 'start': 'START'}
# coords: "lon,lat;lon,lat" start;finish. forest: [starts, full, thins, gone] in metres
# of altitude (None = no forest). bare: [from, to] where the ground becomes open rock.
ROUTES = {
    'ventoux': dict(name='Mont Ventoux', sub='from Bédoin · the classic ascent', start='Bédoin', top='Sommet', topEle=1909,
        coords='5.1802,44.1236;5.2787,44.1741', forest=[470, 590, 1390, 1530], bare=[1400, 1520], high='scree', lowland='provence',
        maxSlope=0.118, climbFrom=5000, midEle=1417, sign=FR,
        landmarks=[{'name': 'Saint-Estève', 'steepStart': True}, {'name': 'Chalet Reynard', 'ele': 1417}, {'name': 'Stèle Tom Simpson', 'fromTop': 1350}]),
    'alpe-dhuez': dict(name="Alpe d'Huez", sub="from Le Bourg-d'Oisans · the 21 hairpins", start="Bourg-d'Oisans", top="Alpe d'Huez", topEle=1850,
        coords='6.0395,45.0651;6.0712,45.0945', forest=[740, 800, 1450, 1650], bare=[1700, 1900], high='alpine', lowland='alpine',
        maxSlope=0.135, climbFrom=0, sign=FR, hairpinWord='Virage',
        landmarks=[{'name': 'La Garde', 'ele': 960}, {'name': 'Huez', 'ele': 1495}]),
    'galibier': dict(name='Col du Galibier', sub='from Valloire · the high Alps', start='Valloire', top='Col du Galibier', topEle=2642,
        coords='6.4296,45.1654;6.4078,45.0641', forest=None, bare=[1900, 2200], high='alpine', lowland='alpine',
        maxSlope=0.125, climbFrom=0, sign=FR,
        landmarks=[{'name': 'Plan Lachat', 'ele': 1962}, {'name': 'Les Granges', 'ele': 2301}]),
    'tourmalet': dict(name='Col du Tourmalet', sub='from Luz-Saint-Sauveur · the Pyrenees', start='Luz-Saint-Sauveur', top='Col du Tourmalet', topEle=2115,
        coords='-0.0030,42.8722;0.1452,42.9084', forest=[730, 800, 1250, 1450], bare=[1550, 1850], high='alpine', lowland='alpine',
        maxSlope=0.125, climbFrom=0, sign=FR,
        landmarks=[{'name': 'Barèges', 'ele': 1240}, {'name': 'Tournaboup', 'ele': 1450}]),
    'stelvio': dict(name='Passo dello Stelvio', sub='from Prato · hairpin after hairpin to 2758 m', start='Prato allo Stelvio', top='Passo dello Stelvio', topEle=2758,
        coords='10.5930,46.6200;10.4531,46.5286', forest=[930, 1000, 2050, 2200], bare=[2200, 2400], high='alpine', lowland='alpine',
        maxSlope=0.14, climbFrom=0, sign=IT, hairpinWord='Tornante',
        landmarks=[{'name': 'Gomagoi', 'ele': 1267}, {'name': 'Trafoi', 'ele': 1543}, {'name': 'Franzenshöhe', 'ele': 2188}]),
}

# Rides that are not one long climb. kind: flat | rolling | hilly. Landmarks are
# given by position and snapped to the road. dx = terrain grid spacing in metres.
ROUTES.update({
    'amstel': dict(kind='flat', name='Along the Amstel', sub='Amsterdam to Uithoorn · river and polders', start='Amsterdam', top='Uithoorn',
        coords='4.9120,52.3410;4.9135,52.2950;4.8850,52.2560;4.8300,52.2420', forest=None, bare=None, high='alpine', lowland='alpine',
        maxSlope=0.06, smooth=9, dx=300, margin=2500, sign=NL, trees='broadleaf', forestScale=0.35, houses='brick', extras=['windmills', 'cows'],
        landmarks=[{'name': 'Ouderkerk', 'lat': 52.2950, 'lon': 4.9135}, {'name': 'Nes aan de Amstel', 'lat': 52.2560, 'lon': 4.8850}]),
    'afsluitdijk': dict(kind='flat', name='Afsluitdijk', sub='Den Oever to Friesland · 34 km of sea and wind', start='Den Oever', top='Friesland',
        coords='5.0445,52.9360;5.3940,53.1110', forest=None, bare=None, high='alpine', lowland='alpine', water=True, exposure=0.95, fillEle=6,
        maxSlope=0.04, smooth=12, dx=300, margin=2500, sign=NL, houses='brick', extras=['turbines', 'sea'],
        landmarks=[{'name': 'Breezanddijk', 'lat': 53.0190, 'lon': 5.2040}, {'name': 'Kornwerderzand', 'lat': 53.0740, 'lon': 5.3350}]),
    'posbank': dict(kind='rolling', name='Posbank', sub='Velp loop over the Veluwezoom · forest and heath', start='Velp', top='Velp',
        coords='5.9760,52.0010;5.9640,52.0100;6.0206,52.0283;6.0290,52.0070;5.9760,52.0010', forest=[12, 22, 78, 95], bare=None, high='alpine', lowland='alpine',
        maxSlope=0.12, smooth=9, dx=200, margin=2500, sign=NL, trees='mixed', houses='brick',
        landmarks=[{'name': 'Rozendaal', 'lat': 52.0100, 'lon': 5.9640}, {'name': 'Posbank', 'lat': 52.0283, 'lon': 6.0206}, {'name': 'Rheden', 'lat': 52.0070, 'lon': 6.0290}]),
    'limburg': dict(kind='hilly', name='Limburg hills', sub='Valkenburg loop · Eyserbosweg and a Cauberg finish', start='Valkenburg', top='Cauberg',
        coords='5.8330,50.8650;5.8260,50.8440;5.8890,50.8150;5.9330,50.8260;5.9230,50.8400;5.8960,50.8330;5.8700,50.8540;5.8330,50.8650;5.8120,50.8555',
        forest=None, bare=None, high='alpine', lowland='alpine', maxSlope=0.17, smooth=8, dx=200, margin=2500, sign=NL, trees='broadleaf', forestScale=0.5, houses='brick', extras=['cows'],
        landmarks=[{'name': 'Sibbe', 'lat': 50.8440, 'lon': 5.8260}, {'name': 'Gulpen', 'lat': 50.8150, 'lon': 5.8890}, {'name': 'Eys', 'lat': 50.8260, 'lon': 5.9330},
                   {'name': 'Eyserbosweg', 'lat': 50.8400, 'lon': 5.9230}, {'name': 'Wijlre', 'lat': 50.8330, 'lon': 5.8960}, {'name': 'Foot of the Cauberg', 'lat': 50.8650, 'lon': 5.8330, 'last': True}]),
})
for _r in ROUTES.values(): _r.setdefault('kind', 'climb')

def get(url):
    for attempt in range(8):
        try:
            d = json.loads(subprocess.run(['curl', '-s', '-m', '40', url], capture_output=True, check=True).stdout)
            if d.get('status', 'OK') == 'OK' and d.get('code', 'Ok') == 'Ok':
                return d
            print('retry', str(d)[:120], flush=True)
        except Exception as e:
            print('retry', e, flush=True)
        time.sleep(4 + attempt * 4)
    raise SystemExit('fetch failed')

def elev(pts):
    out = []
    for i in range(0, len(pts), 100):
        loc = '|'.join('%.5f,%.5f' % p for p in pts[i:i + 100])
        out += [r['elevation'] for r in get('https://api.opentopodata.org/v1/eudem25m?locations=' + loc)['results']]
        if (i // 100) % 10 == 0: print(len(out), '/', len(pts), flush=True)
        time.sleep(1.15)
    return out

def gauss(vals, sigma):
    rad = int(sigma * 3); w = [math.exp(-0.5 * (i / sigma) ** 2) for i in range(-rad, rad + 1)]
    out = []
    for i in range(len(vals)):
        s = ws = 0
        for k in range(-rad, rad + 1):
            q = min(max(i + k, 0), len(vals) - 1); s += vals[q] * w[k + rad]; ws += w[k + rad]
        out.append(s / ws)
    return out

def build(rid):
    meta = dict(ROUTES[rid]); coords_arg = meta.pop('coords'); fill = meta.pop('fillEle', None)
    M = float(meta.pop('margin', 3000)); DX = float(meta.pop('dx', 150))
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', rid + '.json')
    if '--meta' in sys.argv:  # only refresh the descriptive part
        d = json.load(open(out)); d['meta'] = dict(meta, id=rid)
        json.dump(d, open(out, 'w'), separators=(',', ':'), ensure_ascii=False); return
    r = get('https://router.project-osrm.org/route/v1/driving/%s?overview=full&geometries=geojson&continue_straight=true' % coords_arg)
    coords = r['routes'][0]['geometry']['coordinates']
    lons = [c[0] for c in coords]; lats = [c[1] for c in coords]
    lon0 = (min(lons) + max(lons)) / 2; lat0 = (min(lats) + max(lats)) / 2
    KY = 111132.0; KX = 111320.0 * math.cos(math.radians(lat0))
    proj = lambda lon, lat: ((lon - lon0) * KX, (lat - lat0) * KY)
    unproj = lambda x, y: (y / KY + lat0, x / KX + lon0)
    xy = [proj(*c) for c in coords]
    cum = [0.0]
    for i in range(1, len(xy)): cum.append(cum[-1] + math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
    total = cum[-1]; STEP = 10.0; rs = []; j = 0
    for k in range(int(total // STEP) + 2):
        d = min(k * STEP, total)
        while j < len(cum) - 2 and cum[j + 1] < d: j += 1
        seg = cum[j + 1] - cum[j]; t = 0 if seg == 0 else (d - cum[j]) / seg
        rs.append((xy[j][0] + (xy[j + 1][0] - xy[j][0]) * t, xy[j][1] + (xy[j + 1][1] - xy[j][1]) * t))
        if d >= total: break
    rs = list(zip(gauss([p[0] for p in rs], 1.2), gauss([p[1] for p in rs], 1.2)))
    idx = list(range(0, len(rs), 2))
    if idx[-1] != len(rs) - 1: idx.append(len(rs) - 1)
    print(rid, 'road', round(total), 'm', flush=True)
    e = elev([unproj(*rs[i]) for i in idx]); last = None
    for i in range(len(e)):
        if e[i] is None: e[i] = fill if fill is not None else last
        elif fill is not None: e[i] = max(e[i], fill)
        last = e[i]
    ele = []
    for i in range(len(rs)):
        k = min(i // 2, len(idx) - 2); a = idx[k]; b = idx[k + 1]
        t = min(max((i - a) / (b - a), 0), 1)
        ele.append(e[k] + (e[k + 1] - e[k]) * t)
    raw0, raw1 = ele[0], ele[-1]
    ele = gauss(ele, 8)
    x0 = min(p[0] for p in rs) - M; x1 = max(p[0] for p in rs) + M
    y0 = min(p[1] for p in rs) - M; y1 = max(p[1] for p in rs) + M
    nx = int((x1 - x0) / DX) + 1; ny = int((y1 - y0) / DX) + 1
    print(rid, 'grid', nx, ny, flush=True)
    gh = [-999 if v is None else v for v in elev([unproj(x0 + i * DX, y0 + j * DX) for j in range(ny) for i in range(nx)])]
    json.dump({
        'name': meta['name'], 'sub': meta['sub'], 'meta': dict(meta, id=rid), 'step': STEP, 'lat0': lat0, 'lon0': lon0,
        'route': [[round(p[0], 1), round(p[1], 1), round(z, 1)] for p, z in zip(rs, ele)],
        'grid': {'x0': round(x0, 1), 'y0': round(y0, 1), 'dx': DX, 'nx': nx, 'ny': ny, 'nodata': -999, 'h': [round(v) for v in gh]},
    }, open(out, 'w'), separators=(',', ':'), ensure_ascii=False)
    print(rid, 'done', len(rs), 'pts', round(total), 'm', round(raw0), round(raw1), flush=True)

for rid in [a for a in sys.argv[1:] if not a.startswith('--')]:
    build(rid)
