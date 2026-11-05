import * as maplibregl from "../vendor/maplibre/maplibre-gl.mjs";
import { formatLat, formatLng, subsolarPoint } from "./solar.js";
import { buildTerminator } from "./terminator.js";
import { greatCircle, initialCourse } from "./route.js";

const PREF_KEY = "globemap-v1";
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

const layers = {
  fir: ["fir-fill", "fir-line", "fir-line-oceanic"],
  labels: ["fir-labels", "sector-labels"],
  airports: ["airport-dots-large", "airport-dots-medium"],
  airportLabels: ["airport-labels-large", "airport-labels-medium"],
  night: ["night-fill", "terminator-glow", "terminator-line", "sun-dot"],
  grid: ["graticule", "graticule-major"],
};

const state = {
  map: null,
  index: [],
  airports: new Map(),
  timer: 0,
  clockTimer: 0,
};

boot().catch((error) => {
  console.error(error);
  fail(error && error.message ? error.message : "Could not start GlobeMap.");
});

async function boot() {
  if (!webglOk()) {
    fail("This browser has no WebGL, so the globe cannot be drawn.");
    return;
  }
  restorePrefs();
  tickClock();
  state.clockTimer = window.setInterval(tickClock, 1000);
  bindChrome();

  const sun = subsolarPoint(new Date());
  let viewLng = sun.lng + 90;
  if (viewLng > 180) viewLng -= 360;

  const map = new maplibregl.Map({
    container: "map",
    style: baseStyle(),
    center: [viewLng, 12],
    zoom: 3.2,
    bearing: 0,
    pitch: 0,
    hash: true,
    attributionControl: false,
    renderWorldCopies: false,
    minZoom: 0.5,
    maxZoom: 12,
    maxPitch: 70,
    fadeDuration: 0,
  });
  state.map = map;
  window.__map = map; // debug handle for local testing
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
  map.on("error", (event) => {
    const message = event && event.error ? String(event.error.message || event.error) : "Map error";
    console.error(message);
    if (!document.body.dataset.ready && /WebGL|Failed to initialize/i.test(message)) fail(message);
  });

  map.on("load", async () => {
    try {
      map.setProjection({ type: "globe" });
      addGraticule(map);
      const [land, fir, labels, airports] = await Promise.all([
        loadJson("data/land.geojson"),
        loadJson("data/fir.geojson"),
        loadJson("data/fir-labels.geojson"),
        loadJson("data/airports.geojson"),
      ]);
      addLand(map, land);
      addNight(map);
      addFir(map, fir, labels);
      addAirports(map, airports);
      if (map.getLayer("sector-labels")) {
        map.moveLayer("terminator-glow", "sector-labels");
        map.moveLayer("terminator-line", "sector-labels");
      }
      map.moveLayer("sun-dot");
      applyPadding();
      if (!location.hash) centerOnTerminator(0);
      buildIndex(labels, airports);
      $("counts").textContent = `${fir.features.length.toLocaleString()} FIR polygons · ${airports.features.length.toLocaleString()} airports`;
      document.body.dataset.firs = String(fir.features.length);
      document.body.dataset.airports = String(airports.features.length);
      applyVisibility();
      applyNightMode();
      bindMapClicks(map);
      addRouteLayers(map);
      bindPlanner();
      state.timer = window.setInterval(() => refreshTerminator(map), REFRESH_MS);
      map.once("idle", () => {
        document.body.dataset.projection = (map.getProjection() && map.getProjection().type) || "";
        document.body.dataset.ready = "1";
        $("loading").hidden = true;
      });
    } catch (error) {
      console.error(error);
      fail(error && error.message ? error.message : "Could not load map data.");
    }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch((error) => {
      console.warn("service worker", error);
    });
  }
}

function baseStyle() {
  const fontBase = new URL("fonts/", document.baseURI).href;
  return {
    version: 8,
    name: "GlobeMap",
    glyphs: `${fontBase}{fontstack}/{range}.pbf`,
    projection: { type: "globe" },
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#0c3144" },
      },
    ],
  };
}

function assetUrl(path) {
  return new URL(path, document.baseURI).href;
}

