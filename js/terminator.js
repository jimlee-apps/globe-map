/**
 * Night hemisphere as simple longitude slices, plus the terminator line.
 * Slices stay on one side of the antimeridian so the globe fill does not
 * have to guess which side of a hemisphere polygon is the interior.
 */

import { subsolarPoint } from "./solar.js";

function terminatorLat(lng, sunLng, tanDec) {
  const hourAngle = ((lng - sunLng) * Math.PI) / 180;
  return (Math.atan(-Math.cos(hourAngle) / tanDec) * 180) / Math.PI;
}

export function buildTerminator(date) {
  const sun = subsolarPoint(date);
  let declination = sun.lat;
  if (Math.abs(declination) < 0.05) declination = declination < 0 ? -0.05 : 0.05;
  const tanDec = Math.tan((declination * Math.PI) / 180);
  const pole = declination >= 0 ? -90 : 90;
  const step = 1;
  const features = [];

  for (let lng = -180; lng < 180; lng += step) {
    const lng2 = Math.min(180, lng + step);
    const lat1 = terminatorLat(lng, sun.lng, tanDec);
    const lat2 = terminatorLat(lng2, sun.lng, tanDec);
    const west = lng;
    const east = lng2;
    features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [round(west), round(lat1)],
            [round(east), round(lat2)],
            [round(east), pole],
            [round(west), pole],
            [round(west), round(lat1)],
          ],
        ],
      },
    });
  }

  const line = [];
  for (let lng = -180; lng <= 180; lng += step) {
    line.push([lng, round(terminatorLat(lng, sun.lng, tanDec))]);
  }

  return {
    sun,
    night: { type: "FeatureCollection", features },
    line: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: line },
        },
      ],
    },
    sunPoint: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Subsolar point" },
          geometry: {
            type: "Point",
            coordinates: [round(sun.lng), round(sun.lat)],
          },
        },
      ],
    },
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
