const minScale = 700;
const maxScale = 100000;
const defaultBounds = [-122.52, 37.68, -122.35, 37.82];
const VIEW_BOUNDS = defaultBounds.slice();

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d", { alpha: false });

let streetPath2D = null;
let pathPath2D = null;
let nbdOutlinesPath2D = null;
let nbds = [];
let nbdFeats = [];
let roadLabels = [];
let hoverNbd = null;
let photoList = [];
let hoverPhoto = null;

function isCoarsePointer() {
  return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}

let photoTooltipEl = null;
let hoverPhotoPinEl = null;

function getPhotoTooltipEl() {
  if (photoTooltipEl) return photoTooltipEl;
  const tip = document.createElement("div");
  tip.id = "photoTooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  const shadow = document.createElement("span");
  shadow.className = "photo-tooltip-shadow";
  shadow.setAttribute("aria-hidden", "true");
  const inner = document.createElement("span");
  inner.className = "photo-tooltip-inner";
  const img = document.createElement("img");
  img.alt = "";
  const dateSpan = document.createElement("span");
  dateSpan.className = "photo-tooltip-date";
  const coordsSpan = document.createElement("span");
  coordsSpan.className = "photo-tooltip-coords";
  inner.append(img, dateSpan, coordsSpan);
  tip.append(shadow, inner);
  photoTooltipEl = tip;
  return photoTooltipEl;
}

function positionPhotoTooltip() {
  const tip = getPhotoTooltipEl();
  if (!tip || tip.getAttribute("aria-hidden") === "true" || !hoverPhotoPinEl) return;
  const r = hoverPhotoPinEl.getBoundingClientRect();
  tip.style.left = r.left + r.width / 2 + "px";
  tip.style.top = r.top + "px";
  tip.style.transform = "translate3d(-50%, calc(-100% - 8px), 0)";
}

function showPhotoTooltip(photo, pinEl) {
  const tip = getPhotoTooltipEl();
  const img = tip ? tip.querySelector("img") : null;
  if (!tip || !img || !photo || !pinEl) return;
  hoverPhoto = photo;
  hoverPhotoPinEl = pinEl;
  img.src = photo.thumb_url;
  img.alt = "Photo at location";
  const dateEl = tip.querySelector(".photo-tooltip-date");
  const coordsEl = tip.querySelector(".photo-tooltip-coords");
  if (dateEl) dateEl.textContent = photo.date || "";
  if (coordsEl && typeof photo.lat === "number" && typeof photo.lon === "number") {
    coordsEl.textContent = photo.lat.toFixed(5) + ", " + photo.lon.toFixed(5);
  } else if (coordsEl) {
    coordsEl.textContent = "";
  }
  tip.remove();
  document.body.appendChild(tip);
  tip.setAttribute("aria-hidden", "false");
  positionPhotoTooltip();
  img.onload = img.onerror = function () {
    positionPhotoTooltip();
  };
}

function hidePhotoTooltip() {
  hoverPhoto = null;
  hoverPhotoPinEl = null;
  const tip = getPhotoTooltipEl();
  if (tip) {
    tip.setAttribute("aria-hidden", "true");
    tip.style.left = "";
    tip.style.top = "";
    tip.style.transform = "";
    const dateEl = tip.querySelector(".photo-tooltip-date");
    const coordsEl = tip.querySelector(".photo-tooltip-coords");
    if (dateEl) dateEl.textContent = "";
    if (coordsEl) coordsEl.textContent = "";
    tip.remove();
  }
}
let lineScale = 1;

const LABEL_MIN_SCALE = 40000;
const LABEL_LOD_HIGH_ZOOM = 60000;
const LABEL_MIN_LENGTH_DEG = 0.008;
const LABEL_CLASH_PAD = 4;
const LABEL_PUSH_STEP_PX = 24;
const LABEL_PUSH_ATTEMPTS = 5;
let scale = 0.5,
  tx = 0,
  ty = 0,
  angle = 0;
let dpr = 1;
let bounds = null;
let drag = null;
let drawScheduled = false;
let zoomTarget = null;
let dimTimeout = null;

const activePointers = new Map();
let twoFingerState = null;
const ROTATE_ANGLE_THRESHOLD = 0.035;
const ROTATE_VS_ZOOM_RATIO = 2;
let compassDrag = false;
const NBD_TOOLTIP_DELAY_MS = 140;
let nbdTooltipDelayTimeout = null;

function markViewChanged() {
  document.getElementById("scale")?.classList.remove("scale-dimmed");
  document.getElementById("ruler")?.classList.remove("ruler-hidden");

  if (dimTimeout) {
    clearTimeout(dimTimeout);
  }

  dimTimeout = setTimeout(() => {
    dimTimeout = null;
    const el = document.getElementById("scale");
    const r = document.getElementById("ruler");
    if (el) el.classList.add("scale-dimmed");
    if (r) r.classList.add("ruler-hidden");
  }, 500);
}

function validBounds(b) {
  if (!b || b.length !== 4) {
    return false;
  }
  const [minLon, minLat, maxLon, maxLat] = b;
  if (maxLon - minLon <= 0 || maxLat - minLat <= 0) {
    return false;
  }
  if (maxLon - minLon > 10 || maxLat - minLat > 10) {
    return false;
  }
  if (minLon < -123 || maxLon > -122 || minLat < 37 || maxLat > 38) {
    return false;
  }
  return true;
}

function scheduleDraw() {
  if (drawScheduled) {
    return;
  }
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    draw();
  });
}

function isNarrowViewport() {
  return window.innerWidth <= 768;
}