async function loadJson(path) {
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}). Serve this folder over HTTP.`);
  return response.json();
}

function addGraticule(map) {
  const features = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    const coordinates = [];
    for (let lat = -80; lat <= 80; lat += 2) coordinates.push([lng, lat]);
    features.push(lineFeature(coordinates, { major: lng % 30 === 0 }));
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const coordinates = [];
    for (let lng = -180; lng <= 180; lng += 2) coordinates.push([lng, lat]);
    features.push(lineFeature(coordinates, { major: lat % 30 === 0 }));
  }
  map.addSource("graticule", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: "graticule",
    type: "line",
    source: "graticule",
    filter: ["!", ["get", "major"]],
    paint: { "line-color": "#1d4d63", "line-width": 0.6, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "graticule-major",
    type: "line",
    source: "graticule",
    filter: ["get", "major"],
    paint: { "line-color": "#2f6d84", "line-width": 0.9, "line-opacity": 0.9 },
  });
}

function addLand(map, data) {
  map.addSource("land", { type: "geojson", data });
  map.addLayer({
    id: "land-fill",
    type: "fill",
    source: "land",
    paint: {
      "fill-color": [
        "match",
        ["get", "continent"],
        "Africa", "#1c4a40",
        "Europe", "#24584c",
        "Asia", "#1a463e",
        "North America", "#1e5248",
        "South America", "#18483e",
        "Oceania", "#1d4e44",
        "Antarctica", "#243844",
        "#1b4a40",
      ],
    },
  });
  map.addLayer({
    id: "land-line",
    type: "line",
    source: "land",
    paint: { "line-color": "#3e7568", "line-width": 0.7, "line-opacity": 0.85 },
  });
}

function addNight(map) {
  const term = buildTerminator(new Date());
  map.addSource("night", { type: "geojson", data: term.night });
  map.addSource("terminator", { type: "geojson", data: term.line });
  map.addSource("sun", { type: "geojson", data: term.sunPoint });
  map.addLayer({
    id: "night-fill",
    type: "fill",
    source: "night",
    paint: { "fill-color": "#02060c", "fill-opacity": 0.55, "fill-antialias": false },
  });
  map.addLayer({
    id: "terminator-glow",
    type: "line",
    source: "terminator",
    paint: {
      "line-color": "#f7e7b8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 0.5, 7, 4, 10],
      "line-opacity": 0.35,
      "line-blur": 1.2,
    },
  });
  map.addLayer({
    id: "terminator-line",
    type: "line",
    source: "terminator",
    paint: {
      "line-color": "#fff6d8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 0.5, 2.2, 4, 3.2],
      "line-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "sun-dot",
    type: "circle",
    source: "sun",
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#ffe08a",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fffaf0",
    },
  });
}

function refreshTerminator(map) {
  if (!map.getSource("night")) return;
  const term = buildTerminator(new Date());
  map.getSource("night").setData(term.night);
  map.getSource("terminator").setData(term.line);
  map.getSource("sun").setData(term.sunPoint);
  tickClock();
}

function addFir(map, fir, labels) {
  map.addSource("fir", { type: "geojson", data: fir });
  map.addSource("fir-labels", { type: "geojson", data: labels });
  map.addLayer({
    id: "fir-fill",
    type: "fill",
    source: "fir",
    paint: {
      "fill-color": ["case", ["get", "oceanic"], "#7eb6c9", "#e4b34d"],
      "fill-opacity": 0.08,
    },
  });
  map.addLayer({
    id: "fir-line",
    type: "line",
    source: "fir",
    filter: ["!", ["get", "oceanic"]],
    paint: {
      "line-color": "#e4b34d",
      "line-width": ["interpolate", ["linear"], ["zoom"], 0.5, 0.7, 3, 1.3, 6, 2],
      "line-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "fir-line-oceanic",
    type: "line",
    source: "fir",
    filter: ["get", "oceanic"],
    paint: {
      "line-color": "#8ec5d6",
      "line-width": ["interpolate", ["linear"], ["zoom"], 0.5, 0.7, 3, 1.2, 6, 1.8],
      "line-dasharray": [2, 1.4],
      "line-opacity": 0.9,
    },
  });
  const labelPaint = {
    "text-color": "#ffe7b0",
    "text-halo-color": "#061018",
    "text-halo-width": 1.25,
  };
  map.addLayer({
    id: "sector-labels",
    type: "symbol",
    source: "fir-labels",
    filter: ["==", ["get", "kind"], "sector"],
    minzoom: 3.6,
    layout: {
      "text-field": ["get", "id"],
      "text-font": ["OpenSansRegular"],
      "text-size": 11,
      "text-padding": 2,
      "text-allow-overlap": false,
      "text-optional": true,
    },
    paint: { ...labelPaint, "text-color": "#ecd7a4" },
  });
  map.addLayer({
    id: "fir-labels",
    type: "symbol",
    source: "fir-labels",
    filter: ["==", ["get", "kind"], "fir"],
    minzoom: 0.7,
    layout: {
      "text-field": ["get", "id"],
      "text-font": ["OpenSansBold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 0.8, 10, 3, 13, 6, 15],
      "text-letter-spacing": 0.04,
      "text-padding": 3,
      "text-allow-overlap": false,
      "symbol-sort-key": 0,
    },
    paint: labelPaint,
  });
}

function addAirports(map, airports) {
  map.addSource("airports", { type: "geojson", data: airports });
  map.addLayer({
    id: "airport-dots-medium",
    type: "circle",
    source: "airports",
    filter: ["==", ["get", "type"], "medium_airport"],
    minzoom: 3.1,
    paint: {
      "circle-radius": 2.2,
      "circle-color": "#7eb6d6",
      "circle-stroke-width": 0.6,
      "circle-stroke-color": "#041018",
    },
  });
  map.addLayer({
    id: "airport-dots-large",
    type: "circle",
    source: "airports",
    filter: ["any", ["==", ["get", "type"], "large_airport"], ["==", ["get", "icao"], "AT98"]],
    minzoom: 1.5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1.5, 2.4, 4, 4, 7, 5.5],
      "circle-color": "#9ad7ff",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#041018",
    },
  });
  const layout = {
    "text-font": ["OpenSansRegular"],
    "text-offset": [0, 0.7],
    "text-anchor": "top",
    "text-allow-overlap": false,
    "text-optional": true,
  };
  map.addLayer({
    id: "airport-labels-medium",
    type: "symbol",
    source: "airports",
    filter: ["==", ["get", "type"], "medium_airport"],
    minzoom: 4.1,
    layout: { ...layout, "text-field": ["get", "icao"], "text-size": 11 },
    paint: {
      "text-color": "#d5ecff",
      "text-halo-color": "#061018",
      "text-halo-width": 1.1,
    },
  });
  map.addLayer({
    id: "airport-labels-large",
    type: "symbol",
    source: "airports",
    filter: ["any", ["==", ["get", "type"], "large_airport"], ["==", ["get", "icao"], "AT98"]],
    minzoom: 2.3,
    layout: { ...layout, "text-field": ["get", "icao"], "text-size": 12, "symbol-sort-key": 1 },
    paint: {
      "text-color": "#e7f6ff",
      "text-halo-color": "#061018",
      "text-halo-width": 1.2,
    },
  });
}

function bindMapClicks(map) {
  map.on("click", (event) => {
    const present = ["airport-dots-large", "airport-dots-medium", "airport-labels-large", "airport-labels-medium", "fir-fill"].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    if (!present.length) return;
    const pad = 6; // small tap tolerance around dots/labels
    const box = [[event.point.x - pad, event.point.y - pad], [event.point.x + pad, event.point.y + pad]];
    const hits = map.queryRenderedFeatures(box, { layers: present });
    if (!hits.length) return;
    // Prefer the airport whose marker is nearest the tap point.
    const apts = hits.filter((h) => h.layer.id.startsWith("airport") && h.geometry.type === "Point");
    const dist = (h) => { const q = map.project(h.geometry.coordinates); return (q.x - event.point.x) ** 2 + (q.y - event.point.y) ** 2; };
    apts.sort((a, b) => dist(a) - dist(b));
    const feature = apts[0] || hits[0];
    const props = feature.properties || {};
    if (feature.layer.id.startsWith("airport") && $("tog-click").checked) {
      addWaypoint(String(props.icao || "").toUpperCase());
      return;
    }
    const html = feature.layer.id.startsWith("airport")
      ? airportPopup(props)
      : firPopup(props);
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(event.lngLat)
      .setHTML(html)
      .addTo(map);
  });
  map.on("mousemove", (event) => {
    const present = ["airport-dots-large", "airport-dots-medium", "airport-labels-large", "airport-labels-medium"].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    const box = [[event.point.x - 6, event.point.y - 6], [event.point.x + 6, event.point.y + 6]];
    const hits = present.length ? map.queryRenderedFeatures(box, { layers: present }) : [];
    const code = hits.length ? String(hits[0].properties.icao || "") : "";
    map.getCanvas().style.cursor = hits.length ? "pointer" : "";
    if (map.getLayer("airport-hover")) map.setFilter("airport-hover", ["==", ["get", "icao"], code]);
  });
}

function firPopup(props) {
  const kind = props.oceanic === true || props.oceanic === "true" ? "Oceanic" : "Domestic";
  return `<div class="pop"><p class="pop-code">${esc(props.id)}</p><p class="pop-name">${esc(props.name)}</p><p class="pop-meta">${esc(kind)} · ${esc(props.region || "VATSIM")} · sim airspace</p></div>`;
}

function airportPopup(props) {
  const iata = props.iata ? ` · ${esc(props.iata)}` : "";
  const place = [props.municipality, props.country].filter(Boolean).join(" · ");
  const elev = props.elev_ft === undefined || props.elev_ft === null || props.elev_ft === "" ? "" : ` · ${esc(props.elev_ft)} ft`;
  const kind = props.type === "large_airport" ? "Large airport" : "Medium airport";
  return `<div class="pop"><p class="pop-code">${esc(props.icao)}${iata}</p><p class="pop-name">${esc(props.name)}</p><p class="pop-meta">${esc(place)}<br>${esc(kind)}${elev}</p></div>`;
}

function buildIndex(labels, airports) {
  const index = [];
  for (const feature of airports.features) {
    const props = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;
    state.airports.set(String(props.icao).toUpperCase(), { code: props.icao, name: props.name, lng, lat });
    index.push({
      code: props.icao,
      name: props.name,
      kind: "airport",
      detail: [props.municipality, props.country].filter(Boolean).join(" · "),
      lng,
      lat,
      zoom: 4.4,
    });
  }
  for (const feature of labels.features) {
    const props = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;
    index.push({
      code: props.id,
      name: props.name,
      kind: props.kind,
      detail: props.kind === "sector" ? "Sector" : "FIR",
      lng,
      lat,
      zoom: 3.4,
    });
  }
  state.index = index;
}

function bindChrome() {
  $("collapse").addEventListener("click", () => {
    const panel = $("panel");
    const collapsed = panel.classList.toggle("is-collapsed");
    $("collapse").textContent = collapsed ? "Show" : "Hide";
    $("collapse").setAttribute("aria-expanded", collapsed ? "false" : "true");
    applyPadding();
  });
  window.addEventListener("resize", () => applyPadding());
  for (const id of ["tog-fir", "tog-labels", "tog-airports", "tog-nightmode", "tog-night", "tog-grid"]) {
    $(id).addEventListener("change", () => {
      savePrefs();
      applyVisibility();
      if (id === "tog-nightmode") applyNightMode();
    });
  }
  $("btn-terminator").addEventListener("click", () => centerOnTerminator());
  $("btn-credits").addEventListener("click", () => $("credits").showModal());
  $("credits-close").addEventListener("click", () => $("credits").close());
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const hits = search($("q").value);
    if (hits[0]) goTo(hits[0]);
  });
  $("q").addEventListener("input", () => renderResults(search($("q").value)));
  $("q").addEventListener("keydown", (event) => {
    const buttons = [...$("results").querySelectorAll("button")];
    const current = buttons.findIndex((button) => button.getAttribute("aria-selected") === "true");
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!buttons.length) return;
      const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current - 1);
      buttons.forEach((button, index) => button.setAttribute("aria-selected", index === next ? "true" : "false"));
      buttons[next].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape") {
      $("results").hidden = true;
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search")) $("results").hidden = true;
  });
}

function search(raw) {
  const query = raw.trim().toUpperCase();
  if (query.length < 2) return [];
  const scored = [];
  for (const item of state.index) {
    const code = item.code.toUpperCase();
    const name = item.name.toUpperCase();
    let score = 9;
    if (code === query) score = 0;
    else if (code.startsWith(query)) score = 1;
    else if (name.startsWith(query)) score = 2;
    else if (code.includes(query) || name.includes(query)) score = 3;
    else continue;
    if (item.kind === "airport") score += 0.1;
    scored.push({ score, item });
  }
  scored.sort((a, b) => a.score - b.score || a.item.code.localeCompare(b.item.code));
  return scored.slice(0, 8).map((entry) => entry.item);
}

function renderResults(hits) {
  const list = $("results");
  list.replaceChildren();
  if (!hits.length || $("q").value.trim().length < 2) {
    list.hidden = true;
    return;
  }
  hits.forEach((item, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === 0 ? "true" : "false");
    button.innerHTML = `<span class="result-code">${esc(item.code)}</span> ${esc(item.name)}<span class="result-name">${esc(item.detail)}</span>`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => goTo(item));
    li.append(button);
    list.append(li);
  });
  list.hidden = false;
}

function goTo(item) {
  $("results").hidden = true;
  $("q").value = item.code;
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1200;
  state.map.flyTo({
    center: [item.lng, item.lat],
    zoom: Math.max(state.map.getZoom(), item.zoom),
    duration,
    essential: true,
  });
}

function centerOnTerminator(duration) {
  const sun = subsolarPoint(new Date());
  let lng = sun.lng + 90;
  if (lng > 180) lng -= 360;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900;
  state.map.easeTo({
    center: [lng, 12],
    zoom: 3.2,
    bearing: 0,
    pitch: 0,
    duration: duration === undefined ? motion : duration,
  });
}

function applyPadding() {
  const map = state.map;
  if (!map) return;
  const panel = $("panel");
  const collapsed = panel.classList.contains("is-collapsed");
  const width = collapsed ? 0 : panel.getBoundingClientRect().width;
  const credit = $("credit").getBoundingClientRect().height;
  map.setPadding({
    left: width > 0 ? width + 16 : 12,
    right: 48,
    top: 12,
    bottom: credit + 8,
  });
}

function applyVisibility() {
  const map = state.map;
  if (!map || !map.getLayer("fir-line")) return;
  const on = {
    fir: $("tog-fir").checked,
    labels: $("tog-labels").checked,
    airports: $("tog-airports").checked,
    night: $("tog-night").checked,
    grid: $("tog-grid").checked,
  };
  setVis(map, layers.fir, on.fir);
  setVis(map, layers.labels, on.labels);
  setVis(map, layers.airports, on.airports);
  setVis(map, layers.airportLabels, on.airports && on.labels);
  setVis(map, layers.night, on.night);
  setVis(map, layers.grid, on.grid);
}

function setVis(map, ids, visible) {
  for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function tickClock() {
  const now = new Date();
  const sun = subsolarPoint(now);
  $("clock").textContent = `${now.toISOString().slice(0, 19).replace("T", " ")} UTC`;
  $("sun").textContent = `Sun ${formatLat(sun.lat)}  ${formatLng(sun.lng)}`;
}

function restorePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    for (const [id, key] of [
      ["tog-fir", "fir"],
      ["tog-labels", "labels"],
      ["tog-airports", "airports"],
      ["tog-nightmode", "nightMode"],
      ["tog-night", "night"],
      ["tog-grid", "grid"],
    ]) {
      if (typeof saved[key] === "boolean") $(id).checked = saved[key];
    }
  } catch {
    /* private mode */
  }
}

function savePrefs() {
  const payload = {
    fir: $("tog-fir").checked,
    labels: $("tog-labels").checked,
    airports: $("tog-airports").checked,
    nightMode: $("tog-nightmode").checked,
    night: $("tog-night").checked,
    grid: $("tog-grid").checked,
  };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function webglOk() {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function fail(message) {
  const loading = $("loading");
  loading.hidden = false;
  loading.querySelector(".loading-card").classList.add("error");
  $("loading-text").textContent = message;
}

function lineFeature(coordinates, properties) {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

/* ---------- Multi-sector planner ---------- */
function addRouteLayers(map) {
  map.addLayer({ id: "airport-hover", type: "circle", source: "airports", filter: ["==", ["get", "icao"], ""],
    paint: { "circle-radius": 9, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffe08a", "circle-stroke-width": 2 } });
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#03070c", "line-width": 6, "line-opacity": 0.7 } });
  map.addLayer({ id: "route-line", type: "line", source: "route", filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ff4fd8", "line-width": 3 } });
  map.addLayer({ id: "route-ends", type: "circle", source: "route", filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 7, "circle-color": "#ff4fd8", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "route-labels", type: "symbol", source: "route", filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["get", "label"], "text-font": ["OpenSansBold"], "text-size": 14, "text-offset": [0, -1.3],
      "text-anchor": "bottom", "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "#03070c", "text-halo-width": 2 } });
}

function bindPlanner() {
  state.route = [];
  $("plan-add").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    e.target.removeAttribute("aria-invalid");
  });
  $("plan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("plan-add").value.trim().toUpperCase();
    if (addWaypoint(code)) $("plan-add").value = "";
  });
  $("plan-undo").addEventListener("click", () => { state.route.pop(); renderRoute(); });
  $("plan-clear").addEventListener("click", clearRoute);
  const qs = new URLSearchParams(location.search);
  const via = qs.get("via") || (qs.get("from") && qs.get("to") ? `${qs.get("from")},${qs.get("to")}` : "");
  let restore = via;
  if (!restore) { try { restore = (JSON.parse(localStorage.getItem(CURRENT_KEY) || "null") || {}).icaos?.join(",") || ""; } catch { restore = ""; } }
  if (restore) {
    for (const c of restore.toUpperCase().split(/[,\s-]+/).filter(Boolean)) addWaypoint(c, 0, true);
    renderRoute(0);
  } else renderRoute();
  state.plansReady = true;
  persistCurrent(state.route);
  bindPlans();
}

/* ---------- Saved plans, navlog, schematic ---------- */
const PLANS_KEY = "globemap.plans.v1";     // [{id,name,icaos,created,updated,totalNm}]
const CURRENT_KEY = "globemap.current.v1"; // {icaos,updated} — in-progress route

function readPlans() {
  try { const a = JSON.parse(localStorage.getItem(PLANS_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writePlans(list) {
  try { localStorage.setItem(PLANS_KEY, JSON.stringify(list)); return true; }
  catch { saveMsg("Could not save (browser storage full or blocked).", true); return false; }
}
function saveMsg(t, err) { const m = $("plan-save-msg"); m.textContent = t; m.classList.toggle("error", !!err); }

function bindPlans() {
  $("plan-save").addEventListener("click", () => {
    const icaos = state.route.map((p) => p.code);
    if (icaos.length < 2) { saveMsg("Add at least two airports before saving.", true); return; }
    const name = $("plan-name").value.trim() || icaos.join("-");
    const list = readPlans();
    const now = new Date().toISOString();
    const same = list.find((p) => p.name === name);
    if (same && !confirm(`Overwrite saved plan "${name}"?`)) return;
    const entry = { id: same ? same.id : `p${Date.now().toString(36)}`, name, icaos, created: same ? same.created : now, updated: now, totalNm: Number(document.body.dataset.routeNm) };
    if (same) Object.assign(same, entry); else list.unshift(entry);
    if (writePlans(list)) { saveMsg(`Saved "${name}".`); $("plan-name").value = ""; renderSaved(); $("saved-wrap").open = true; }
  });
  $("saved-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const list = readPlans();
    const plan = list.find((p) => p.id === btn.dataset.id);
    if (!plan) return;
    if (btn.dataset.act === "load") {
      state.route = [];
      const missing = [];
      for (const c of plan.icaos) if (!state.airports.get(c)) missing.push(c); else addWaypoint(c, 0, true);
      renderRoute();
      $("plan-name").value = plan.name;
      saveMsg(missing.length ? `Loaded "${plan.name}" — not found: ${missing.join(", ")}.` : `Loaded "${plan.name}".`, missing.length > 0);
    } else if (btn.dataset.act === "overwrite") {
      const icaos = state.route.map((p) => p.code);
      if (icaos.length < 2) { saveMsg("Current route is empty — nothing to overwrite with.", true); return; }
      if (!confirm(`Replace "${plan.name}" (${plan.icaos.join("-")}) with ${icaos.join("-")}?`)) return;
      Object.assign(plan, { icaos, updated: new Date().toISOString(), totalNm: Number(document.body.dataset.routeNm) });
      if (writePlans(list)) { saveMsg(`Overwrote "${plan.name}".`); renderSaved(); }
    } else if (btn.dataset.act === "delete") {
      if (!confirm(`Delete saved plan "${plan.name}"?`)) return;
      if (writePlans(list.filter((p) => p.id !== plan.id))) { saveMsg(`Deleted "${plan.name}".`); renderSaved(); }
    }
  });
  $("plan-print").addEventListener("click", printNavlog);
  window.addEventListener("afterprint", () => { $("print-sheet").innerHTML = ""; });
  renderSaved();
}

function renderSaved() {
  const list = readPlans();
  $("saved-count").textContent = `(${list.length})`;
  $("saved-list").innerHTML = list.length ? list.map((p) => `<li><div class="sp-name">${esc(p.name)}</div>
    <div class="sp-meta">${esc(p.icaos.join(" → "))}${Number.isFinite(p.totalNm) ? ` · ${p.totalNm.toLocaleString()} NM` : ""} · ${esc(new Date(p.updated).toLocaleDateString())}</div>
    <div class="sp-btns"><button type="button" data-act="load" data-id="${esc(p.id)}">Load</button><button type="button" data-act="overwrite" data-id="${esc(p.id)}">Overwrite</button><button type="button" data-act="delete" data-id="${esc(p.id)}" class="danger">Delete</button></div></li>`).join("")
    : `<li class="sp-empty">No saved plans yet.</li>`;
}

function persistCurrent(pts) {
  try {
    if (pts.length) localStorage.setItem(CURRENT_KEY, JSON.stringify({ icaos: pts.map((p) => p.code), updated: new Date().toISOString() }));
    else localStorage.removeItem(CURRENT_KEY);
  } catch { /* storage unavailable */ }
  try {
    const url = new URL(location.href);
    url.searchParams.delete("from"); url.searchParams.delete("to");
    if (pts.length) url.searchParams.set("via", pts.map((p) => p.code).join(",")); else url.searchParams.delete("via");
    history.replaceState(history.state, "", url.pathname + (url.search ? url.search.replace(/%2C/g, ",") : "") + url.hash);
  } catch { /* ignore */ }
}

function navlogHtml(pts, legs) {
  if (legs.length === 0) return `<p class="nl-empty">Add two or more airports to see the navlog.</p>`;
  const total = legs.reduce((s, l) => s + l.m, 0);
  let cum = 0;
  const rows = legs.map((l, i) => {
    cum += l.m;
    return `<tr><td>${i + 1}</td><td><b>${esc(l.a.code)}</b><small>${esc(l.a.name || "")}</small></td><td><b>${esc(l.b.code)}</b><small>${esc(l.b.name || "")}</small></td>
      <td class="num">${String(l.crs).padStart(3, "0")}°T</td><td class="num">${l.nm.toLocaleString()}</td><td class="num">${Math.round(cum / 1852).toLocaleString()}</td><td class="num">${Math.round((total - cum) / 1852).toLocaleString()}</td></tr>`;
  }).join("");
  return `<table class="navlog"><thead><tr><th>Leg</th><th>From</th><th>To</th><th class="num">Crs</th><th class="num">NM</th><th class="num">Cum</th><th class="num">Rem</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="4">Total · ${legs.length} leg${legs.length > 1 ? "s" : ""}</td><td class="num">${Math.round(total / 1852).toLocaleString()}</td><td colspan="2"></td></tr></tfoot></table>
    <p class="nl-note">Course = initial great-circle true course. Great-circle distance, not airways. Sim use only.</p>`;
}

/* Schematic: airports evenly spaced in a vertical strip, each leg labelled with course and NM. */
function schematicSvg(pts, legs) {
  if (legs.length === 0) return "";
  const step = 56, w = 300, x = 36, top = 20, h = top * 2 + step * (pts.length - 1);
  let g = "";
  legs.forEach((l, i) => {
    const y1 = top + i * step, y2 = y1 + step;
    g += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" class="sc-leg"/>`;
    g += `<text x="${x + 18}" y="${(y1 + y2) / 2 + 4}" class="sc-lab">Leg ${i + 1} · ${String(l.crs).padStart(3, "0")}°T · ${l.nm.toLocaleString()} NM</text>`;
    // arrow showing course direction
    const r = (l.crs * Math.PI) / 180, cx = x, cy = (y1 + y2) / 2;
    g += `<g transform="translate(${cx},${cy}) rotate(${l.crs})"><path d="M0,-7 L4,4 L0,2 L-4,4 Z" class="sc-arrow"/></g>`;
    void r;
  });
  pts.forEach((p, i) => {
    const y = top + i * step;
    g += `<circle cx="${x}" cy="${y}" r="6" class="sc-pt${i === 0 || i === pts.length - 1 ? " sc-end" : ""}"/>`;
    g += `<text x="${x + 14}" y="${y + 4}" class="sc-code">${esc(p.code)}</text>`;
    g += `<text x="${x + 58}" y="${y + 4}" class="sc-name">${esc((p.name || "").slice(0, 30))}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Schematic of ${esc(pts.map((p) => p.code).join(" to "))}">${g}</svg>`;
}

function printNavlog() {
  if (state.route.length < 2) { saveMsg("Add at least two airports to print a navlog.", true); return; }
  const title = $("plan-name").value.trim() || state.route.map((p) => p.code).join("-");
  $("print-sheet").innerHTML = `<h1>GlobeMap navlog — ${esc(title)}</h1><p>Printed ${esc(new Date().toUTCString())}</p>${$("navlog").innerHTML}<div class="print-sc">${$("schematic").innerHTML}</div>`;
  window.print();
}

function planOut(html, isError) {
  const out = $("plan-out");
  out.innerHTML = html;
  out.classList.toggle("error", !!isError);
}

function addWaypoint(code, duration, quiet) {
  const apt = state.airports.get(code);
  if (!code) { planOut("Type a 4-letter ICAO code, or click an airport.", true); return false; }
  if (!apt) {
    $("plan-add").setAttribute("aria-invalid", "true");
    planOut(`${esc(code)} not found. Use a 4-letter ICAO code from the airport list.`, true);
    document.body.dataset.routeError = code;
    return false;
  }
  delete document.body.dataset.routeError;
  const last = state.route[state.route.length - 1];
  if (last && last.code === apt.code) { if (!quiet) renderRoute(null); return false; }
  state.route.push(apt);
  if (!quiet) renderRoute(duration);
  return true;
}

function renderRoute(duration) {
  const pts = state.route;
  const features = [];
  const legs = [];
  let all = [];
  let offset = 0; // keep longitudes continuous across sectors
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const gc = greatCircle([a.lng, a.lat], [b.lng, b.lat]);
    let coords = gc.coordinates;
    if (all.length) {
      const prevLng = all[all.length - 1][0];
      const k = Math.round((prevLng - coords[0][0]) / 360) * 360;
      coords = coords.map(([x, y]) => [x + k, y]);
    }
    all = all.concat(coords);
    features.push(lineFeature(coords, { kind: "route", leg: i }));
    legs.push({ a, b, nm: Math.round(gc.meters / 1852), m: gc.meters, crs: Math.round(initialCourse([a.lng, a.lat], [b.lng, b.lat])) % 360 });
  }
  pts.forEach((p, i) => features.push({ type: "Feature", properties: { label: p.code, idx: i },
    geometry: { type: "Point", coordinates: [p.lng, p.lat] } }));
  state.map.getSource("route").setData({ type: "FeatureCollection", features });
  const totalNm = Math.round(legs.reduce((s, l) => s + l.m, 0) / 1852);
  if (!pts.length) {
    planOut("Click airports on the globe or type ICAO codes to build a route.");
  } else {
    const chain = pts.map((p) => esc(p.code)).join(" → ");
    const rows = legs.map((l, i) => `<li><span>${i + 1}. ${esc(l.a.code)} → ${esc(l.b.code)}</span><b>${l.nm.toLocaleString()} NM</b></li>`).join("");
    const hint = pts.length === 1 ? `<br>Departure ${esc(pts[0].name)}. Add the next airport.` : "";
    planOut(`<div class="chain">${chain}</div>${rows ? `<ol class="legs">${rows}</ol><div class="total">Total <strong>${totalNm.toLocaleString()} NM</strong> · ${legs.length} sector${legs.length > 1 ? "s" : ""} · great circle</div>` : ""}${hint}`);
  }
  $("plan-clear").hidden = !pts.length;
  $("plan-undo").disabled = !pts.length;
  document.body.dataset.route = pts.map((p) => p.code).join("-");
  document.body.dataset.routeNm = String(totalNm);
  document.body.dataset.legsNm = legs.map((l) => l.nm).join(",");
  $("navlog").innerHTML = navlogHtml(pts, legs);
  $("schematic").innerHTML = schematicSvg(pts, legs);
  if (state.plansReady) persistCurrent(pts);
  if (duration !== null && all.length) fitRoute(all, duration);
  else if (duration !== null && pts.length === 1 && duration === 0) fitRoute([[pts[0].lng, pts[0].lat]], 0);
}

