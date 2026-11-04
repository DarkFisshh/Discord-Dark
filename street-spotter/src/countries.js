// Country borders (Natural Earth 1:10m via world-atlas) used to
// restrict a round to one country and to validate captures server-side.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
import { geoBounds, geoContains, geoDistance } from "d3-geo";

const require = createRequire(import.meta.url);
const topo = JSON.parse(
  readFileSync(require.resolve("world-atlas/countries-10m.json"), "utf8")
);
const features = feature(topo, topo.objects.countries).features.filter(
  (f) => f.properties?.name && f.geometry
);

const byId = new Map();
for (const f of features) {
  const id = String(f.id ?? f.properties.name);
  // d3 bounds are [[west, south], [east, north]]; west > east means it wraps the antimeridian.
  const [[w, s], [e, n]] = geoBounds(f);
  byId.set(id, { id, name: f.properties.name, bbox: { w, s, e, n }, feature: f });
}

export function listCountries() {
  return [...byId.values()]
    .map(({ id, name, bbox }) => ({ id, name, bbox }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCountry(id) {
  const c = byId.get(String(id));
  return c ? { id: c.id, name: c.name, bbox: c.bbox } : null;
}

// ~3 km tolerance: even 1:10m borders are simplified, so coastal roads and
// border towns can fall just outside the polygon.
const TOLERANCE_RAD = 3 / 6371;

export function isInCountry(id, lat, lng) {
  const c = byId.get(String(id));
  if (!c) return true; // unknown restriction -> do not block play
  const p = [lng, lat];
  if (geoContains(c.feature, p)) return true;
  return nearPolygon(c.feature.geometry, p);
}

function nearPolygon(geometry, p) {
  const polys =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        if (segmentDistance(p, ring[i - 1], ring[i]) < TOLERANCE_RAD) return true;
      }
    }
  }
  return false;
}

// Distance from point p to segment a-b (in radians), using a local flat
// projection to find the closest point; fine for the short segments in 1:10m data.
function segmentDistance(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return geoDistance(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}
