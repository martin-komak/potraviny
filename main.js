const MAX_QUERY_DISTANCE_METERS = 2000;

const typeLabels = {
  supermarket: "supermarket",
  convenience: "potraviny",
  greengrocer: "ovocie a zelenina",
  organic: "bio obchod",
  farm: "farmarsky predaj",
};

const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true,
});

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const shopLayer = L.layerGroup().addTo(map);

const distanceFilter = document.querySelector("#distanceFilter");
const reloadButton = document.querySelector("#reloadButton");
const routeLengthText = document.querySelector("#routeLength");
const shopCountText = document.querySelector("#shopCount");
const statusText = document.querySelector("#statusText");
const shopList = document.querySelector("#shopList");
const shopSummary = document.querySelector("#shopSummary");

const state = {
  routeSegments: [],
  routeBounds: null,
  routeLengthMeters: 0,
  allShopCandidates: [],
  filteredShops: [],
};

distanceFilter.addEventListener("change", () => {
  filterAndRenderShops();
});

reloadButton.addEventListener("click", () => {
  loadMapData();
});

loadMapData();

async function loadMapData() {
  try {
    reloadButton.disabled = true;
    setStatus("Nacitavam lokalne OSM data trasy a potravin...");

    const routeData = await fetchJson("./data/route.json");
    const shopData = await fetchJson("./data/shops.json", []);
    const routeInfo = extractRoute(routeData);

    state.routeSegments = routeInfo.segments;
    state.routeBounds = routeInfo.bounds;
    state.routeLengthMeters = calculateRouteLength(routeInfo.segments);

    drawRoute(routeInfo.segments, routeInfo.bounds);
    routeLengthText.textContent = formatDistance(state.routeLengthMeters);
    state.allShopCandidates = extractShops(shopData);

    filterAndRenderShops();
    setStatus(state.allShopCandidates.length
      ? `Hotovo. Trasa a ${state.filteredShops.length} potravin su zobrazene na mape.`
      : "Trasa je zobrazena. Snapshot potravin zatial nie je k dispozicii, spusti alebo dokonci fetch_data.py.");
  } catch (error) {
    console.error(error);
    setStatus(
      "Nepodarilo sa nacitat lokalne data mapy. Skontroluj subory v priecinku data/."
    );
  } finally {
    reloadButton.disabled = false;
  }
}

async function fetchJson(url, fallbackValue) {
  const response = await fetch(url);

  if (response.status === 404 && fallbackValue !== undefined) {
    return fallbackValue;
  }

  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }

  return response.json();
}

function extractRoute(data) {
  const segments = Array.isArray(data?.segments)
    ? data.segments.filter((segment) => Array.isArray(segment) && segment.length > 1)
    : [];

  if (!segments.length) {
    throw new Error("No route segments were found.");
  }

  const allPoints = segments.flat();
  const bounds = L.latLngBounds(allPoints);

  return { segments, bounds };
}

function drawRoute(segments, bounds) {
  routeLayer.clearLayers();

  segments.forEach((segment) => {
    L.polyline(segment, {
      color: "#b33b24",
      weight: 3.5,
      opacity: 0.85,
    }).addTo(routeLayer);
  });

  map.fitBounds(bounds, {
    padding: [24, 24],
  });
}