function fitRoute(coords, duration) {
  // Coordinates are unwrapped (continuous longitude), so a simple min/max box
  // is correct even across the antimeridian.
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [x, y] of coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1400;
  const cam = state.map.cameraForBounds([[w, s], [e, n]], { padding: 60, maxZoom: 6 });
  if (!cam) return;
  let lng = cam.center.lng;
  lng = ((lng + 540) % 360) - 180;
  state.map.flyTo({ center: [lng, cam.center.lat], zoom: Math.max(1, cam.zoom), bearing: 0, pitch: 0,
    duration: duration === undefined ? motion : duration, essential: true });
}

function clearRoute() {
  state.route = [];
  renderRoute(null);
}

const DAY_STYLE = {
  background: "#0c3144",
  land: { Africa: "#1c4a40", Europe: "#24584c", Asia: "#1a463e", "North America": "#1e5248", "South America": "#18483e", Oceania: "#1d4e44", Antarctica: "#243844", other: "#1b4a40" },
  landLine: ["#3e7568", 0.85],
  grid: ["#1d4d63", 0.8],
  gridMajor: ["#2f6d84", 0.9],
  nightFill: 0.55,
  sky: { "sky-color": "#07111a", "horizon-color": "#b7d0dc", "fog-color": "#07111a", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.45, "fog-ground-blend": 0.2, "atmosphere-blend": 0.9 },
};