// On mobile, layout clientHeight can stay "full window" while visualViewport.height is shorter because of the URL bar.
// Prefer the visual viewport when it is shorter than the layout box.
function getCanvasCssSize() {
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;
  const vv = window.visualViewport;
  if (vv && vv.height > 0 && h > vv.height + 0.5) {
    h = vv.height;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function ensureCanvasBitmapMatchesCSS() {
  const rawDpr = window.devicePixelRatio || 1;
  const nextDpr = isNarrowViewport() ? Math.min(rawDpr, 2) : rawDpr;
  const { w, h } = getCanvasCssSize();
  if (canvas.width === w * nextDpr && canvas.height === h * nextDpr && dpr === nextDpr) {
    return false;
  }
  dpr = nextDpr;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return true;
}

function resize() {
  const rawDpr = window.devicePixelRatio || 1;
  dpr = isNarrowViewport() ? Math.min(rawDpr, 2) : rawDpr;
  const { w, h } = getCanvasCssSize();
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  scheduleDraw();
}

function minScaleForZoomOut() {
  const { w, h } = getCanvasCssSize();
  const viewW = VIEW_BOUNDS[2] - VIEW_BOUNDS[0];
  const viewH = VIEW_BOUNDS[3] - VIEW_BOUNDS[1];
  const viewSpan = Math.max(viewW, viewH);
  if (viewSpan <= 0) return minScale;
  const fit = Math.min(w, h) / viewSpan;
  return Math.max(fit, minScale);
}

function scaleFloor() {
  const minScaleOut = minScaleForZoomOut();
  const effectiveMin = isNarrowViewport() ? 1100 : minScale;
  return Math.max(minScaleOut, effectiveMin);
}

function clampView() {
  const { w, h } = getCanvasCssSize();
  const floor = scaleFloor();
  scale = Math.max(floor, Math.min(maxScale, scale));

  const contentCenter = canvasToContent(w / 2, h / 2, w, h);
  let centerLon = (contentCenter.x - tx) / scale;
  let centerLat = (ty - contentCenter.y) / scale;
  centerLon = Math.max(VIEW_BOUNDS[0], Math.min(VIEW_BOUNDS[2], centerLon));
  centerLat = Math.max(VIEW_BOUNDS[1], Math.min(VIEW_BOUNDS[3], centerLat));
  tx = contentCenter.x - centerLon * scale;
  ty = contentCenter.y + centerLat * scale;
}

function fit() {
  angle = 0;
  const b = bounds || defaultBounds;
  const pad = 40;
  const css = getCanvasCssSize();
  const w = css.w - pad * 2,
    h = css.h - pad * 2;
  if (w <= 0 || h <= 0) {
    return;
  }
  const [minLon, minLat, maxLon, maxLat] = b;
  const rw = maxLon - minLon,
    rh = maxLat - minLat;
  if (rw <= 0 || rh <= 0) {
    return;
  }
  let s = Math.min(w / rw, h / rh);
  const floor = scaleFloor();
  scale = Math.min(maxScale, Math.max(floor, s));
  const cx = css.w / 2,
    cy = css.h / 2;
  const midLon = (minLon + maxLon) / 2,
    midLat = (minLat + maxLat) / 2;
  tx = cx - midLon * scale;
  ty = cy + midLat * scale;
}

function canvasToContent(canvasX, canvasY, w, h) {
  const cx = w / 2,
    cy = h / 2;
  const dx = canvasX - cx,
    dy = canvasY - cy;
  return {
    x: cx + dx * Math.cos(angle) + dy * Math.sin(angle),
    y: cy - dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function contentToCanvas(contentX, contentY, w, h) {
  const cx = w / 2,
    cy = h / 2;
  const dx = contentX - cx,
    dy = contentY - cy;
  return {
    x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: cy + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function unproject(canvasX, canvasY, w, h) {
  const { x, y } = canvasToContent(canvasX, canvasY, w, h);
  return { lon: (x - tx) / scale, lat: (ty - y) / scale };
}

function project(lon, lat) {
  return { x: (lon * scale + tx) * dpr, y: (ty - lat * scale) * dpr };
}

function projectCSS(lon, lat, w, h) {
  const contentX = lon * scale + tx;
  const contentY = ty - lat * scale;
  return contentToCanvas(contentX, contentY, w, h);
}

function pointInPolygon(lon, lat, geom) {
  if (!geom || !geom.coordinates) {
    return false;
  }
  const c = geom.coordinates;
  if (geom.type === "Polygon" && c[0]) {
    return pointInPoly(lon, lat, c[0]);
  }
  if (geom.type === "MultiPolygon") {
    for (let i = 0; i < c.length; i++) {
      if (c[i] && c[i][0] && pointInPoly(lon, lat, c[i][0])) {
        return true;
      }
    }
    return false;
  }
  return false;
}

function nbdAt(lon, lat) {
  for (let i = 0; i < nbdFeats.length; i++) {
    const f = nbdFeats[i];
    if (f._polys && pointInPolys(f._polys, lon, lat)) {
      const name = f.name || (f.properties && f.properties.name);
      return nbds.find((n) => n.name === name) || { name: name || "Unknown" };
    }
  }
  return null;
}

function getPolys(geom) {
  if (!geom || !geom.coordinates) {
    return [];
  }
  const c = geom.coordinates;
  if (geom.type === "Polygon" && c[0]) {
    return [c[0]];
  }
  if (geom.type === "MultiPolygon") {
    const polys = [];
    for (let i = 0; i < c.length; i++) {
      if (c[i] && c[i][0]) {
        polys.push(c[i][0]);
      }
    }
    return polys;
  }
  return [];
}

function pointInPoly(lon, lat, poly) {
  if (!poly || poly.length < 3) {
    return false;
  }
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-20) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolys(polys, lon, lat) {
  if (!polys || polys.length === 0) return false;
  for (let i = 0; i < polys.length; i++) {
    if (pointInPoly(lon, lat, polys[i])) return true;
  }
  return false;
}

function bboxOfCoords(coords) {
  if (!coords || coords.length === 0) {
    return null;
  }
  let minLon = coords[0][0],
    maxLon = coords[0][0],
    minLat = coords[0][1],
    maxLat = coords[0][1];
  for (let i = 1; i < coords.length; i++) {
    const c = coords[i];
    if (c[0] < minLon) {
      minLon = c[0];
    }
    if (c[0] > maxLon) {
      maxLon = c[0];
    }
    if (c[1] < minLat) {
      minLat = c[1];
    }
    if (c[1] > maxLat) {
      maxLat = c[1];
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

function path2DFromPolys(polys) {
  const p = new Path2D();
  for (const poly of polys || []) {
    if (!poly || poly.length < 2) {
      continue;
    }
    p.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) {
      p.lineTo(poly[i][0], poly[i][1]);
    }
    p.closePath();
  }
  return p;
}

function draw() {
  if (zoomTarget) {
    markViewChanged();
    const rate = 0.18;
    scale += (zoomTarget.scale - scale) * rate;
    tx += (zoomTarget.tx - tx) * rate;
    ty += (zoomTarget.ty - ty) * rate;
    if (
      Math.abs(scale - zoomTarget.scale) < 0.5 &&
      Math.abs(tx - zoomTarget.tx) < 0.5 &&
      Math.abs(ty - zoomTarget.ty) < 0.5
    ) {
      scale = zoomTarget.scale;
      tx = zoomTarget.tx;
      ty = zoomTarget.ty;
      zoomTarget = null;
    } else {
      scheduleDraw();
    }
  }
  clampView();
  if (ensureCanvasBitmapMatchesCSS()) {
    scheduleDraw();
    return;
  }
  const { w, h } = getCanvasCssSize();
  const dimStreet = 0.06;
  const dimPath = 0.1;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a1628";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  const cx = w / 2,
    cy = h / 2;
  const cosA = Math.cos(angle),
    sinA = Math.sin(angle);
  const a = scale * cosA,
    b = scale * sinA,
    c = scale * sinA,
    d = -scale * cosA;
  const e = cx + (tx - cx) * cosA - (ty - cy) * sinA;
  const f = cy + (tx - cx) * sinA + (ty - cy) * cosA;
  ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);

  const clipP00 = canvasToContent(0, 0, w, h);
  const clipP0h = canvasToContent(0, h, w, h);
  const clipPw0 = canvasToContent(w, 0, w, h);
  const clipPwh = canvasToContent(w, h, w, h);
  const clipMinX = Math.min(clipP00.x, clipP0h.x, clipPwh.x, clipPw0.x);
  const clipMaxX = Math.max(clipP00.x, clipP0h.x, clipPwh.x, clipPw0.x);
  const clipMinY = Math.min(clipP00.y, clipP0h.y, clipPwh.y, clipPw0.y);
  const clipMaxY = Math.max(clipP00.y, clipP0h.y, clipPwh.y, clipPw0.y);
  const clipMinLon = (clipMinX - tx) / scale;
  const clipMaxLon = (clipMaxX - tx) / scale;
  const clipMinLat = (ty - clipMaxY) / scale;
  const clipMaxLat = (ty - clipMinY) / scale;
  const clipPad = Math.max(2 / scale, 0.0001);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    clipMinLon - clipPad,
    clipMinLat - clipPad,
    clipMaxLon - clipMinLon + 2 * clipPad,
    clipMaxLat - clipMinLat + 2 * clipPad,
  );
  ctx.clip();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  lineScale =
    isNarrowViewport() ||
    (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
      ? 0.72
      : 1;
  ctx.lineWidth = (1 / scale) * lineScale;

  const hoverFeat = hoverNbd
    ? nbdFeats.find((x) => (x.name || (x.properties && x.properties.name)) === hoverNbd)
    : null;

  drawStreetsBatched(dimStreet, hoverFeat);
  drawPathsBatched(dimPath, hoverFeat);
  drawNbdOutlines(hoverFeat);
  drawNbdHoverOutline(hoverFeat);
  drawRoadLabels(w, h, hoverFeat);

  ctx.restore();
  updateRuler(w, h);
  updateScaleBar(w, h);
  updatePhotoPins();
  const compass = document.getElementById("compass");
  if (compass) {
    compass.style.transform = "rotate(" + angle * (180 / Math.PI) + "deg)";
  }
}

function updateScaleBar(w, h) {
  const METERS_PER_DEG_LAT = 111320;
  const metersPerPixel = METERS_PER_DEG_LAT / scale;
  const targetBarPx = isNarrowViewport() ? 50 : 100;
  const targetM = targetBarPx * metersPerPixel;
  const niceM = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  let bestM = niceM[0];
  for (let i = 0; i < niceM.length; i++) {
    if (niceM[i] <= targetM * 1.8) bestM = niceM[i];
  }
  const barPx = Math.round(bestM / metersPerPixel);
  const label = bestM >= 1000 ? bestM / 1000 + " km" : bestM + " m";
  const barEl = document.getElementById("scaleBar");
  const labelEl = document.getElementById("scaleLabel");
  if (barEl && labelEl) {
    barEl.style.width = barPx + "px";
    labelEl.textContent = label;
  }
}

const RULER_NICE_STEPS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
const RULER_LEFT_INSET = 30;
const RULER_BOTTOM_INSET = 25;

function pickRulerStep(span, rulerSizePx) {
  if (span <= 0) {
    return 0.01;
  }
  let step = RULER_NICE_STEPS[0];
  const threshold = rulerSizePx >= 768 ? span / 4 : span / 3;
  for (const candidate of RULER_NICE_STEPS) {
    if (candidate <= threshold) step = candidate;
  }
  return step;
}

function formatCoord(value, step) {
  if (step >= 0.1) {
    return value.toFixed(1);
  }
  if (step >= 0.01) {
    return value.toFixed(2);
  }
  if (step >= 0.001) {
    return value.toFixed(3);
  }
  if (step >= 0.0001) {
    return value.toFixed(4);
  }
  return value.toFixed(5);
}

function updateRuler(w, h) {
  const p00 = canvasToContent(0, 0, w, h);
  const p0h = canvasToContent(0, h, w, h);
  const pw0 = canvasToContent(w, 0, w, h);
  const pwh = canvasToContent(w, h, w, h);
  const minContentX = Math.min(p00.x, p0h.x, pwh.x, pw0.x);
  const maxContentX = Math.max(p00.x, p0h.x, pwh.x, pw0.x);
  const minContentY = Math.min(p00.y, p0h.y, pwh.y, pw0.y);
  const maxContentY = Math.max(p00.y, p0h.y, pwh.y, pw0.y);
  const minLon = (minContentX - tx) / scale;
  const maxLon = (maxContentX - tx) / scale;
  const minLat = (ty - maxContentY) / scale;
  const maxLat = (ty - minContentY) / scale;
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  const stepLon = pickRulerStep(spanLon, w - RULER_LEFT_INSET);
  const stepLat = pickRulerStep(spanLat, h - RULER_BOTTOM_INSET);

  const latLabelsEl = document.getElementById("rulerLatLabels");
  const lonLabelsEl = document.getElementById("rulerLonLabels");
  const latAxisEl = document.getElementById("rulerLat");
  const lonAxisEl = document.getElementById("rulerLon");
  if (!latLabelsEl || !lonLabelsEl) {
    return;
  }

  latLabelsEl.textContent = "";
  lonLabelsEl.textContent = "";
  if (latAxisEl) {
    latAxisEl.querySelectorAll(".ruler-tick").forEach((el) => el.remove());
  }
  if (lonAxisEl) {
    lonAxisEl.querySelectorAll(".ruler-tick").forEach((el) => el.remove());
  }

  const leftX0 = p00.x,
    leftY0 = p00.y,
    leftX1 = p0h.x,
    leftY1 = p0h.y;
  const leftDy = leftY1 - leftY0;
  let lat = Math.ceil(maxLat / stepLat) * stepLat;
  if (lat > maxLat) lat -= stepLat;
  while (lat >= minLat) {
    const contentY = ty - lat * scale;
    if (Math.abs(leftDy) > 1e-10) {
      const t = (contentY - leftY0) / leftDy;
      const contentX = leftX0 + t * (leftX1 - leftX0);
      const canvasPt = contentToCanvas(contentX, contentY, w, h);
      if (canvasPt.x >= -1 && canvasPt.x <= RULER_LEFT_INSET + 1) {
        const span = document.createElement("span");
        span.textContent = formatCoord(lat, stepLat) + " N";
        span.style.top = canvasPt.y + "px";
        latLabelsEl.appendChild(span);
        if (latAxisEl) {
          const tick = document.createElement("div");
          tick.className = "ruler-tick";
          tick.style.top = canvasPt.y + "px";
          latAxisEl.appendChild(tick);
        }
      }
    }
    lat -= stepLat;
  }

  const bottomX0 = p0h.x,
    bottomY0 = p0h.y,
    bottomX1 = pwh.x,
    bottomY1 = pwh.y;
  const bottomDx = bottomX1 - bottomX0;
  let lon = Math.floor(minLon / stepLon) * stepLon;
  if (lon < minLon) lon += stepLon;
  while (lon <= maxLon) {
    const contentX = lon * scale + tx;
    if (Math.abs(bottomDx) > 1e-10) {
      const t = (contentX - bottomX0) / bottomDx;
      const contentY = bottomY0 + t * (bottomY1 - bottomY0);
      const canvasPt = contentToCanvas(contentX, contentY, w, h);
      if (canvasPt.y >= h - RULER_BOTTOM_INSET - 1 && canvasPt.y <= h + 1) {
        const span = document.createElement("span");
        span.textContent = formatCoord(lon, stepLon) + " W";
        span.style.left = canvasPt.x - RULER_LEFT_INSET + "px";
        lonLabelsEl.appendChild(span);
        if (lonAxisEl) {
          const tick = document.createElement("div");
          tick.className = "ruler-tick";
          tick.style.left = canvasPt.x - RULER_LEFT_INSET + "px";
          lonAxisEl.appendChild(tick);
        }
      }
    }
    lon += stepLon;
  }
}

function drawRoadLabels(w, h, hoverFeat) {
  if (scale < LABEL_MIN_SCALE || roadLabels.length === 0) return;
  const p00 = canvasToContent(0, 0, w, h);
  const p0h = canvasToContent(0, h, w, h);
  const pw0 = canvasToContent(w, 0, w, h);
  const pwh = canvasToContent(w, h, w, h);
  const minContentX = Math.min(p00.x, p0h.x, pwh.x, pw0.x);
  const maxContentX = Math.max(p00.x, p0h.x, pwh.x, pw0.x);
  const minContentY = Math.min(p00.y, p0h.y, pwh.y, pw0.y);
  const maxContentY = Math.max(p00.y, p0h.y, pwh.y, pw0.y);
  const minLon = (minContentX - tx) / scale;
  const maxLon = (maxContentX - tx) / scale;
  const minLat = (ty - maxContentY) / scale;
  const maxLat = (ty - minContentY) / scale;
  const padding = 0.0005;
  const labelMinLon = minLon - padding;
  const labelMaxLon = maxLon + padding;
  const labelMinLat = minLat - padding;
  const labelMaxLat = maxLat + padding;
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;

  const showAllLabels = scale >= LABEL_LOD_HIGH_ZOOM;
  const inView = [];
  for (let i = 0; i < roadLabels.length; i++) {
    const lab = roadLabels[i];
    if (lab.maxLon < labelMinLon || lab.minLon > labelMaxLon || lab.maxLat < labelMinLat || lab.minLat > labelMaxLat)
      continue;
    if (!showAllLabels && (lab.length == null || lab.length < LABEL_MIN_LENGTH_DEG)) continue;
    const contentX = lab.midLon * scale + tx;
    const contentY = ty - lab.midLat * scale;
    const canvasPt = contentToCanvas(contentX, contentY, w, h);
    inView.push({ lab, sx: canvasPt.x, sy: canvasPt.y });
  }

  const byName = new Map();
  for (let i = 0; i < inView.length; i++) {
    const v = inView[i];
    const list = byName.get(v.lab.name);
    if (!list) byName.set(v.lab.name, [v]);
    else list.push(v);
  }
  const toDraw = [];
  const centerContentX = (minContentX + maxContentX) / 2;
  const centerContentY = (minContentY + maxContentY) / 2;
  const centerCanvas = contentToCanvas(centerContentX, centerContentY, w, h);
  const cxScreen = centerCanvas.x;
  const cyScreen = centerCanvas.y;
  byName.forEach(function (list) {
    list.sort(function (a, b) {
      const da = (a.sx - cxScreen) * (a.sx - cxScreen) + (a.sy - cyScreen) * (a.sy - cyScreen);
      const db = (b.sx - cxScreen) * (b.sx - cxScreen) + (b.sy - cyScreen) * (b.sy - cyScreen);
      return da - db;
    });
    toDraw.push(list[0]);
  });

  // Hover: dim labels outside hovered nbd. Use JS point-in-polygon so winding is correct.
  const dim = hoverFeat && hoverFeat._polys && hoverFeat._polys.length > 0;
  for (let i = 0; i < toDraw.length; i++) {
    const v = toDraw[i];
    v.inside = dim && pointInPolys(hoverFeat._polys, v.lab.midLon, v.lab.midLat);
  }

  // Draw in screen space: darker palette, rotated to road angle (upright when possible)
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 2 * lineScale;
  ctx.lineJoin = "round";

  // Clash avoidance: push labels along road if bboxes overlap (cheap pass)
  const placed = [];
  const approxH = 14;
  toDraw.sort(function (a, b) {
    const da = (a.sx - cxScreen) * (a.sx - cxScreen) + (a.sy - cyScreen) * (a.sy - cyScreen);
    const db = (b.sx - cxScreen) * (b.sx - cxScreen) + (b.sy - cyScreen) * (b.sy - cyScreen);
    return da - db;
  });
  for (let i = 0; i < toDraw.length; i++) {
    const v = toDraw[i];
    const lab = v.lab;
    const tw = ctx.measureText(lab.name).width;
    const halfW = tw / 2 + LABEL_CLASH_PAD;
    const halfH = approxH / 2 + LABEL_CLASH_PAD;
    const angle = lab.angle != null ? lab.angle : 0;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    function bboxAt(sx, sy) {
      return {
        left: sx - halfW,
        right: sx + halfW,
        top: sy - halfH,
        bottom: sy + halfH,
      };
    }
    function overlaps(a, b) {
      return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }
    let sx = v.sx,
      sy = v.sy;
    let box = bboxAt(sx, sy);
    let found = false;
    for (let k = 0; k < placed.length && !found; k++) {
      if (overlaps(box, placed[k])) {
        found = true;
        break;
      }
    }
    if (found) {
      let pushed = false;
      for (let n = 1; n <= LABEL_PUSH_ATTEMPTS && !pushed; n++) {
        for (const sign of [1, -1]) {
          const step = sign * n * LABEL_PUSH_STEP_PX;
          const nsx = v.sx + step * cosA;
          const nsy = v.sy + step * sinA;
          const nbox = bboxAt(nsx, nsy);
          let ok = true;
          for (let k = 0; k < placed.length; k++) {
            if (overlaps(nbox, placed[k])) {
              ok = false;
              break;
            }
          }
          if (ok) {
            sx = nsx;
            sy = nsy;
            box = nbox;
            pushed = true;
            break;
          }
        }
      }
    }
    v.sx = sx;
    v.sy = sy;
    placed.push(box);
  }

  for (let i = 0; i < toDraw.length; i++) {
    const v = toDraw[i];
    const lab = v.lab;
    const bright = !dim || v.inside;
    ctx.fillStyle = bright ? "rgba(160,170,185,0.72)" : "rgba(100,110,125,0.38)";
    ctx.strokeStyle = bright ? "rgba(8,14,22,0.88)" : "rgba(8,14,22,0.45)";
    let drawAngle = lab.angle != null ? lab.angle : 0;
    if (drawAngle > Math.PI / 2 || drawAngle < -Math.PI / 2) drawAngle += Math.PI;
    ctx.save();
    ctx.translate(v.sx, v.sy);
    ctx.rotate(angle);
    ctx.rotate(drawAngle);
    ctx.strokeText(lab.name, 0, 0);
    ctx.fillText(lab.name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawStreetsBatched(dimStreet, hoverFeat) {
  if (!streetPath2D) return;
  const styleFull = "rgba(255,255,255,0.35)";
  const styleInside = "rgba(255,255,255,0.42)";
  const styleDim = "rgba(255,255,255," + dimStreet + ")";
  if (hoverNbd && hoverFeat && hoverFeat._path2d) {
    ctx.strokeStyle = styleDim;
    ctx.stroke(streetPath2D);
    ctx.save();
    ctx.clip(hoverFeat._path2d);
    ctx.strokeStyle = styleInside;
    ctx.stroke(streetPath2D);
    ctx.restore();
  } else {
    ctx.strokeStyle = styleFull;
    ctx.stroke(streetPath2D);
  }
}

function drawPathsBatched(dimPath, hoverFeat) {
  ctx.lineWidth = (1.5 / scale) * lineScale;
  if (pathPath2D) {
    const styleFull = "rgba(255,200,100,0.9)";
    const styleInside = "rgba(255,200,100,0.98)";
    const styleDim = "rgba(255,200,100," + dimPath + ")";
    if (hoverNbd && hoverFeat && hoverFeat._path2d) {
      ctx.strokeStyle = styleDim;
      ctx.stroke(pathPath2D);
      ctx.save();
      ctx.clip(hoverFeat._path2d);
      ctx.strokeStyle = styleInside;
      ctx.stroke(pathPath2D);
      ctx.restore();
    } else {
      ctx.strokeStyle = styleFull;
      ctx.stroke(pathPath2D);
    }
  }
}

function drawNbdOutlines(hoverFeat) {
  if (!nbdOutlinesPath2D) {
    return;
  }
  ctx.strokeStyle = hoverNbd && hoverFeat ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.5)";
  ctx.lineWidth = (1.5 / scale) * lineScale;
  ctx.stroke(nbdOutlinesPath2D);
}

function drawNbdHoverOutline(feat) {
  if (!feat || !feat._path2d) {
    return;
  }
  ctx.strokeStyle = "rgba(120,200,255,0.85)";
  ctx.lineWidth = (1.5 / scale) * lineScale;
  ctx.stroke(feat._path2d);
}

function updatePhotoPins() {
  const layer = document.getElementById("photoPinsLayer");
  if (!layer) return;
  const { w, h } = getCanvasCssSize();
  layer.setAttribute("aria-hidden", photoList.length ? "false" : "true");
  while (layer.children.length > photoList.length) {
    layer.lastChild.remove();
  }
  const pinImgSrc = "/static/images/photo-pin.svg";
  for (let i = 0; i < photoList.length; i++) {
    const p = photoList[i];
    const { x, y } = projectCSS(p.lon, p.lat, w, h);
    const px = x - 13;
    const py = y - 26;
    let pin = layer.children[i];
    if (!pin) {
      pin = document.createElement("button");
      pin.type = "button";
      pin.className = "photo-pin";
      pin.setAttribute("aria-label", "View photo");
      pin.dataset.index = String(i);
      const img = document.createElement("img");
      img.src = pinImgSrc;
      img.alt = "";
      pin.appendChild(img);
      pin.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(pin.dataset.index, 10);
        const photo = photoList[idx];
        if (!photo) return;
        if (isCoarsePointer()) {
          showPhotoTooltip(photo, pin);
        } else {
          openPhotoModal(photo);
        }
      });
      pin.addEventListener("mouseenter", function () {
        if (isCoarsePointer()) return;
        const idx = parseInt(pin.dataset.index, 10);
        const photo = photoList[idx];
        if (photo) showPhotoTooltip(photo, pin);
      });
      pin.addEventListener("mouseleave", function () {
        if (isCoarsePointer()) return;
        hidePhotoTooltip();
      });
      layer.appendChild(pin);
    } else {
      pin.dataset.index = String(i);
    }
    pin.style.transform = "translate3d(" + px + "px, " + py + "px, 0)";
  }
  if (hoverPhoto && hoverPhotoPinEl) {
    if (!hoverPhotoPinEl.isConnected) {
      hidePhotoTooltip();
    } else {
      positionPhotoTooltip();
    }
  }
}

function pointerAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left,
    y = clientY - rect.top;
  const { w, h } = getCanvasCssSize();
  const { lon, lat } = unproject(x, y, w, h);
  const n = nbdAt(lon, lat);
  const tipLeft = clientX + 14;
  const tipTop = clientY + 14;
  if (hoverNbd !== (n ? n.name : null)) {
    hoverNbd = n ? n.name : null;
    scheduleDraw();
  }
  updateTooltipAt(n, tipLeft, tipTop, hoverPhoto);
}

function openPhotoModal(photo) {
  if (!photo || !photo.id) return;
  const modal = document.getElementById("photoModal");
  const wrap = document.getElementById("photoModalImageWrap");
  const img = document.getElementById("photoModalImg");
  if (!modal || !wrap || !img) return;
  wrap.classList.remove("loaded");
  img.alt = photo.date ? "Photo from " + photo.date : "Photo at location";
  img.onload = img.onerror = function () {
    wrap.classList.add("loaded");
  };
  img.src = photo.url;
  const dateEl = modal.querySelector(".photo-modal-date");
  const coordsEl = modal.querySelector(".photo-modal-coords");
  if (dateEl) dateEl.textContent = photo.date || "";
  if (coordsEl && typeof photo.lat === "number" && typeof photo.lon === "number") {
    coordsEl.textContent = photo.lat.toFixed(5) + ", " + photo.lon.toFixed(5);
  } else if (coordsEl) {
    coordsEl.textContent = "";
  }
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
}

function closePhotoModal() {
  const modal = document.getElementById("photoModal");
  const wrap = document.getElementById("photoModalImageWrap");
  const img = document.getElementById("photoModalImg");
  if (modal) {
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
    const dateEl = modal.querySelector(".photo-modal-date");
    const coordsEl = modal.querySelector(".photo-modal-coords");
    if (dateEl) dateEl.textContent = "";
    if (coordsEl) coordsEl.textContent = "";
  }
  if (wrap) wrap.classList.remove("loaded");
  if (img) {
    img.removeAttribute("src");
    img.onload = null;
    img.onerror = null;
  }
}

function hideNbdTooltip(el) {
  const tip = el || document.getElementById("nbdTooltip");
  if (!tip) return;
  tip.classList.remove("visible");
  tip.setAttribute("aria-hidden", "true");
}

function updateTooltipAt(n, tipLeft, tipTop, overPhoto) {
  const tip = document.getElementById("nbdTooltip");
  if (!tip) return;
  if (n && !overPhoto) {
    tip.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = n.name || "";
    tip.appendChild(strong);
    const lines = [
      "Total: " + (n.total_km != null ? n.total_km.toFixed(2) : "—") + " km",
      "Explored: " + (n.explored_km != null ? n.explored_km.toFixed(2) : "—") + " km",
      "Unexplored: " + (n.unexplored_km != null ? n.unexplored_km.toFixed(2) : "—") + " km",
    ];
    if (n.pct != null) lines.push(n.pct.toFixed(1) + "% explored");
    for (const line of lines) {
      tip.appendChild(document.createElement("br"));
      tip.appendChild(document.createTextNode(line));
    }
    let x = tipLeft;
    let y = tipTop;
    tip.style.left = "0";
    tip.style.top = "0";
    tip.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
    tip.classList.add("visible");
    tip.setAttribute("aria-hidden", "false");
    const margin = 8;
    const r = tip.getBoundingClientRect();
    let dx = 0,
      dy = 0;
    if (r.left < margin) dx = margin - r.left;
    if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
    if (r.top < margin) dy = margin - r.top;
    if (r.bottom > window.innerHeight - margin) dy = window.innerHeight - margin - r.bottom;
    x += dx;
    y += dy;
    tip.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
  } else {
    hideNbdTooltip(tip);
  }
}

function twoPointerGeometry() {
  if (activePointers.size !== 2) return null;
  const entries = Array.from(activePointers.entries()).sort((a, b) => a[0] - b[0]);
  const a = entries[0][1];
  const b = entries[1][1];
  const cx = (a.clientX + b.clientX) / 2;
  const cy = (a.clientY + b.clientY) / 2;
  const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
  const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
  return { cx, cy, d, angle };
}

function clearTwoFingerAndHover() {
  twoFingerState = null;
  if (nbdTooltipDelayTimeout) {
    clearTimeout(nbdTooltipDelayTimeout);
    nbdTooltipDelayTimeout = null;
  }
  if (hoverNbd) {
    hoverNbd = null;
    scheduleDraw();
  }
  hidePhotoTooltip();
  hideNbdTooltip();
}

const mapWrap = document.getElementById("mapWrap");

function onMapPointerDown(e) {
  if (!mapWrap.contains(e.target)) return;
  const onPin = e.target.closest && e.target.closest(".photo-pin");
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
  const singlePointerOnPin = activePointers.size === 1 && onPin && e.pointerType !== "touch";
  if (!singlePointerOnPin) e.preventDefault();
  if (nbdTooltipDelayTimeout) {
    clearTimeout(nbdTooltipDelayTimeout);
    nbdTooltipDelayTimeout = null;
  }

  if (!singlePointerOnPin && mapWrap.setPointerCapture) mapWrap.setPointerCapture(e.pointerId);
  zoomTarget = null;
  if (activePointers.size === 2) {
    drag = null;
    clearTwoFingerAndHover();
    const g = twoPointerGeometry();
    if (g) {
      twoFingerState = { gestureMode: null, lastDist: g.d, lastAngle: g.angle };
    }
  } else if (activePointers.size === 1) {
    twoFingerState = null;
    const onPinNow = e.target.closest && e.target.closest(".photo-pin");
    if (!onPinNow) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left,
        y = e.clientY - rect.top;
      const { w, h } = getCanvasCssSize();
      const { lon, lat } = unproject(x, y, w, h);
      drag = { lon0: lon, lat0: lat };
      canvas.style.cursor = "move";
    }
    if (e.pointerType === "touch") {
      const pid = e.pointerId;
      nbdTooltipDelayTimeout = setTimeout(() => {
        nbdTooltipDelayTimeout = null;
        const pos = activePointers.get(pid);
        if (pos) pointerAt(pos.clientX, pos.clientY);
      }, NBD_TOOLTIP_DELAY_MS);
    } else {
      pointerAt(e.clientX, e.clientY);
    }
  }
}

function onMapPointerMove(e) {
  if (!mapWrap.contains(e.target)) return;
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
  const rect = canvas.getBoundingClientRect();
  const { w, h } = getCanvasCssSize();
  if (activePointers.size === 2) {
    if (twoFingerState) {
      e.preventDefault();
      markViewChanged();
      const g = twoPointerGeometry();
      if (!g) {
        return;
      }
      const { cx, cy, d, angle: currentAngle } = g;
      const canvasCx = cx - rect.left;
      const canvasCy = cy - rect.top;
      const k = d / twoFingerState.lastDist;
      if (twoFingerState.gestureMode === null) {
        const deltaAngle = currentAngle - twoFingerState.lastAngle;
        const deltaAngleNorm = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));
        const deltaDistRatio = (d - twoFingerState.lastDist) / twoFingerState.lastDist;
        if (
          Math.abs(deltaAngleNorm) > ROTATE_ANGLE_THRESHOLD &&
          Math.abs(deltaAngleNorm) > ROTATE_VS_ZOOM_RATIO * Math.abs(deltaDistRatio)
        ) {
          twoFingerState.gestureMode = "rotate";
        } else {
          twoFingerState.gestureMode = "zoom";
        }
      }
      if (twoFingerState.gestureMode === "zoom") {
        applyZoomAt(canvasCx, canvasCy, k);
        twoFingerState.lastDist = d;
      } else {
        const deltaAngle = currentAngle - twoFingerState.lastAngle;
        angle += deltaAngle;
        if (k !== 1) applyZoomAt(canvasCx, canvasCy, k);
        twoFingerState.lastDist = d;
        twoFingerState.lastAngle = currentAngle;
        scheduleDraw();
      }
    }
  } else if (activePointers.size === 1 && drag) {
    e.preventDefault();
    markViewChanged();
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    const { x: contentX, y: contentY } = canvasToContent(x, y, w, h);
    tx = contentX - drag.lon0 * scale;
    ty = contentY + drag.lat0 * scale;
    scheduleDraw();
  }
  pointerAt(e.clientX, e.clientY);
}

function onPointerUp(e) {
  activePointers.delete(e.pointerId);
  if (nbdTooltipDelayTimeout) {
    clearTimeout(nbdTooltipDelayTimeout);
    nbdTooltipDelayTimeout = null;
  }
  if (activePointers.size === 2) {
    const g = twoPointerGeometry();
    if (g && twoFingerState) {
      twoFingerState.lastDist = g.d;
      twoFingerState.lastAngle = g.angle;
    }
  } else if (activePointers.size === 1) {
    twoFingerState = null;
    const entry = activePointers.entries().next().value;
    if (entry) {
      const [, pos] = entry;
      const rect = canvas.getBoundingClientRect();
      const x = pos.clientX - rect.left,
        y = pos.clientY - rect.top;
      const { w, h } = getCanvasCssSize();
      const { lon, lat } = unproject(x, y, w, h);
      drag = { lon0: lon, lat0: lat };
    }
  } else {
    twoFingerState = null;
    drag = null;
    canvas.style.cursor = "";
    if (hoverNbd) {
      hoverNbd = null;
      scheduleDraw();
    }
    hideNbdTooltip();
  }
}

mapWrap.addEventListener("pointerdown", onMapPointerDown);
mapWrap.addEventListener("pointermove", onMapPointerMove);
document.addEventListener("pointerup", onPointerUp);
document.addEventListener("pointercancel", onPointerUp);
mapWrap.addEventListener("pointerleave", function () {
  if (!twoFingerState) {
    if (!compassDrag) canvas.style.cursor = "";
    if (hoverNbd) {
      hoverNbd = null;
      scheduleDraw();
    }
    hidePhotoTooltip();
    scheduleDraw();
    hideNbdTooltip();
  }
});

function zoomAt(canvasCx, canvasCy, k) {
  markViewChanged();
  const { w, h } = getCanvasCssSize();
  const { x: contentCx, y: contentCy } = canvasToContent(canvasCx, canvasCy, w, h);
  const oldScale = scale;
  const floor = scaleFloor();
  const newScale = Math.max(floor, Math.min(maxScale, scale * k));
  const newTx = contentCx - ((contentCx - tx) * newScale) / oldScale;
  const newTy = contentCy + ((ty - contentCy) * newScale) / oldScale;
  zoomTarget = { scale: newScale, tx: newTx, ty: newTy };
  scheduleDraw();
}

function applyZoomAt(canvasCx, canvasCy, k) {
  markViewChanged();
  const { w, h } = getCanvasCssSize();
  const { x: contentCx, y: contentCy } = canvasToContent(canvasCx, canvasCy, w, h);
  const oldScale = scale;
  const floor = scaleFloor();
  const newScale = Math.max(floor, Math.min(maxScale, scale * k));
  scale = newScale;
  tx = contentCx - ((contentCx - tx) * newScale) / oldScale;
  ty = contentCy + ((ty - contentCy) * newScale) / oldScale;
  zoomTarget = null;
  scheduleDraw();
}

if (mapWrap) {
  mapWrap.addEventListener(
    "wheel",
    function (e) {
      if (!mapWrap.contains(e.target)) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const step = e.deltaY > 0 ? 0.85 : 1.18;
      zoomAt(cx, cy, step);
    },
    { passive: false },
  );
  // GestureEvent (e.g. trackpad rotate) is not always safe across browsers; omit by default.
  // To re-enable: if (typeof GestureEvent !== "undefined") { mapWrap.addEventListener("gesturechange", ...); }
}

canvas.addEventListener("keydown", function (e) {
  const step = 40;
  if (e.key === "ArrowLeft") {
    markViewChanged();
    tx += step;
    scheduleDraw();
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    markViewChanged();
    tx -= step;
    scheduleDraw();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    markViewChanged();
    ty += step;
    scheduleDraw();
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    markViewChanged();
    ty -= step;
    scheduleDraw();
    e.preventDefault();
  } else if (e.key === "+" || e.key === "=") {
    const { w, h } = getCanvasCssSize();
    zoomAt(w / 2, h / 2, 1.25);
    e.preventDefault();
  } else if (e.key === "-") {
    const { w, h } = getCanvasCssSize();
    zoomAt(w / 2, h / 2, 1 / 1.25);
    e.preventDefault();
  }
});

document.getElementById("zoomIn").addEventListener("click", () => {
  const { w, h } = getCanvasCssSize();
  zoomAt(w / 2, h / 2, 1.3);
});
document.getElementById("zoomOut").addEventListener("click", () => {
  const { w, h } = getCanvasCssSize();
  zoomAt(w / 2, h / 2, 1 / 1.3);
});
document.getElementById("zoomReset").addEventListener("click", () => {
  fit();
  scheduleDraw();
});

async function init() {
  try {
    const coreRes = await fetch("/api/draw");
    if (!coreRes.ok) {
      console.log("[load] core fetch failed", coreRes.status, coreRes.statusText);
      bounds = defaultBounds.slice();
      fit();
      scheduleDraw();
      return;
    }
    const core = await coreRes.json();
    streetPath2D = core.streets ? new Path2D(core.streets) : null;
    pathPath2D = core.paths ? new Path2D(core.paths) : null;
    bounds = core.bounds && core.bounds.length === 4 ? core.bounds : defaultBounds.slice();
    if (!validBounds(bounds)) {
      bounds = defaultBounds.slice();
    }
    const nbdBlock = core.neighborhoods;
    if (nbdBlock) {
      nbds = nbdBlock.list || [];
      const nbdFeatures = nbdBlock.features || [];
      nbdFeats = nbdFeatures.map((f) => {
        const rings = f.rings || [];
        return {
          name: f.name,
          properties: { name: f.name },
          _polys: rings,
          _path2d: path2DFromPolys(rings),
        };
      });
      nbdOutlinesPath2D = nbdBlock.outlines ? new Path2D(nbdBlock.outlines) : null;
    } else {
      nbds = [];
      nbdFeats = [];
      nbdOutlinesPath2D = null;
    }
    fit();
    scheduleDraw();

    fetch("/api/draw/overlay")
      .then((overlayRes) => {
        if (!overlayRes.ok) return;
        return overlayRes.json();
      })
      .then((data) => {
        if (!data) return;
        roadLabels = (data.labels || []).map((l) => ({
          ...l,
          midLon: l.lon,
          midLat: l.lat,
        }));
        scheduleDraw();
      })
      .catch(() => {});

    fetch("/api/photos")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.photos)) {
          photoList = data.photos;
          scheduleDraw();
        }
      })
      .catch(() => {});
  } catch (e) {
    console.error("[init] failed", e);
  }

  const modal = document.getElementById("photoModal");
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closePhotoModal();
    });
  }

  const compassEl = document.getElementById("compass");
  if (compassEl) {
    compassEl.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      compassEl.setPointerCapture(e.pointerId);
      compassDrag = true;
      compassEl.classList.add("compass-dragging");
    });
    compassEl.addEventListener("pointermove", function (e) {
      if (!compassDrag) return;
      const r = compassEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      angle = Math.atan2(e.clientX - cx, cy - e.clientY);
      markViewChanged();
      scheduleDraw();
    });
    compassEl.addEventListener("pointerup", function (e) {
      compassDrag = false;
      compassEl.classList.remove("compass-dragging");
    });
    compassEl.addEventListener("pointercancel", function (e) {
      compassDrag = false;
      compassEl.classList.remove("compass-dragging");
    });
  }

  const tip = getPhotoTooltipEl();
  if (!tip) return;
  function openModalFromTooltip(e) {
    if (!isCoarsePointer() || !hoverPhoto) return;
    e.preventDefault();
    e.stopPropagation();
    const photo = hoverPhoto;
    hidePhotoTooltip();
    openPhotoModal(photo);
  }
  tip.addEventListener("touchstart", openModalFromTooltip, { passive: false });
  tip.addEventListener("click", openModalFromTooltip);
  document.addEventListener(
    "touchstart",
    function (e) {
      if (!isCoarsePointer() || !hoverPhoto) return;
      const target = e.target;
      if (tip.contains(target) || (target && target.closest && target.closest(".photo-pin"))) return;
      hidePhotoTooltip();
    },
    true,
  );

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && document.getElementById("photoModal")?.classList.contains("visible")) {
      closePhotoModal();
    }
  });
}

init();

window.addEventListener("resize", resize);
window.visualViewport?.addEventListener("resize", resize);

requestAnimationFrame(() => {
  resize();
});
