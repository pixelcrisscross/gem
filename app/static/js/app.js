import { AudioRecorder } from "./audio-recorder.js";
import { AudioPlayer } from "./audio-player.js";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const statusEl       = document.getElementById("status");
const messagesEl     = document.getElementById("messages");
const textInput      = document.getElementById("text-input");
const startBtn       = document.getElementById("start-btn");
const sendBtn        = document.getElementById("send-btn");
const researchCards  = document.getElementById("researchCards");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let micOn = false;
let recorder = null;
let player = null;
let currentAgentEl = null;
let currentAgentText = "";
let groundedThisTurn = false;
let renderedMapsThisTurn = new Set();

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
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleEvent(event);
  };
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------
function handleEvent(event) {
  // ---- 1. Custom pushes from marine tools ----
  if (event.type === "marine_map") { addMarineMapCard(event.data); return; }
  if (event.type === "pfz_data") {
    addInfoCard("Potential Fishing Zone", event.data.info, "phishing", "success");
    return;
  }
  if (event.type === "geofence_alert") {
    addInfoCard(
      "Maritime Boundary Alert",
      event.data.message,
      event.data.safe ? "shield" : "warning",
      event.data.safe ? "success" : "warning"
    );
    return;
  }
  if (event.type === "marine_weather") {
    addInfoCard("Marine Weather", event.data.info, "cloud", "");
    return;
  }

  // ---- 2. Grounding metadata (from google_search) ----
  if (event.groundingMetadata) {
    groundedThisTurn = true;
    handleGrounding(event.groundingMetadata);
  }

  // ---- 3. content.parts: function calls / responses / text / audio ----
  if (event.content && Array.isArray(event.content.parts)) {
    for (const part of event.content.parts) {
      // Function calls → tool card in chat
      if (part.functionCall) {
        addToolCallCard(part.functionCall.name, part.functionCall.args);
      }
      // Function responses → render card if the backend didn't already push
      if (part.functionResponse) {
        const name = part.functionResponse.name;
        const raw  = part.functionResponse.response;
        const resp = (raw && typeof raw === "object" && "result" in raw) ? raw.result : raw;
        if (resp && typeof resp === "object") {
          if (name === "show_marine_map" && !renderedMapsThisTurn.has("map")) {
            renderedMapsThisTurn.add("map");
            addMarineMapCard(resp);
          } else if (name === "fetch_pfz_data") {
            addInfoCard("Potential Fishing Zone", resp.info || "", "phishing", "success");
          } else if (name === "get_marine_weather") {
            addInfoCard("Marine Weather", resp.info || "", "cloud", "");
          } else if (name === "check_geofence_imbl") {
            addInfoCard(
              "Maritime Boundary Alert",
              resp.message || "",
              resp.safe ? "shield" : "warning",
              resp.safe ? "success" : "warning"
            );
          }
        }
      }
      // Text stream
      if (typeof part.text === "string" && !part.thought) {
        if (!currentAgentEl) {
          currentAgentEl = addMessage("agent", "");
          currentAgentText = "";
        }
        currentAgentText += part.text;
        currentAgentEl.querySelector(".bubble").textContent = currentAgentText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      // Audio stream
      if (part.inlineData && typeof part.inlineData.mimeType === "string"
          && part.inlineData.mimeType.startsWith("audio/pcm") && player) {
        player.play(base64ToBytes(part.inlineData.data));
      }
    }
  }

  // ---- 4. Turn lifecycle ----
  if (event.turnComplete || event.interrupted) {
    currentAgentEl = null;
    currentAgentText = "";
    renderedMapsThisTurn.clear();
    groundedThisTurn = false;
  }
}

// ---------------------------------------------------------------------------
// Grounding → Web search card (renders the YouTube + images + sources card)
// ---------------------------------------------------------------------------
function handleGrounding(gm) {
  const queries     = gm.webSearchQueries || [];
  const chunks      = gm.groundingChunks || [];
  const supports    = gm.groundingSupports || [];
  const images      = gm.images || [];
  const attachments = gm.attachments || [];

  // Sources
  const sources = [];
  for (const chunk of chunks) {
    if (chunk.web) sources.push({ title: chunk.web.title, url: chunk.web.uri });
    if (chunk.retrievedContext)
      sources.push({ title: chunk.retrievedContext.title, url: chunk.retrievedContext.uri });
  }

  // Media (images + videos)
  const media = [];
  const allImages = images.concat(
    attachments.filter((a) => a && a.image).map((a) => a.image)
  );
  for (const img of allImages) {
    const src   = img.source?.uri || img.source_uri || "";
    const thumb = img.thumbnail?.uri || img.thumbnail_uri || img.source?.uri || "";
    const title = img.source?.title || img.source_title || "";
    if (!thumb) continue;
    const ytId = extractYouTubeId(src) || extractYouTubeId(thumb);
    media.push({ src, thumb, title, videoId: ytId });
  }

  // Summary
  let summary = "";
  if (supports.length) {
    summary = supports.map((s) => s.segment?.text || "").filter(Boolean).join(" ").trim();
  }

  if (!queries.length && !sources.length && !media.length && !summary) return;

  addWebSearchCard({ queries, sources, media, summary });
}

function extractYouTubeId(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
      if (m) return m[2];
    }
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (u.hostname.includes("ytimg.com")) {
      const m = u.pathname.match(/\/vi\/([^/]+)/);
      if (m) return m[1];
    }
  } catch {}
  return "";
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------
function clearEmptyState() {
  const empty = researchCards.querySelector(".empty-state");
  if (empty) empty.remove();
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `
    <div class="bubble">${escapeHtml(text)}</div>
    <div class="time">${time}</div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addToolCallCard(name, args) {
  const div = document.createElement("div");
  div.className = "message agent";
  let argsHtml = "";
  if (args && typeof args === "object") {
    argsHtml = Object.entries(args)
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v))}`)
      .join("<br>");
  } else if (typeof args === "string") {
    argsHtml = escapeHtml(args);
  }
  div.innerHTML = `
    <div class="tool-call-card">
      <div class="tool-name">
        <span class="material-symbols-outlined">search</span>
        ${escapeHtml(name)}
      </div>
      <div class="tool-args">${argsHtml}</div>
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addWebSearchCard({ queries, sources, media, summary }) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";

  const title = queries[0] ? prettify(queries[0]) : "Web Search Results";

  const queryHtml = queries.length
    ? `<div class="query-chips">${queries
        .map(
          (q) => `<span class="query-chip">
            <span class="material-symbols-outlined">search</span>${escapeHtml(q)}
          </span>`
        )
        .join("")}</div>`
    : "";

  let mediaHtml = "";
  if (media.length) {
    const cells = [];
    let imgCount = 0;
    for (const m of media) {
      if (m.videoId) {
        cells.push(
          `<div class="mosaic-video">
            <iframe src="https://www.youtube.com/embed/${escapeHtml(m.videoId)}"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen></iframe>
          </div>`
        );
      } else if (imgCount < 4) {
        imgCount++;
        cells.push(
          `<a class="mosaic-image" href="${escapeHtml(m.src || "#")}" target="_blank" rel="noopener">
            <img src="${escapeHtml(m.thumb)}" alt="" loading="lazy" />
            ${m.title ? `<span class="img-label">${escapeHtml(m.title)}</span>` : ""}
          </a>`
        );
      }
    }
    mediaHtml = `<div class="media-mosaic">${cells.join("")}</div>`;
  }

  const summaryHtml = summary
    ? `<div class="card-body">${escapeHtml(summary)}</div>`
    : "";

  const sourceHtml = sources.length
    ? `<div class="source-chips">${sources
        .map(
          (s) => `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
            <span class="material-symbols-outlined">article</span>
            ${escapeHtml(s.title || s.url)}
          </a>`
        )
        .join("")}</div>`
    : "";

  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">travel_explore</span>
      <h3>${escapeHtml(title)}</h3>
    </div>
    ${queryHtml}
    ${mediaHtml}
    ${summaryHtml}
    ${sourceHtml}
  `;

  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function addMarineMapCard(data) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  const mapId = `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const layerName =
    { SST: "Sea Surface Temperature",
      CHL: "Chlorophyll Concentration",
      PFZ: "Potential Fishing Zone" }[data.layer_type] || data.layer_type;

  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">map</span>
      <h3>${escapeHtml(layerName)}</h3>
      <span class="badge">${escapeHtml(data.layer_type)}</span>
    </div>
    <div id="${mapId}" class="map-container"></div>
    <div class="map-meta">
      Center: ${Number(data.latitude).toFixed(3)}, ${Number(data.longitude).toFixed(3)}
      · Zoom: ${data.zoom}
    </div>
  `;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;

  const render = () => {
    const el = document.getElementById(mapId);
    if (!el || !window.google || !google.maps) return;

    const center = { lat: Number(data.latitude), lng: Number(data.longitude) };
    const map = new google.maps.Map(el, {
      center,
      zoom: Number(data.zoom) || 8,
      mapTypeId: "satellite",
      disableDefaultUI: false,
    });

    if (data.layer_type === "SST") {
      new google.maps.Marker({
        position: center, map, title: "SST",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 14, fillColor: "#ef4444", fillOpacity: 0.85,
          strokeColor: "#ffffff", strokeWeight: 2,
        },
      });
      new google.maps.Circle({
        strokeColor: "#ef4444", strokeOpacity: 0.6, strokeWeight: 2,
        fillColor: "#ef4444", fillOpacity: 0.15,
        map, center, radius: 30000,
      });
    } else if (data.layer_type === "CHL") {
      new google.maps.Marker({
        position: center, map, title: "Chlorophyll",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 14, fillColor: "#22c55e", fillOpacity: 0.85,
          strokeColor: "#ffffff", strokeWeight: 2,
        },
      });
      new google.maps.Circle({
        strokeColor: "#22c55e", strokeOpacity: 0.6, strokeWeight: 2,
        fillColor: "#22c55e", fillOpacity: 0.15,
        map, center, radius: 30000,
      });
    } else if (data.layer_type === "PFZ") {
      new google.maps.Polygon({
        paths: [
          { lat: center.lat + 0.1, lng: center.lng - 0.1 },
          { lat: center.lat - 0.1, lng: center.lng - 0.1 },
          { lat: center.lat - 0.1, lng: center.lng + 0.1 },
          { lat: center.lat + 0.1, lng: center.lng + 0.1 },
        ],
        strokeColor: "#00e0a0", strokeOpacity: 0.9, strokeWeight: 2,
        fillColor: "#00e0a0", fillOpacity: 0.35, map,
      });
    }
  };

  if (window.google && google.maps) {
    render();
  } else {
    let n = 0;
    const t = setInterval(() => {
      if (window.google && google.maps) { clearInterval(t); render(); }
      else if (++n > 40) {
        clearInterval(t);
        const el = document.getElementById(mapId);
        if (el) el.innerHTML =
          '<div style="padding:20px;color:#94a3b8;">Google Maps not loaded. Check MAPS_API_KEY.</div>';
      }
    }, 200);
  }
}

function addInfoCard(title, body, icon, severity) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.innerHTML = `
    <div class="grounding-card-header">
      <span class="material-symbols-outlined">${icon || "info"}</span>
      <h3>${escapeHtml(title)}</h3>
    </div>
    <div class="info-body ${severity || ""}">${escapeHtml(body)}</div>
  `;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addMessage("user", text);
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

startBtn.addEventListener("click", async () => {
  if (micOn) return;
  try {
    player = new AudioPlayer();
    await player.init();
    recorder = new AudioRecorder(onAudioData);
    await recorder.start();
    micOn = true;
    startBtn.classList.add("recording");
    startBtn.querySelector(".material-symbols-outlined").textContent = "mic_off";
  } catch (e) {
    addMessage("agent", "Mic error: " + e.message);
  }
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
function prettify(str) {
  return String(str).replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
connect();