const NIGHT_STYLE = {
  background: "#040b14",
  land: { Africa: "#111c26", Europe: "#15222e", Asia: "#101a24", "North America": "#13202b", "South America": "#0f1a23", Oceania: "#121e29", Antarctica: "#1a2430", other: "#111c26" },
  landLine: ["#4fa3c4", 0.4],
  grid: ["#0d1f2e", 0.6],
  gridMajor: ["#163247", 0.7],
  nightFill: 0.62,
  sky: { "sky-color": "#000206", "horizon-color": "#1f4a66", "fog-color": "#000206", "sky-horizon-blend": 0.35, "horizon-fog-blend": 0.3, "fog-ground-blend": 0.15, "atmosphere-blend": 0.6 },
};

function applyNightMode() {
  const map = state.map;
  const on = $("tog-nightmode").checked;
  document.body.classList.toggle("night-mode", on);
  if (!map) return;
  const st = on ? NIGHT_STYLE : DAY_STYLE;
  const set = (layer, prop, value) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  set("background", "background-color", st.background);
  const l = st.land;
  set("land-fill", "fill-color", [
    "match", ["get", "continent"],
    "Africa", l.Africa, "Europe", l.Europe, "Asia", l.Asia,
    "North America", l["North America"], "South America", l["South America"],
    "Oceania", l.Oceania, "Antarctica", l.Antarctica, l.other,
  ]);
  set("land-line", "line-color", st.landLine[0]);
  set("land-line", "line-opacity", st.landLine[1]);
  set("graticule", "line-color", st.grid[0]);
  set("graticule", "line-opacity", st.grid[1]);
  set("graticule-major", "line-color", st.gridMajor[0]);
  set("graticule-major", "line-opacity", st.gridMajor[1]);
  set("night-fill", "fill-opacity", st.nightFill);
  map.setSky(st.sky);
}
