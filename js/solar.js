/**
 * Subsolar point for the day/night terminator.
 * Low-precision solar position (Meeus), visual accuracy well under a degree.
 * Not for navigation.
 */

function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

function wrapLon(deg) {
  return wrap360(deg + 180) - 180;
}

export function subsolarPoint(date) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLon = wrap360(280.46 + 0.9856474 * n);
  const anomaly = wrap360(357.528 + 0.9856003 * n);
  const eclLon = wrap360(
    meanLon + 1.915 * Math.sin(anomaly * rad) + 0.02 * Math.sin(2 * anomaly * rad)
  );
  const obliquity = 23.439 - 0.0000004 * n;
  const decl = Math.asin(Math.sin(obliquity * rad) * Math.sin(eclLon * rad));
  const ra = Math.atan2(
    Math.cos(obliquity * rad) * Math.sin(eclLon * rad),
    Math.cos(eclLon * rad)
  );
  const gmst = wrap360(280.46061837 + 360.98564736629 * n);
  return {
    lat: decl * (180 / Math.PI),
    lng: wrapLon(ra * (180 / Math.PI) - gmst),
  };
}

export function formatLat(lat) {
  const hemisphere = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(1)}°${hemisphere}`;
}

export function formatLng(lng) {
  const hemisphere = lng >= 0 ? "E" : "W";
  return `${Math.abs(lng).toFixed(1)}°${hemisphere}`;
}
