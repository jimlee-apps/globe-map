import * as maplibregl from "../vendor/maplibre/maplibre-gl.mjs";
import { formatLat, formatLng, subsolarPoint } from "./solar.js";
import { buildTerminator } from "./terminator.js";

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
    zoom: 1.2,
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
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
  map.on("error", (event) => {
    const message = event && event.error ? String(event.error.message || event.error) : "Map error";
    console.error(message);
    if (!document.body.dataset.ready && /WebGL|Failed to initialize/i.test(message)) fail(message);
  });

  map.on("load", async () => {
    try {
      map.setProjection({ type: "globe" });
      map.setSky({
        "sky-color": "#07111a",
        "horizon-color": "#b7d0dc",
        "fog-color": "#07111a",
        "sky-horizon-blend": 0.55,
        "horizon-fog-blend": 0.45,
        "fog-ground-blend": 0.2,
        "atmosphere-blend": 0.9,
      });
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
      bindMapClicks(map);
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
    filter: ["==", ["get", "type"], "large_airport"],
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
    filter: ["==", ["get", "type"], "large_airport"],
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
    const present = ["airport-dots-large", "airport-dots-medium", "fir-fill"].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    if (!present.length) return;
    const hits = map.queryRenderedFeatures(event.point, { layers: present });
    if (!hits.length) return;
    const feature = hits[0];
    const props = feature.properties || {};
    const html = feature.layer.id.startsWith("airport")
      ? airportPopup(props)
      : firPopup(props);
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(event.lngLat)
      .setHTML(html)
      .addTo(map);
  });
  map.on("mousemove", (event) => {
    const present = ["airport-dots-large", "airport-dots-medium", "fir-fill"].filter((id) => map.getLayer(id));
    const hits = present.length ? map.queryRenderedFeatures(event.point, { layers: present }) : [];
    map.getCanvas().style.cursor = hits.length ? "pointer" : "";
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
  for (const id of ["tog-fir", "tog-labels", "tog-airports", "tog-night", "tog-grid"]) {
    $(id).addEventListener("change", () => {
      savePrefs();
      applyVisibility();
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
    zoom: 1.2,
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
