import { AudioRecorder } from "./audio-recorder.js";
import { AudioPlayer } from "./audio-player.js";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const statusEl      = document.getElementById("status");
const messagesEl    = document.getElementById("messages");
const textInput     = document.getElementById("text-input");
const startBtn      = document.getElementById("start-btn");
const sendBtn       = document.getElementById("send-btn");
const researchCards = document.getElementById("researchCards");
const tryAskingEl   = document.getElementById("try-asking");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let micOn = false;
let recorder = null;
let player = null;

let currentAgentEl = null;
let currentAgentText = "";
let currentUserVoiceEl = null;
let currentUserVoiceText = "";

// Per-turn dedup. These are reset in sendText() — NOT in turnComplete — so
// duplicate tools the agent fires after turnComplete are still suppressed.
let renderedMapKeys = new Set();
let renderedSuggestionsThisTurn = false;
let renderedSearchThisTurn = false;
let firstUserMessageSent = false;

const userId    = "user-" + Math.random().toString(36).slice(2, 10);
const sessionId = "session-" + Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws/${userId}/${sessionId}`);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.classList.add("connected");
  };
  ws.onclose = () => {
    statusEl.textContent = "Disconnected";
    statusEl.classList.remove("connected");
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    statusEl.textContent = "Error";
    statusEl.classList.remove("connected");
  };
  ws.onmessage = (e) => {
    let v; try { v = JSON.parse(e.data); } catch { return; }
    if (v.type === "ping") return;  // heartbeat — ignore
    handleEvent(v);
  };
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------
function handleEvent(event) {
  if (event.groundingMetadata) {
    renderSearchCardFromGrounding(event.groundingMetadata);
  }

  if (event.inputTranscription && typeof event.inputTranscription.text === "string") {
    handleInputTranscription(event.inputTranscription);
  }
  if (event.outputTranscription && typeof event.outputTranscription.text === "string") {
    handleOutputTranscription(event.outputTranscription);
  }

  if (event.content && Array.isArray(event.content.parts)) {
    for (const part of event.content.parts) {
      if (part.functionCall) {
        addToolCallCard(part.functionCall.name, part.functionCall.args || {});
      }
      if (part.functionResponse) {
        const name = part.functionResponse.name;
        const raw  = part.functionResponse.response;
        const resp = (raw && typeof raw === "object" && "result" in raw) ? raw.result : raw;
        handleToolResponse(name, resp);
      }
      if (typeof part.text === "string" && !part.thought) {
        if (currentAgentEl && currentAgentEl.dataset.source === "transcription") continue;
        if (!currentAgentEl) {
          currentAgentEl = addMessageBubble("agent", "");
          currentAgentEl.dataset.source = "text";
          currentAgentText = "";
        }
        currentAgentText += part.text;
        currentAgentEl.querySelector(".bubble").textContent = currentAgentText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (part.inlineData && typeof part.inlineData.mimeType === "string"
          && part.inlineData.mimeType.startsWith("audio/pcm")) {
        playAudioChunk(part.inlineData.data);
      }
    }
  }

  if (event.interrupted) {
    if (player && player._worklet) player._worklet.port.postMessage({ command: "endOfAudio" });
    if (currentAgentEl) currentAgentEl.querySelector(".bubble").classList.add("interrupted");
    currentAgentEl = null;
    currentAgentText = "";
  }

  if (event.turnComplete) {
    // Do NOT clear per-turn dedup here — agent fires duplicates AFTER turnComplete.
    currentAgentEl = null;
    currentAgentText = "";
    currentUserVoiceEl = null;
    currentUserVoiceText = "";
  }
}

function handleToolResponse(name, resp) {
  if (!resp || typeof resp !== "object") return;
  switch (name) {
    case "show_marine_map":
      renderMarineMap(resp);
      break;
    case "get_ocean_conditions":
      renderOceanConditionsCard(resp);
      if (resp.map) renderMarineMap(resp.map);
      break;
    case "get_sst":
      renderStatCard("Sea Surface Temperature", "water_drop", [
        ["SST", resp.sst?.sst_celsius, "°C"],
        ["SST", resp.sst?.sst_fahrenheit, "°F"],
        ["Samples", resp.sst?.samples, ""],
        ["Source", resp.sst?.source, ""],
      ], resp.summary);
      if (resp.map) renderMarineMap(resp.map);
      break;
    case "get_chlorophyll":
      renderStatCard("Chlorophyll Concentration", "eco", [
        ["Chl-a", resp.chlorophyll?.chlorophyll_mg_m3, "mg/m³"],
        ["Category", resp.chlorophyll?.category, ""],
        ["Samples", resp.chlorophyll?.samples, ""],
        ["Source", resp.chlorophyll?.source, ""],
      ], resp.summary);
      if (resp.map) renderMarineMap(resp.map);
      break;
    case "get_marine_weather":
      renderWeatherCard(resp);
      break;
    case "check_safety":
      renderSafetyCard(resp);
      break;
    case "find_pfz":
      renderPFZCard(resp);
      if (resp.map) renderMarineMap(resp.map);
      break;
    case "check_geofence":
      renderGeofenceCard(resp);
      break;
    case "find_safe_route":
      renderRouteCard(resp);
      break;
    case "suggest_followups":
      if (!renderedSuggestionsThisTurn) {
        renderedSuggestionsThisTurn = true;
        renderInlineSuggestions(resp.suggestions);
      }
      break;
    // google_search returns nothing useful here — grounding metadata is
    // delivered separately via event.groundingMetadata.
  }
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------
function handleInputTranscription(t) {
  if (!t.text || !t.text.trim()) return;
  if (!currentUserVoiceEl) {
    currentUserVoiceEl = addMessageBubble("user", "");
    currentUserVoiceEl.dataset.source = "transcription";
    currentUserVoiceText = "";
  }
  currentUserVoiceText = t.finished ? t.text
    : (currentUserVoiceText.endsWith(t.text) ? t.text : currentUserVoiceText + t.text);
  currentUserVoiceEl.querySelector(".bubble").textContent = currentUserVoiceText;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleOutputTranscription(t) {
  if (!t.text || !t.text.trim()) return;
  if (!currentAgentEl) {
    currentAgentEl = addMessageBubble("agent", "");
    currentAgentEl.dataset.source = "transcription";
    currentAgentText = "";
  }
  currentAgentText = t.finished ? t.text
    : (currentAgentText.endsWith(t.text) ? t.text : currentAgentText + t.text);
  currentAgentEl.querySelector(".bubble").textContent = currentAgentText;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
async function ensurePlayer() {
  if (player) return;
  player = new AudioPlayer();
  await player.init();
}
async function playAudioChunk(b64) {
  try { await ensurePlayer(); player.play(base64ToBytes(b64)); }
  catch (e) { console.error(e); }
}

// ---------------------------------------------------------------------------
// Chat bubbles + tool cards
// ---------------------------------------------------------------------------
function clearEmptyState() {
  const empty = researchCards.querySelector(".empty-state");
  if (empty) empty.remove();
}

function addMessageBubble(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div><div class="time">${time}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addToolCallCard(name, args) {
  const div = document.createElement("div");
  div.className = "message agent";
  const friendly = {
    google_search: "Google Search & Maps Search",
    show_marine_map: "Google Maps",
    get_ocean_conditions: "Ocean Analytics",
    get_sst: "Ocean Analytics",
    get_chlorophyll: "Ocean Analytics",
    get_marine_weather: "Marine Weather",
    check_safety: "Safety Check",
    find_pfz: "Fishery Intelligence",
    check_geofence: "Geofence Check",
    find_safe_route: "Route Planner",
    suggest_followups: "Follow-ups",
  }[name] || name;
  let argsHtml = "";
  if (args && typeof args === "object") {
    argsHtml = Object.entries(args)
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v))}`)
      .join("<br>");
  }
  div.innerHTML = `
    <div class="tool-call-card">
      <div class="tool-name">
        <span class="material-symbols-outlined">search</span>${escapeHtml(friendly)}
      </div>
      ${argsHtml ? `<div class="tool-args">${argsHtml}</div>` : ""}
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderInlineSuggestions(suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) return;
  const wrap = document.createElement("div");
  wrap.className = "message agent inline-suggested";
  wrap.innerHTML = suggestions.slice(0, 3).map((s) =>
    `<button class="chip" data-suggestion="${escapeHtml(s)}">
       <span class="material-symbols-outlined">auto_awesome</span>${escapeHtml(s)}
     </button>`).join("");
  wrap.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      textInput.value = chip.dataset.suggestion || "";
      sendText();
    });
  });
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// WMTS / WMS tile URL builders
// ---------------------------------------------------------------------------
function buildTileUrlGetter(info) {
  if (!info) return null;
  if (info.provider === "copernicus_wmts" && info.tile_template) {
    const tpl = info.tile_template;
    return (coord, zoom) => tpl
      .replace("{z}", zoom)
      .replace("{x}", coord.x)
      .replace("{y}", coord.y);
  }
  if (info.provider === "erddap_wms" && info.dataset_id && info.variable) {
    const ds = info.dataset_id, v = info.variable;
    return (coord, zoom) => {
      const n = Math.pow(2, zoom);
      const lonMin = coord.x / n * 360 - 180;
      const lonMax = (coord.x + 1) / n * 360 - 180;
      const latMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / n))) * 180 / Math.PI;
      const latMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / n))) * 180 / Math.PI;
      const bbox = `${lonMin},${latMin},${lonMax},${latMax}`;
      return `https://coastwatch.pfeg.noaa.gov/erddap/wms/${ds}/request`
        + `?service=WMS&version=1.1.1&request=GetMap&layers=${v}&styles=`
        + `&srs=EPSG:4326&bbox=${bbox}&width=256&height=256`
        + `&format=image/png&transparent=true`;
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Marine map card
// ---------------------------------------------------------------------------
function renderMarineMap(data) {
  const key = `${data.layer_type}|${Number(data.latitude).toFixed(2)}|${Number(data.longitude).toFixed(2)}`;
  if (renderedMapKeys.has(key)) return;
  renderedMapKeys.add(key);

  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card map-card";
  const mapId = `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const info = data.wmts;
  const layerName = info?.title || ({
    SST: "Sea Surface Temperature",
    CHL: "Chlorophyll Concentration",
    PFZ: "Potential Fishing Zone",
  }[data.layer_type]) || data.layer_type;

  const legendHtml = info?.legend?.length
    ? `<div class="legend">${info.legend.map((l) =>
        `<span class="legend-step"><span class="swatch" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.label)}</span>`
      ).join("")}</div>`
    : "";

  const providerLabel = info?.provider === "copernicus_wmts"
    ? "Copernicus WMTS"
    : info?.provider === "erddap_wms"
      ? "ERDDAP WMS"
      : "—";

  const metaHtml = info
    ? `<div class="map-meta-line">
         <span class="material-symbols-outlined">satellite_alt</span>
         ${escapeHtml(info.source)} · ${escapeHtml(info.units)}
         ${info.time ? ` · ${escapeHtml(info.time.slice(0, 10))}` : ""}
         ${info.debug_url ? `<a class="debug-link" href="${escapeHtml(info.debug_url)}"
            target="_blank" rel="noopener" title="Open a sample tile">verify</a>` : ""}
       </div>`
    : `<div class="map-meta-line">
         <span class="material-symbols-outlined">warning</span>
         Data layer unavailable for this view
       </div>`;

  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">satellite_alt</span>
      <h3>${escapeHtml(layerName)}</h3>
      <span class="badge">${escapeHtml(data.layer_type)}</span>
      <span class="badge badge-outline">${escapeHtml(providerLabel)}</span>
    </div>
    ${metaHtml}
    <div id="${mapId}" class="map-container"></div>
    <div class="map-bottom">
      ${legendHtml}
      <div class="opacity-row">
        <label>Overlay</label>
        <input type="range" min="0" max="100" value="75" class="opacity-slider" />
      </div>
    </div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;

  const render = () => {
    const el = document.getElementById(mapId);
    if (!el || !window.google || !google.maps) return;
    const center = { lat: Number(data.latitude), lng: Number(data.longitude) };
    const map = new google.maps.Map(el, {
      center, zoom: Number(data.zoom) || 8,
      mapTypeId: "satellite",
      disableDefaultUI: false,
      streetViewControl: false,
    });

    const getTileUrl = buildTileUrlGetter(info);
    if (getTileUrl) {
      const overlay = new google.maps.ImageMapType({
        getTileUrl,
        tileSize: new google.maps.Size(256, 256),
        opacity: 0.75,
        name: layerName,
      });
      map.overlayMapTypes.push(overlay);

      const slider = card.querySelector(".opacity-slider");
      if (slider) {
        slider.addEventListener("input", () => overlay.setOpacity(Number(slider.value) / 100));
      }
    }

    new google.maps.Marker({
      position: center, map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 7, fillColor: "#ffffff", fillOpacity: 1,
        strokeColor: "#1d4ed8", strokeWeight: 3,
      },
    });
  };

  if (window.google && google.maps) render();
  else {
    let n = 0;
    const t = setInterval(() => {
      if (window.google && google.maps) { clearInterval(t); render(); }
      else if (++n > 40) {
        clearInterval(t);
        const el = document.getElementById(mapId);
        if (el) el.innerHTML = '<div style="padding:20px;color:#991b1b;font-size:13px;">'
          + '<strong>Google Maps failed to load.</strong> Check the console for details.</div>';
      }
    }, 200);
  }
}

// ---------------------------------------------------------------------------
// Other cards
// ---------------------------------------------------------------------------
function renderOceanConditionsCard(resp) {
  clearEmptyState();
  const sst = resp.sst || {}, chl = resp.chlorophyll || {};
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">water_drop</span>
      <h3>Ocean Conditions</h3>
    </div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="k">SST</div><div class="v">${fmt(sst.sst_celsius)}<span class="u">°C</span></div></div>
      <div class="stat-tile"><div class="k">SST</div><div class="v">${fmt(sst.sst_fahrenheit)}<span class="u">°F</span></div></div>
      <div class="stat-tile"><div class="k">Chlorophyll</div><div class="v">${fmt(chl.chlorophyll_mg_m3)}<span class="u">mg/m³</span></div></div>
      <div class="stat-tile"><div class="k">Waves</div><div class="v">${fmt(resp.marine?.wave_height_m)}<span class="u">m</span></div></div>
    </div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    <div class="source-chips">
      ${sst.source ? `<span class="source-chip"><span class="material-symbols-outlined">article</span>${escapeHtml(sst.source)}</span>` : ""}
      ${chl.source ? `<span class="source-chip"><span class="material-symbols-outlined">article</span>${escapeHtml(chl.source)}</span>` : ""}
    </div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderStatCard(title, icon, tiles, summary) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  const tilesHtml = tiles.map(([k, v, u]) => `
    <div class="stat-tile"><div class="k">${escapeHtml(k)}</div>
      <div class="v">${escapeHtml(fmt(v))}${u ? `<span class="u">${escapeHtml(u)}</span>` : ""}</div>
    </div>`).join("");
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">${icon}</span><h3>${escapeHtml(title)}</h3>
    </div>
    <div class="stat-grid">${tilesHtml}</div>
    ${summary ? `<div class="card-body">${escapeHtml(summary)}</div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderWeatherCard(resp) {
  clearEmptyState();
  const w = resp.weather || {}, m = resp.marine || {};
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">cloud</span><h3>Marine Weather</h3>
    </div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="k">Wind</div><div class="v">${fmt(w.wind_speed_kt)}<span class="u">kt</span></div></div>
      <div class="stat-tile"><div class="k">Gusts</div><div class="v">${fmt(w.wind_gusts_kt)}<span class="u">kt</span></div></div>
      <div class="stat-tile"><div class="k">Waves</div><div class="v">${fmt(m.wave_height_m)}<span class="u">m</span></div></div>
      <div class="stat-tile"><div class="k">Swell</div><div class="v">${fmt(m.swell_wave_height_m)}<span class="u">m</span></div></div>
      <div class="stat-tile"><div class="k">Air temp</div><div class="v">${fmt(w.temperature_c)}<span class="u">°C</span></div></div>
      <div class="stat-tile"><div class="k">Humidity</div><div class="v">${fmt(w.humidity_pct)}<span class="u">%</span></div></div>
    </div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    <div class="source-chips">
      ${w.source ? `<span class="source-chip"><span class="material-symbols-outlined">article</span>${escapeHtml(w.source)}</span>` : ""}
      ${m.source ? `<span class="source-chip"><span class="material-symbols-outlined">article</span>${escapeHtml(m.source)}</span>` : ""}
    </div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderSafetyCard(resp) {
  clearEmptyState();
  const level = resp.level || "safe";
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">${level === "safe" ? "shield" : "warning"}</span>
      <h3>Safety Assessment</h3>
      <span class="badge" style="background:${level === "safe" ? "#16a34a" : level === "warning" ? "#f59e0b" : "#dc2626"};">
        ${escapeHtml(level.toUpperCase())}
      </span>
    </div>
    ${resp.hazards?.length ? `<div class="info-body warning"><strong>Hazards:</strong> ${escapeHtml(resp.hazards.join("; "))}</div>` : ""}
    ${resp.advisories?.length ? `<div class="card-body"><strong>Advisories:</strong> ${escapeHtml(resp.advisories.join("; "))}</div>` : ""}
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    ${resp.nearest_harbour ? `<div class="source-chips"><span class="source-chip"><span class="material-symbols-outlined">anchor</span>Nearest: ${escapeHtml(resp.nearest_harbour.name)} (${resp.nearest_harbour.distance_nm} nm)</span></div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderPFZCard(resp) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  const label = resp.likely === true ? "LIKELY" : resp.likely === false ? "UNLIKELY" : "NO DATA";
  const color = resp.likely === true ? "#16a34a" : resp.likely === false ? "#6b7280" : "#f59e0b";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">phishing</span>
      <h3>Potential Fishing Zone</h3>
      <span class="badge" style="background:${color};">${label}</span>
    </div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="k">Chl-a</div><div class="v">${fmt(resp.chlorophyll?.chlorophyll_mg_m3)}<span class="u">mg/m³</span></div></div>
      <div class="stat-tile"><div class="k">SST</div><div class="v">${fmt(resp.sst?.sst_celsius)}<span class="u">°C</span></div></div>
      <div class="stat-tile"><div class="k">Waves</div><div class="v">${fmt(resp.marine?.wave_height_m)}<span class="u">m</span></div></div>
    </div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderGeofenceCard(resp) {
  clearEmptyState();
  const level = resp.level || "safe";
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">${level === "safe" ? "shield" : "warning"}</span>
      <h3>Geofence Check</h3>
      <span class="badge" style="background:${level === "safe" ? "#16a34a" : level === "warning" ? "#f59e0b" : "#dc2626"};">
        ${escapeHtml(level.toUpperCase())}
      </span>
    </div>
    <div class="info-body ${level === "safe" ? "success" : "warning"}">${escapeHtml(resp.summary || "")}</div>
    ${resp.nearest_harbours?.length ? `<div class="source-chips">${
      resp.nearest_harbours.map((h) => `<span class="source-chip"><span class="material-symbols-outlined">anchor</span>${escapeHtml(h.name)} · ${h.distance_nm} nm</span>`).join("")
    }</div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderRouteCard(resp) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  const rows = (resp.waypoints || []).map((w) => `
    <div class="stat-tile">
      <div class="k">${w.lat.toFixed(2)}, ${w.lon.toFixed(2)}</div>
      <div class="v">${fmt(w.wave_height_m)}<span class="u">m</span></div>
      <div class="u" style="font-size:11px;color:#6b7280;text-transform:uppercase;">${escapeHtml(w.risk)}</div>
    </div>`).join("");
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">sailing</span>
      <h3>Safe Route</h3>
      <span class="badge">${escapeHtml((resp.risk || "").toUpperCase())}</span>
    </div>
    <div class="stat-grid">${rows}</div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

// ---------------------------------------------------------------------------
// Search card (from grounding metadata only)
// ---------------------------------------------------------------------------
function renderSearchCardFromGrounding(gm) {
  if (renderedSearchThisTurn) return;
  const queries  = gm.webSearchQueries || [];
  const chunks   = gm.groundingChunks || [];
  const supports = gm.groundingSupports || [];
  const images   = gm.images || [];
  const attachments = gm.attachments || [];

  const sources = [];
  for (const chunk of chunks) {
    if (chunk.web) sources.push({ title: chunk.web.title, url: chunk.web.uri });
    if (chunk.retrievedContext)
      sources.push({ title: chunk.retrievedContext.title, url: chunk.retrievedContext.uri });
  }

  const media = [];
  const allImages = images.concat(attachments.filter((a) => a && a.image).map((a) => a.image));
  for (const img of allImages) {
    const src   = img.source?.uri || img.source_uri || "";
    const thumb = img.thumbnail?.uri || img.thumbnail_uri || img.source?.uri || "";
    const title = img.source?.title || img.source_title || "";
    if (!thumb) continue;
    media.push({ src, thumb, title,
                 videoId: extractYouTubeId(src) || extractYouTubeId(thumb) });
  }

  let summary = "";
  if (supports.length) {
    summary = supports.map((s) => s.segment?.text || "").filter(Boolean).join(" ").trim();
  }

  if (!queries.length && !sources.length && !media.length && !summary) return;
  renderedSearchThisTurn = true;
  renderSearchCard({ queries, sources, media, summary });
}

function renderSearchCard({ queries, sources, media, summary }) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  const title = queries[0] ? prettify(queries[0]) : "Web Search Results";

  const queryHtml = queries.length
    ? `<div class="query-chips">${queries.map((q) =>
        `<span class="query-chip"><span class="material-symbols-outlined">search</span>${escapeHtml(q)}</span>`).join("")}</div>`
    : "";

  let mediaHtml = "";
  if (media.length) {
    const cells = []; let imgs = 0;
    for (const m of media) {
      if (m.videoId) {
        cells.push(`<div class="mosaic-video">
          <iframe src="https://www.youtube.com/embed/${escapeHtml(m.videoId)}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen></iframe></div>`);
      } else if (imgs < 4) {
        imgs++;
        cells.push(`<a class="mosaic-image" href="${escapeHtml(m.src || "#")}" target="_blank" rel="noopener">
          <img src="${escapeHtml(m.thumb)}" alt="" loading="lazy" />
          ${m.title ? `<span class="img-label">${escapeHtml(m.title)}</span>` : ""}
        </a>`);
      }
    }
    mediaHtml = `<div class="media-mosaic">${cells.join("")}</div>`;
  }

  const summaryHtml = summary ? `<div class="card-body">${escapeHtml(summary)}</div>` : "";
  const sourceHtml = sources.length
    ? `<div class="source-chips">${sources.slice(0, 8).map((s) =>
        `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
           <span class="material-symbols-outlined">article</span>${escapeHtml(s.title || s.url)}
         </a>`).join("")}</div>`
    : "";

  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">travel_explore</span>
      <h3>${escapeHtml(title)}</h3>
    </div>
    ${queryHtml}${mediaHtml}${summaryHtml}${sourceHtml}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
async function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (!firstUserMessageSent && tryAskingEl) {
    tryAskingEl.style.display = "none";
    firstUserMessageSent = true;
  }

  // Reset per-turn dedup for the NEW user turn.
  renderedMapKeys = new Set();
  renderedSuggestionsThisTurn = false;
  renderedSearchThisTurn = false;

  await ensurePlayer();
  addMessageBubble("user", text);
  ws.send(JSON.stringify({ type: "text", text }));
  textInput.value = "";
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
});
document.querySelectorAll(".suggestion-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    textInput.value = btn.dataset.suggestion || "";
    sendText();
  });
});

