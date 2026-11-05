/* Great-circle route maths. Spherical Earth, mean radius 6,371,008.8 m (IUGG).
   Distance by haversine; path by slerp between unit vectors. */
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function greatCircle(from, to, maxStepKm = 50) {
  const [l1, p1] = from.map(rad);
  const [l2, p2] = to.map(rad);
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h))); // central angle
  const meters = d * R;
  const n = Math.max(2, Math.ceil(meters / 1000 / maxStepKm));
  const a = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const b = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const coords = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = d === 0 ? 1 - f : Math.sin((1 - f) * d) / Math.sin(d);
    const B = d === 0 ? f : Math.sin(f * d) / Math.sin(d);
    const x = A * a[0] + B * b[0], y = A * a[1] + B * b[1], z = A * a[2] + B * b[2];
    let lng = deg(Math.atan2(y, x));
    const lat = deg(Math.atan2(z, Math.hypot(x, y)));
    // Unwrap: keep each step within 180° of the previous so the line never
    // jumps across the map at the antimeridian (lng may exceed ±180).
    if (prev !== null) {
      while (lng - prev > 180) lng -= 360;
      while (lng - prev < -180) lng += 360;
    }
    prev = lng;
    coords.push([lng, lat]);
  }
  return { meters, coordinates: coords };
}