function extractShops(data) {
  if (Array.isArray(data)) {
    return data;
  }

  const seen = new Set();
  const shops = [];

  (data.elements || []).forEach((element) => {
    const location =
      element.type === "node"
        ? [element.lat, element.lon]
        : element.center
          ? [element.center.lat, element.center.lon]
          : null;

    if (!location) {
      return;
    }

    const name = element.tags?.name?.trim() || "Bez nazvu";
    const key = `${name}|${location[0].toFixed(4)}|${location[1].toFixed(4)}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    shops.push({
      id: element.id,
      name,
      type: element.tags?.shop || "shop",
      village:
        element.tags?.["addr:city"] ||
        element.tags?.["addr:town"] ||
        element.tags?.["addr:village"] ||
        element.tags?.["addr:hamlet"] ||
        element.tags?.["addr:suburb"] ||
        "",
      lat: location[0],
      lon: location[1],
    });
  });

  return shops;
}

function filterAndRenderShops() {
  const maxDistanceMeters = Number(distanceFilter.value);

  state.filteredShops = state.allShopCandidates
    .map((shop) => {
      const distance = getRouteDistanceMeters(shop, state.routeSegments);
      return { ...shop, distance };
    })
    .filter((shop) => shop.distance <= maxDistanceMeters)
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));

  drawShops(state.filteredShops);
  renderShopList(state.filteredShops, maxDistanceMeters);
  shopCountText.textContent = String(state.filteredShops.length);
}

function drawShops(shops) {
  shopLayer.clearLayers();

  shops.forEach((shop) => {
    const marker = L.circleMarker([shop.lat, shop.lon], {
      radius: 5.5,
      color: "#7d4f11",
      weight: 1,
      fillColor: "#f0b462",
      fillOpacity: 0.95,
    });

    marker.bindPopup(`
      <h3 class="popup-title">${escapeHtml(shop.name)}</h3>
      <div>${escapeHtml(typeLabels[shop.type] || shop.type)}</div>
      <div>Vzdialenost od trasy: ${formatDistance(shop.distance)}</div>
      ${shop.village ? `<div>${escapeHtml(shop.village)}</div>` : ""}
    `);

    marker.addTo(shopLayer);
  });
}

function renderShopList(shops, maxDistanceMeters) {
  if (!shops.length) {
    shopSummary.textContent = `do ${formatDistance(maxDistanceMeters)}`;
    shopList.innerHTML = "<p class=\"muted-text\">V tomto pasme som nenasiel ziadne OSM potraviny.</p>";
    return;
  }

  shopSummary.textContent = `${shops.length} objektov do ${formatDistance(maxDistanceMeters)}`;
  shopList.innerHTML = "";

  shops.forEach((shop) => {
    const item = document.createElement("article");
    item.className = "shop-item";

    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `
      <span class="shop-name">${escapeHtml(shop.name)}</span>
      <span class="shop-meta">${escapeHtml(typeLabels[shop.type] || shop.type)} • ${formatDistance(shop.distance)}${shop.village ? ` • ${escapeHtml(shop.village)}` : ""}</span>
    `;

    button.addEventListener("click", () => {
      map.setView([shop.lat, shop.lon], 14, { animate: true });
    });

    item.appendChild(button);
    shopList.appendChild(item);
  });
}

function getRouteDistanceMeters(shop, segments) {
  let best = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      const current = segment[index];
      const next = segment[index + 1];
      const distance = pointToSegmentDistanceMeters(shop, current, next);

      if (distance < best) {
        best = distance;
      }
    }
  }

  return best;
}

function pointToSegmentDistanceMeters(point, segmentStart, segmentEnd) {
  const referenceLat = (point.lat + segmentStart[0] + segmentEnd[0]) / 3;
  const projectedPoint = projectMeters(point.lat, point.lon, referenceLat);
  const projectedStart = projectMeters(segmentStart[0], segmentStart[1], referenceLat);
  const projectedEnd = projectMeters(segmentEnd[0], segmentEnd[1], referenceLat);

  const deltaX = projectedEnd.x - projectedStart.x;
  const deltaY = projectedEnd.y - projectedStart.y;
  const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (segmentLengthSquared === 0) {
    return Math.hypot(projectedPoint.x - projectedStart.x, projectedPoint.y - projectedStart.y);
  }

  const rawProjection =
    ((projectedPoint.x - projectedStart.x) * deltaX +
      (projectedPoint.y - projectedStart.y) * deltaY) /
    segmentLengthSquared;
  const projection = Math.max(0, Math.min(1, rawProjection));
  const closestX = projectedStart.x + projection * deltaX;
  const closestY = projectedStart.y + projection * deltaY;

  return Math.hypot(projectedPoint.x - closestX, projectedPoint.y - closestY);
}

function projectMeters(lat, lon, referenceLat) {
  const radians = (referenceLat * Math.PI) / 180;

  return {
    x: lon * 111320 * Math.cos(radians),
    y: lat * 110540,
  };
}

function calculateRouteLength(segments) {
  let total = 0;

  segments.forEach((segment) => {
    for (let index = 0; index < segment.length - 1; index += 1) {
      total += L.latLng(segment[index]).distanceTo(segment[index + 1]);
    }
  });

  return total;
}

function formatDistance(distanceMeters) {
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(distanceMeters >= 10000 ? 0 : 1)} km`;
  }

  return `${Math.round(distanceMeters)} m`;
}

function setStatus(message) {
  statusText.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}