// ---------------------------------------------------------------------------
// Mic
// ---------------------------------------------------------------------------
function onAudioData(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(buf));
}

async function startMic() {
  await ensurePlayer();
  recorder = new AudioRecorder(onAudioData);
  await recorder.start();
  micOn = true;
  startBtn.classList.add("recording");
  startBtn.querySelector(".material-symbols-outlined").textContent = "mic_off";
}
function stopMic() {
  if (recorder) { try { recorder.stop(); } catch {} recorder = null; }
  micOn = false;
  startBtn.classList.remove("recording");
  startBtn.querySelector(".material-symbols-outlined").textContent = "mic";
}
startBtn.addEventListener("click", async () => {
  if (micOn) { stopMic(); return; }
  try { await startMic(); }
  catch (e) { console.error(e); addMessageBubble("agent", "Mic error: " + e.message); stopMic(); }
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
function base64ToBytes(b64) {
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function prettify(str) { return String(str).replace(/\b\w/g, (c) => c.toUpperCase()); }
function fmt(v) { return (v == null || v === "" || Number.isNaN(v)) ? "—" : v; }
function extractYouTubeId(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v"); if (v) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/); if (m) return m[2];
    }
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (u.hostname.includes("ytimg.com")) {
      const m = u.pathname.match(/\/vi\/([^/]+)/); if (m) return m[1];
    }
  } catch {}
  return "";
}

connect();