import { AudioRecorder } from "./audio-recorder.js";
import { AudioPlayer } from "./audio-player.js";

/* ═══════════ DOM ═══════════ */
const statusPill      = document.getElementById("status-pill");
const statusText      = document.getElementById("status-text");
const messagesEl      = document.getElementById("messages");
const textInput       = document.getElementById("text-input");
const startBtn        = document.getElementById("start-btn");
const sendBtn         = document.getElementById("send-btn");
const researchCards   = document.getElementById("researchCards");
const researchPanel   = document.querySelector(".research-panel");
const tryAskingEl     = document.getElementById("try-asking");
const clearBtn        = document.getElementById("clear-research-btn");
const newChatBtn      = document.getElementById("new-chat-btn");
const toastStack      = document.getElementById("toast-stack");

const voiceView       = document.getElementById("voice-view");
const voiceResearch   = document.getElementById("voice-research");
const voiceExitBtn    = document.getElementById("voice-exit-btn");
const voiceMuteBtn    = document.getElementById("voice-mute-btn");
const voiceCardsBtn   = document.getElementById("voice-cards-toggle-btn");
const voiceSettingsBtn= document.getElementById("voice-settings-btn");
const voiceSourcesPop = document.getElementById("voice-sources-popover");
const voiceSourcesClose = document.getElementById("voice-sources-close");
const voiceStatusText = document.getElementById("voice-status-text");
const voiceSubstatus  = document.getElementById("voice-substatus");
const voiceTranscript = document.getElementById("voice-transcript");
const voiceHint       = document.getElementById("voice-hint");
/* ═══════════ NEW SCREEN & VIEW DOM REFERENCES ═══════════ */
const screenLanding      = document.getElementById("screen-landing");
const screenAuth         = document.getElementById("screen-auth");
const screenApp          = document.getElementById("screen-app");
const profileBtn         = document.getElementById("profile-btn");
const profileMenu        = document.getElementById("profile-menu");
const profileName        = document.getElementById("profile-name");
const profileStatus      = document.getElementById("profile-status");
const homeTextInput      = document.getElementById("home-text-input");
const homeSendBtn        = document.getElementById("home-send-btn");
const homeMicBtn         = document.getElementById("home-mic-btn");
const appBrandBtn        = document.getElementById("app-brand-btn");
const mobileBottomSheet  = document.getElementById("mobile-bottom-sheet");
const bsLocationTitle    = document.getElementById("bs-location-title");
const bsContent          = document.getElementById("bs-content");
const bsCloseBtn         = document.getElementById("bs-close-btn");
const topbarVoiceBtn     = document.getElementById("topbar-voice-btn");
const togglePanelBtn     = document.getElementById("toggle-panel-btn");
const voiceOrb           = document.getElementById("voice-orb");
const voiceOrbIcon       = document.getElementById("voice-orb-icon");

/* ═══════════ STATE ═══════════ */
const UIState = {
  currentScreen: "app", // "landing" | "auth" | "app"
  currentView: "home",   // "home" | "chat" | "explore" | "map"
  activeFilter: "all",
  isVoiceActive: false,
  isMicMuted: false,
  showVoiceCards: true,
  activeMapId: null,
  isDemoAuthed: true,
  userName: "Guest Explorer"
};

let ws = null;
let micOn = false;
let recorder = null;
let player = null;

let currentAgentEl = null;
let currentAgentText = "";
let currentUserVoiceEl = null;
let currentUserVoiceText = "";
let thinkingEl = null;
let userHasSentMessage = false;

let renderedMapKeys = new Set();
let renderedSuggestionsThisTurn = false;
let renderedSearchThisTurn = false;
let renderedSearchToolCardThisTurn = false;
let renderedToolPillsThisTurn = new Set();
let firstUserMessageSent = false;

let voiceModeActive = false;
let voiceAgentLine = "";
let voiceUserLine = "";
let lastVoiceUpdate = 0;
let voiceSpeakTimer = null;

const recentAgentTexts = [];
const DUP_WINDOW_MS = 20000;

let turnSources = freshBucket();
function freshBucket() {
  return { copernicus: new Set(), noaa: new Set(), openmeteo: new Set(),
           web: new Map(), tools: new Set() };
}

const userId    = "user-" + Math.random().toString(36).slice(2, 10);
const sessionId = "session-" + Math.random().toString(36).slice(2, 10);

/* ═══════════ SCREEN & VIEW NAVIGATION HANDLERS ═══════════ */
function showScreen(screenName) {
  UIState.currentScreen = screenName;
  if (screenLanding) screenLanding.classList.toggle("hidden", screenName !== "landing");
  if (screenAuth) screenAuth.classList.toggle("hidden", screenName !== "auth");
  if (screenApp) screenApp.classList.toggle("hidden", screenName !== "app");
}

function setAppView(viewName) {
  UIState.currentView = viewName;
  document.querySelectorAll(".app-view").forEach((v) => v.classList.add("hidden"));
  
  const targetView = document.getElementById(`ai-${viewName}-view`);
  if (targetView) targetView.classList.remove("hidden");

  // Update Navigation Tabs
  document.querySelectorAll(".main-nav .nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.nav === viewName);
  });

  document.querySelectorAll(".mobile-nav .nav-item").forEach((item) => {
    if (item.dataset.tab === "voice") return;
    item.classList.toggle("active", item.dataset.tab === viewName);
  });
}

function toggleDesktopPanel() {
  const appEl = document.getElementById("app");
  if (!appEl) return;
  UIState.isPanelCollapsed = !UIState.isPanelCollapsed;
  appEl.classList.toggle("app-panel-collapsed", UIState.isPanelCollapsed);
}

function openBottomSheet(title, htmlContent) {
  if (!mobileBottomSheet) return;
  if (bsLocationTitle) bsLocationTitle.textContent = title || "Selected Location";
  if (bsContent) bsContent.innerHTML = htmlContent;
  mobileBottomSheet.classList.remove("hidden");
  mobileBottomSheet.setAttribute("aria-hidden", "false");
}

function closeBottomSheet() {
  if (!mobileBottomSheet) return;
  mobileBottomSheet.classList.add("hidden");
  mobileBottomSheet.setAttribute("aria-hidden", "true");
}

/* ═══════════ TOASTS ═══════════ */
function showToast(message, kind = "success") {
  const icons = { success: "check_circle", error: "error", warning: "warning" };
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="material-symbols-outlined">${icons[kind] || "info"}</span><span>${escapeHtml(message)}</span>`;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ═══════════ WEBSOCKET ═══════════ */
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws/${userId}/${sessionId}`);
  ws.onopen = () => { statusText.textContent = "Connected"; statusPill.classList.remove("disconnected"); };
  ws.onclose = () => { statusText.textContent = "Disconnected"; statusPill.classList.add("disconnected"); setTimeout(connect, 3000); };
  ws.onerror = () => { statusText.textContent = "Error"; statusPill.classList.add("disconnected"); };
  ws.onmessage = (e) => {
    let v; try { v = JSON.parse(e.data); } catch { return; }
    if (v.type === "ping") return;
    handleEvent(v);
  };
}

/* ═══════════ DEDUP ═══════════ */
function isRecentDuplicate(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  const now = Date.now();
  while (recentAgentTexts.length && now - recentAgentTexts[0].at > DUP_WINDOW_MS) recentAgentTexts.shift();
  return recentAgentTexts.some((e) => e.text === t);
}
function rememberAgentText(text) {
  const t = (text || "").trim();
  if (!t) return;
  recentAgentTexts.push({ text: t, at: Date.now() });
  if (recentAgentTexts.length > 40) recentAgentTexts.shift();
}

/* ═══════════ EVENT DISPATCH ═══════════ */
function handleEvent(event) {
  if (event.groundingMetadata) renderSearchCardFromGrounding(event.groundingMetadata);
  if (event.inputTranscription?.text) handleInputTranscription(event.inputTranscription);
  if (event.outputTranscription?.text) handleOutputTranscription(event.outputTranscription);

  if (Array.isArray(event.content?.parts)) {
    for (const part of event.content.parts) {
      if (part.functionCall) {
        const name = part.functionCall.name;
        turnSources.tools.add(name);
        if (name !== "suggest_followups" && !renderedToolPillsThisTurn.has(name)) {
          renderedToolPillsThisTurn.add(name);
          addToolPill(name, part.functionCall.args || {});
        }
        showThinkingIndicator();
      }
      if (part.functionResponse) {
        const name = part.functionResponse.name;
        const raw  = part.functionResponse.response;
        const resp = (raw && typeof raw === "object" && "result" in raw) ? raw.result : raw;
        handleToolResponse(name, resp);
      }
      if (typeof part.text === "string" && !part.thought) {
        if (currentAgentEl?.dataset.source === "transcription") continue;
        if (!currentAgentEl) {
          if (isRecentDuplicate(part.text) && part.text.length > 25) {
            hideThinkingIndicator();
            currentAgentEl = null;
            currentAgentText = "";
            continue;
          }
          hideThinkingIndicator();
          currentAgentEl = addMessageBubble("agent", "");
          currentAgentEl.dataset.source = "text";
          currentAgentText = "";
        }
        currentAgentText += part.text;
        currentAgentEl.querySelector(".bubble").textContent = currentAgentText;
        smartScroll();
        if (voiceModeActive) {
          voiceAgentLine = currentAgentText;
          setVoiceState("speaking");
          renderVoiceTranscript();
        }
      }
      // Audio: only played in voice mode
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
        hideThinkingIndicator();
        if (voiceModeActive) {
          playAudioChunk(part.inlineData.data);
          setVoiceState("speaking");
        }
      }
    }
  }

  if (event.interrupted) {
    if (player?._worklet) player._worklet.port.postMessage({ command: "endOfAudio" });
    if (currentAgentEl) currentAgentEl.querySelector(".bubble").classList.add("interrupted");
    hideThinkingIndicator();
    currentAgentEl = null; currentAgentText = "";
    if (voiceModeActive) setVoiceState("listening");
  }

  if (event.turnComplete) {
    hideThinkingIndicator();
    if (currentAgentEl && currentAgentText) {
      if (isRecentDuplicate(currentAgentText)) currentAgentEl.remove();
      else rememberAgentText(currentAgentText);
    }
    renderAggregatedSourcesCard();
    currentAgentEl = null; currentAgentText = "";
    currentUserVoiceEl = null; currentUserVoiceText = "";
    if (voiceModeActive) {
      voiceAgentLine = ""; voiceUserLine = "";
      setVoiceState("listening");
      renderVoiceTranscript();
    }
  }
}

function handleToolResponse(name, resp) {
  if (!resp || typeof resp !== "object") return;
  collectSourcesFromResponse(resp);

  switch (name) {
    case "show_marine_map":
      renderMarineMap(resp);
      break;

    case "get_ocean_conditions":
      renderCombinedCard({
        title: "Ocean Conditions",
        icon: "water_drop",
        tiles: [
          ["SST", resp.sst?.sst_celsius, "°C",
            resp.sst?.sst_fahrenheit ? `${resp.sst.sst_fahrenheit}°F` : ""],
          ["Chlorophyll", resp.chlorophyll?.chlorophyll_mg_m3, "mg/m³",
            resp.chlorophyll?.category || ""],
          ["Wave height", resp.marine?.wave_height_m, "m",
            `Swell ${fmt(resp.marine?.swell_wave_height_m)} m`],
          ["Wave period", resp.marine?.wave_period_s, "s",
            `Dir ${fmt(resp.marine?.wave_direction_deg)}°`],
        ],
        summary: resp.summary,
        sources: [resp.sst?.source, resp.chlorophyll?.source, resp.marine?.source].filter(Boolean),
        map: resp.map,
      });
      break;

    case "get_sst":
      renderCombinedCard({
        title: "Sea Surface Temperature",
        icon: "thermostat",
        tiles: [
          ["SST", resp.sst?.sst_celsius, "°C",
            resp.sst?.sst_fahrenheit ? `${resp.sst.sst_fahrenheit}°F` : ""],
          ["Samples", resp.sst?.samples, "",
            resp.sst?.observation_time ? resp.sst.observation_time.slice(0, 10) : ""],
        ],
        summary: resp.summary,
        sources: [resp.sst?.source].filter(Boolean),
        map: resp.map,
      });
      break;

    case "get_chlorophyll":
      renderCombinedCard({
        title: "Chlorophyll Concentration",
        icon: "eco",
        tiles: [
          ["Chl-a", resp.chlorophyll?.chlorophyll_mg_m3, "mg/m³",
            resp.chlorophyll?.category || ""],
          ["Samples", resp.chlorophyll?.samples, "",
            resp.chlorophyll?.observation_time ? resp.chlorophyll.observation_time.slice(0, 10) : ""],
        ],
        summary: resp.summary,
        sources: [resp.chlorophyll?.source].filter(Boolean),
        map: resp.map,
      });
      break;

    case "get_marine_weather": renderWeatherCard(resp); break;
    case "check_safety":       renderSafetyCard(resp); break;
    case "find_pfz":           renderPFZCard(resp); if (resp.map) renderMarineMap(resp.map); break;
    case "check_geofence":     renderGeofenceCard(resp); break;
    case "find_safe_route":    renderRouteCard(resp); break;
    case "web_search":
      if (!renderedSearchToolCardThisTurn && (resp.results?.length || 0) > 0) {
        renderedSearchToolCardThisTurn = true;
        renderWebSearchToolCard(resp);
      }
      break;
    case "suggest_followups":
      if (!renderedSuggestionsThisTurn) {
        renderedSuggestionsThisTurn = true;
        renderInlineSuggestions(resp.suggestions);
      }
      break;
  }
}

/* ═══════════ COMBINED CARD (single card with tiles + map) ═══════════ */
function renderCombinedCard({ title, icon, tiles, summary, sources, map }) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card map-card";
  card.dataset.kind = "data";

  const tilesHtml = tiles
    .filter((t) => t[1] != null || t[3])
    .map(([k, v, u, sub]) => `
      <div class="stat-tile">
        <div class="k">${escapeHtml(k)}</div>
        <div class="v">${escapeHtml(fmt(v))}${u ? `<span class="u">${escapeHtml(u)}</span>` : ""}</div>
        ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
      </div>`).join("");

  const sourceChips = (sources || []).filter(Boolean).map((s) =>
    `<span class="source-chip"><span class="material-symbols-outlined">article</span><span>${escapeHtml(s)}</span></span>`
  ).join("");

  const mapId = `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const info = map?.wmts;

  const metaHtml = info ? buildMetaRow(map, info) : "";

  const legendHtml = info?.legend?.length
    ? `<div class="legend">${info.legend.map((l) =>
        `<span class="legend-step"><span class="swatch" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.label)}</span>`
      ).join("")}</div>` : "";

  card.innerHTML = `
    <div class="card-head">
      ${makeCardIcon(icon)}
      <h3>${escapeHtml(title)}</h3>
      ${info ? `<span class="badge">${escapeHtml(info.layer_type || "SST")}</span>` : ""}
    </div>
    ${tilesHtml ? `<div class="stat-grid">${tilesHtml}</div>` : ""}
    ${summary ? `<div class="card-body">${escapeHtml(summary)}</div>` : ""}
    ${map ? `${metaHtml}
      <div id="${mapId}" class="map-container"></div>
      <div class="map-bottom">${legendHtml}
        <div class="opacity-row"><label>Overlay</label>
          <input type="range" min="0" max="100" value="85" class="opacity-slider" /></div>
      </div>` : ""}
    ${sourceChips ? `<div class="source-chips">${sourceChips}</div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;

  if (map) {
    const render = () => {
      const el = document.getElementById(mapId);
      if (!el || !window.google?.maps) return;
      const center = { lat: Number(map.latitude), lng: Number(map.longitude) };
      const gmap = new google.maps.Map(el, {
        center, zoom: Number(map.zoom) || 8, mapTypeId: "satellite",
        disableDefaultUI: false, streetViewControl: false,
      });
      const getTileUrl = buildTileUrlGetter(info);
      if (getTileUrl) {
        const overlay = new google.maps.ImageMapType({
          getTileUrl, tileSize: new google.maps.Size(256, 256),
          opacity: 0.85, name: title,
        });
        // insertAt(0) guarantees the tile layer sits directly on top of the
        // base satellite layer (higher priority than any label layers).
        gmap.overlayMapTypes.insertAt(0, overlay);
        const slider = card.querySelector(".opacity-slider");
        slider?.addEventListener("input", () => overlay.setOpacity(Number(slider.value) / 100));
      }
      new google.maps.Marker({
        position: center, map: gmap,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7,
                fillColor: "#ffffff", fillOpacity: 1,
                strokeColor: "#22d3ee", strokeWeight: 3 },
      });
    };
    if (window.google?.maps) render();
    else {
      let n = 0;
      const t = setInterval(() => {
        if (window.google?.maps) { clearInterval(t); render(); }
        else if (++n > 40) { clearInterval(t); }
      }, 200);
    }
  }
}

/* ═══════════ MAP META ROW (with working "verify tile" link) ═══════════ */
function buildMetaRow(map, info) {
  const lat = Number(map?.latitude ?? 0);
  const lon = Number(map?.longitude ?? 0);
  const z = 6;
  const n = 1 << z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const getTileUrl = buildTileUrlGetter(info);
  const sampleTileUrl = getTileUrl ? getTileUrl({ x, y }, z) : null;

  return `<div class="meta-row">
    <span class="material-symbols-outlined">satellite_alt</span>
    <span>${escapeHtml(info.source)}</span>
    <span class="meta-sep">·</span><span>${escapeHtml(info.units)}</span>
    ${info.time ? `<span class="meta-sep">·</span><span>${escapeHtml(info.time.slice(0, 10))}</span>` : ""}
    ${sampleTileUrl ? `<a href="${escapeHtml(sampleTileUrl)}" target="_blank" rel="noopener">verify tile</a>` : ""}
  </div>`;
}

/* ═══════════ THINKING / SCROLL ═══════════ */
function showThinkingIndicator() {
  if (thinkingEl || currentAgentEl) return;
  thinkingEl = document.createElement("div");
  thinkingEl.className = "message agent thinking";
  thinkingEl.innerHTML = `<div class="thinking-bubble">
    <span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>
  </div>`;
  messagesEl.appendChild(thinkingEl);
  smartScroll();
}
function hideThinkingIndicator() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }
function smartScroll() {
  const near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (near) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ═══════════ TOOL PILL ═══════════ */
function addToolPill(name, args) {
  const friendly = {
    web_search: "Web Search", show_marine_map: "Google Maps",
    get_ocean_conditions: "Ocean Analytics", get_sst: "SST Lookup",
    get_chlorophyll: "Chlorophyll", get_marine_weather: "Marine Weather",
    check_safety: "Safety Check", find_pfz: "Fishery Intelligence",
    check_geofence: "Geofence", find_safe_route: "Route Planner",
  }[name] || name;
  const icon = {
    web_search: "travel_explore", show_marine_map: "map",
    get_ocean_conditions: "water_drop", get_sst: "thermostat",
    get_chlorophyll: "eco", get_marine_weather: "air",
    check_safety: "shield", find_pfz: "phishing",
    check_geofence: "my_location", find_safe_route: "sailing",
  }[name] || "bolt";

  const div = document.createElement("div");
  div.className = "message agent";
  let argsHtml = "";
  if (args && typeof args === "object" && Object.keys(args).length) {
    argsHtml = Object.entries(args)
      .map(([k, v]) => `<span class="pill-arg"><strong>${escapeHtml(k)}</strong> ${escapeHtml(JSON.stringify(v))}</span>`)
      .join("");
  }
  div.innerHTML = `<details class="tool-pill">
    <summary><span class="pill-icon material-symbols-outlined">${icon}</span>
      <span class="pill-label">${escapeHtml(friendly)}</span>
      <span class="pill-chevron material-symbols-outlined">expand_more</span></summary>
    ${argsHtml ? `<div class="pill-args">${argsHtml}</div>` : ""}
  </details>`;
  messagesEl.appendChild(div);
  smartScroll();
}

/* ═══════════ VOICE MODE ═══════════ */
async function enterVoiceMode() {
  if (voiceModeActive) return;
  voiceModeActive = true;
  document.getElementById("app").style.display = "none";
  voiceView.classList.remove("hidden");
  voiceView.classList.remove("no-cards");
  voiceView.classList.remove("state-listening", "state-speaking", "state-muted");
  voiceView.classList.add("state-listening");
  voiceResearch.appendChild(researchCards);

  voiceAgentLine = ""; voiceUserLine = "";
  voiceTranscript.innerHTML = "";
  voiceStatusText.textContent = "I'm listening";
  voiceSubstatus.textContent = "Speak naturally — the agent will respond in real time.";
  voiceOrbIcon.textContent = "graphic_eq";
  voiceHint.classList.remove("hidden");

  try { await startMic(); setVoiceState("listening"); }
  catch (e) {
    showToast("Microphone unavailable", "error");
    voiceHint.innerHTML = '<span class="material-symbols-outlined">error</span><span>Microphone unavailable.</span>';
  }

  if (!userHasSentMessage) {
    sendPrimer("Greet the user warmly in ONE short English sentence. Introduce yourself briefly as their marine assistant.");
  }
}

function exitVoiceMode() {
  if (!voiceModeActive) return;
  voiceModeActive = false;
  stopMic();
  voiceView.classList.add("hidden");
  document.getElementById("app").style.display = "";
  researchPanel.appendChild(researchCards);
  voiceAgentLine = ""; voiceUserLine = "";
  voiceTranscript.innerHTML = "";
  voiceSourcesPop.classList.add("hidden");
}

function setVoiceState(state) {
  voiceView.classList.remove("state-listening", "state-speaking", "state-muted");
  voiceView.classList.add(`state-${state}`);
  if (voiceOrb) voiceOrb.dataset.state = state;
  if (state === "speaking") {
    voiceStatusText.textContent = "SAMUDRA AI Responding";
    voiceSubstatus.textContent = "The assistant is speaking…";
    voiceOrbIcon.textContent = "volume_up";
    if (voiceSpeakTimer) clearTimeout(voiceSpeakTimer);
    voiceSpeakTimer = setTimeout(() => { if (voiceModeActive) setVoiceState("listening"); }, 8000);
  } else if (state === "listening") {
    voiceStatusText.textContent = "I'm listening";
    voiceSubstatus.textContent = "Speak naturally — the assistant will respond in real time.";
    voiceOrbIcon.textContent = "graphic_eq";
    if (voiceSpeakTimer) { clearTimeout(voiceSpeakTimer); voiceSpeakTimer = null; }
  } else if (state === "muted") {
    voiceStatusText.textContent = "Microphone muted";
    voiceSubstatus.textContent = "Tap the mic button to resume.";
    voiceOrbIcon.textContent = "mic_off";
  }
}

function renderVoiceTranscript() {
  const now = Date.now();
  if (now - lastVoiceUpdate < 90) return;
  lastVoiceUpdate = now;
  const parts = [];
  if (voiceAgentLine) parts.push(`<div class="agent-line">${escapeHtml(voiceAgentLine)}</div>`);
  if (voiceUserLine) parts.push(`<div class="user-line">${escapeHtml(voiceUserLine)}</div>`);
  voiceTranscript.innerHTML = parts.join("");
}

function sendPrimer(text) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "text", text }));
}

/* ═══════════ TRANSCRIPTION ═══════════ */
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
  smartScroll();
  if (voiceModeActive) {
    voiceUserLine = currentUserVoiceText;
    voiceHint.classList.add("hidden");
    setVoiceState("listening");
    renderVoiceTranscript();
  }
}

function handleOutputTranscription(t) {
  if (!t.text || !t.text.trim()) return;
  if (!currentAgentEl) {
    hideThinkingIndicator();
    currentAgentEl = addMessageBubble("agent", "");
    currentAgentEl.dataset.source = "transcription";
    currentAgentText = "";
  }
  currentAgentText = t.finished ? t.text
    : (currentAgentText.endsWith(t.text) ? t.text : currentAgentText + t.text);
  currentAgentEl.querySelector(".bubble").textContent = currentAgentText;
  smartScroll();
  if (voiceModeActive) {
    voiceAgentLine = currentAgentText;
    setVoiceState("speaking");
    renderVoiceTranscript();
  }
}

/* ═══════════ AUDIO ═══════════ */
async function ensurePlayer() {
  if (player) return;
  player = new AudioPlayer();
  await player.init();
}
async function playAudioChunk(b64) {
  try { await ensurePlayer(); player.play(base64ToBytes(b64)); }
  catch (e) { console.error(e); }
}

/* ═══════════ BUBBLES ═══════════ */
function clearEmptyState() {
  researchCards.querySelector(".empty-research")?.remove();
  researchCards.querySelector(".empty-state")?.remove();
}

function addMessageBubble(role, text) {
  messagesEl.querySelector(".empty-chat")?.remove();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div><div class="time">${time}</div>`;
  messagesEl.appendChild(div);
  smartScroll();
  return div;
}

function humanToolName(name) {
  return { web_search: "Web Search", show_marine_map: "Map renderer",
    get_ocean_conditions: "Ocean Analytics", get_sst: "SST lookup",
    get_chlorophyll: "Chlorophyll lookup", get_marine_weather: "Weather",
    check_safety: "Safety check", find_pfz: "Fishery Intelligence",
    check_geofence: "Geofence", find_safe_route: "Route planner",
    suggest_followups: "Follow-ups" }[name] || name;
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
    chip.addEventListener("click", () => { textInput.value = chip.dataset.suggestion || ""; sendText(); });
  });
  messagesEl.appendChild(wrap);
  smartScroll();
}

/* ═══════════ SOURCE AGGREGATION ═══════════ */
function collectSourcesFromResponse(resp) {
  const scan = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 4) return;
    if (typeof obj.source === "string") {
      const s = obj.source;
      if (s.includes("Copernicus")) turnSources.copernicus.add(s);
      else if (s.includes("NOAA")) turnSources.noaa.add(s);
      else if (s.includes("Open-Meteo")) turnSources.openmeteo.add(s);
    }
    for (const k of Object.keys(obj)) {
      if (obj[k] && typeof obj[k] === "object") scan(obj[k], depth + 1);
    }
  };
  scan(resp);
  if (resp.wmts?.source) {
    const s = resp.wmts.source;
    if (s.includes("Copernicus")) turnSources.copernicus.add(s);
    else if (s.includes("NOAA")) turnSources.noaa.add(s);
  }
  if (Array.isArray(resp.results)) {
    for (const r of resp.results) {
      if (r && r.url) {
        const key = r.title || r.url;
        if (!turnSources.web.has(key)) turnSources.web.set(key, r.url);
      }
    }
  }
}

function renderAggregatedSourcesCard() {
  const hasAny = turnSources.copernicus.size || turnSources.noaa.size ||
                 turnSources.openmeteo.size || turnSources.web.size || turnSources.tools.size;
  if (!hasAny) return;

  researchCards.querySelector('[data-card="sources"]')?.remove();

  const count = turnSources.copernicus.size + turnSources.noaa.size +
                turnSources.openmeteo.size + turnSources.web.size;
  if (count === 0 && turnSources.tools.size === 0) return;

  const card = document.createElement("div");
  card.className = "grounding-card sources-card";
  card.dataset.card = "sources";
  card.dataset.kind = "sources";

  const groups = [];
  if (turnSources.copernicus.size) groups.push(`
    <div class="source-group">
      <div class="source-group-label"><span class="material-symbols-outlined">satellite_alt</span>Satellite overlay</div>
      <div class="source-chips">${[...turnSources.copernicus].map((s) =>
        `<span class="source-chip"><span class="material-symbols-outlined">public</span><span>${escapeHtml(s)}</span></span>`
      ).join("")}</div>
    </div>`);
  if (turnSources.noaa.size) groups.push(`
    <div class="source-group">
      <div class="source-group-label"><span class="material-symbols-outlined">science</span>Oceanographic</div>
      <div class="source-chips">${[...turnSources.noaa].map((s) =>
        `<span class="source-chip"><span class="material-symbols-outlined">science</span><span>${escapeHtml(s)}</span></span>`
      ).join("")}</div>
    </div>`);
  if (turnSources.openmeteo.size) groups.push(`
    <div class="source-group">
      <div class="source-group-label"><span class="material-symbols-outlined">air</span>Meteorological</div>
      <div class="source-chips">${[...turnSources.openmeteo].map((s) =>
        `<span class="source-chip"><span class="material-symbols-outlined">cloud</span><span>${escapeHtml(s)}</span></span>`
      ).join("")}</div>
    </div>`);
  if (turnSources.web.size) groups.push(`
    <div class="source-group">
      <div class="source-group-label"><span class="material-symbols-outlined">travel_explore</span>Web sources</div>
      <div class="source-chips">${[...turnSources.web.entries()].slice(0, 8).map(([title, url]) =>
        `<a class="source-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">
           <span class="material-symbols-outlined">article</span><span>${escapeHtml(title)}</span></a>`
      ).join("")}</div>
    </div>`);
  if (turnSources.tools.size) groups.push(`
    <div class="source-group">
      <div class="source-group-label"><span class="material-symbols-outlined">bolt</span>Specialists invoked</div>
      <div class="source-chips">${[...turnSources.tools].map((t) =>
        `<span class="source-chip"><span class="material-symbols-outlined">check</span><span>${escapeHtml(humanToolName(t))}</span></span>`
      ).join("")}</div>
    </div>`);

  card.innerHTML = `<div class="card-head">
    <div class="card-icon"><span class="material-symbols-outlined">source</span></div>
    <h3>Sources used</h3>
    <span class="badge outline">${count} source${count !== 1 ? "s" : ""}</span>
  </div>
  <div class="sources-groups">${groups.join("")}</div>`;

  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

/* ═══════════ TILES ═══════════ */
function buildTileUrlGetter(info) {
  if (!info) return null;
  if (info.provider === "copernicus_wmts" && info.tile_template) {
    const tpl = info.tile_template;
    return (coord, zoom) => tpl.replace("{z}", zoom).replace("{x}", coord.x).replace("{y}", coord.y);
  }
  if (info.provider === "erddap_wms" && info.dataset_id && info.variable) {
    const ds = info.dataset_id, v = info.variable;
    return (coord, zoom) => {
      const n = Math.pow(2, zoom);
      const lonMin = coord.x / n * 360 - 180, lonMax = (coord.x + 1) / n * 360 - 180;
      const latMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / n))) * 180 / Math.PI;
      const latMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / n))) * 180 / Math.PI;
      const bbox = `${lonMin},${latMin},${lonMax},${latMax}`;
      return `https://coastwatch.pfeg.noaa.gov/erddap/wms/${ds}/request`
        + `?service=WMS&version=1.1.1&request=GetMap&layers=${v}&styles=`
        + `&srs=EPSG:4326&bbox=${bbox}&width=256&height=256&format=image/png&transparent=true`;
    };
  }
  return null;
}
function makeCardIcon(name) { return `<div class="card-icon"><span class="material-symbols-outlined">${name}</span></div>`; }

/* ═══════════ MAP CARD (used only by show_marine_map) ═══════════ */
function renderMarineMap(data) {
  const key = `${data.layer_type}|${Number(data.latitude).toFixed(2)}|${Number(data.longitude).toFixed(2)}`;
  if (renderedMapKeys.has(key)) return;
  renderedMapKeys.add(key);

  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card map-card";
  card.dataset.kind = "map";
  const mapId = `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const info = data.wmts;
  const layerName = info?.title || ({ SST: "Sea Surface Temperature",
    CHL: "Chlorophyll Concentration", PFZ: "Potential Fishing Zone" }[data.layer_type]) || data.layer_type;

  const legendHtml = info?.legend?.length
    ? `<div class="legend">${info.legend.map((l) =>
        `<span class="legend-step"><span class="swatch" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.label)}</span>`
      ).join("")}</div>` : "";

  const providerLabel = info?.provider === "copernicus_wmts" ? "Copernicus WMTS"
    : info?.provider === "erddap_wms" ? "ERDDAP WMS" : "—";

  const metaHtml = info ? buildMetaRow(data, info) : "";

  card.innerHTML = `<div class="card-head">
    ${makeCardIcon("satellite_alt")}
    <h3>${escapeHtml(layerName)}</h3>
    <span class="badge">${escapeHtml(data.layer_type)}</span>
    <span class="badge outline">${escapeHtml(providerLabel)}</span>
  </div>
  ${metaHtml}
  <div id="${mapId}" class="map-container"></div>
  <div class="map-bottom">${legendHtml}
    <div class="opacity-row"><label>Overlay</label>
      <input type="range" min="0" max="100" value="85" class="opacity-slider" /></div>
  </div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;

  const render = () => {
    const el = document.getElementById(mapId);
    if (!el || !window.google?.maps) return;
    const center = { lat: Number(data.latitude), lng: Number(data.longitude) };
    const map = new google.maps.Map(el, {
      center, zoom: Number(data.zoom) || 8, mapTypeId: "satellite",
      disableDefaultUI: false, streetViewControl: false,
    });
    const getTileUrl = buildTileUrlGetter(info);
    if (getTileUrl) {
      const overlay = new google.maps.ImageMapType({
        getTileUrl, tileSize: new google.maps.Size(256, 256),
        opacity: 0.85, name: layerName,
      });
      // Guarantees the tile layer sits on top of the base satellite layer.
      map.overlayMapTypes.insertAt(0, overlay);
      const slider = card.querySelector(".opacity-slider");
      slider?.addEventListener("input", () => overlay.setOpacity(Number(slider.value) / 100));
    }
    new google.maps.Marker({
      position: center, map,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7,
              fillColor: "#ffffff", fillOpacity: 1,
              strokeColor: "#22d3ee", strokeWeight: 3 },
    });
  };
  if (window.google?.maps) render();
  else {
    let n = 0;
    const t = setInterval(() => {
      if (window.google?.maps) { clearInterval(t); render(); }
      else if (++n > 40) { clearInterval(t); }
    }, 200);
  }
}

/* ═══════════ OTHER CARDS ═══════════ */
function renderWeatherCard(resp) {
  clearEmptyState();
  const w = resp.weather || {}, m = resp.marine || {};
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "data";
  card.innerHTML = `<div class="card-head">${makeCardIcon("air")}<h3>Marine Weather</h3></div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="k">Wind</div><div class="v">${fmt(w.wind_speed_kt)}<span class="u">kt</span></div><div class="sub">Gusts ${fmt(w.wind_gusts_kt)} kt</div></div>
      <div class="stat-tile"><div class="k">Waves</div><div class="v">${fmt(m.wave_height_m)}<span class="u">m</span></div><div class="sub">Period ${fmt(m.wave_period_s)} s</div></div>
      <div class="stat-tile"><div class="k">Swell</div><div class="v">${fmt(m.swell_wave_height_m)}<span class="u">m</span></div><div class="sub">Dir ${fmt(m.swell_wave_direction_deg)}°</div></div>
      <div class="stat-tile"><div class="k">Air temp</div><div class="v">${fmt(w.temperature_c)}<span class="u">°C</span></div><div class="sub">Humidity ${fmt(w.humidity_pct)}%</div></div>
      <div class="stat-tile"><div class="k">Visibility</div><div class="v">${w.visibility_m ? (w.visibility_m/1000).toFixed(1) : "—"}<span class="u">km</span></div></div>
      <div class="stat-tile"><div class="k">Precip.</div><div class="v">${fmt(w.precipitation_mm)}<span class="u">mm</span></div></div>
    </div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    <div class="source-chips">
      ${w.source ? `<span class="source-chip"><span class="material-symbols-outlined">cloud</span><span>${escapeHtml(w.source)}</span></span>` : ""}
      ${m.source ? `<span class="source-chip"><span class="material-symbols-outlined">waves</span><span>${escapeHtml(m.source)}</span></span>` : ""}
    </div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderSafetyCard(resp) {
  clearEmptyState();
  const level = resp.level || "safe";
  const cls = level === "safe" ? "success" : level === "warning" ? "warning" : "danger";
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "data";
  card.innerHTML = `<div class="card-head">
      ${makeCardIcon(level === "safe" ? "shield" : "warning")}<h3>Safety Assessment</h3>
      <span class="badge ${cls}">${escapeHtml(level.toUpperCase())}</span>
    </div>
    ${resp.hazards?.length ? `<div class="info-body warning" style="margin-bottom:8px;"><strong>Hazards:</strong> ${escapeHtml(resp.hazards.join("; "))}</div>` : ""}
    ${resp.advisories?.length ? `<div class="card-body"><strong>Advisories:</strong> ${escapeHtml(resp.advisories.join("; "))}</div>` : ""}
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    ${resp.nearest_harbour ? `<div class="source-chips"><span class="source-chip"><span class="material-symbols-outlined">anchor</span><span>Nearest: ${escapeHtml(resp.nearest_harbour.name)} (${resp.nearest_harbour.distance_nm} nm)</span></span></div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderPFZCard(resp) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "data";
  const label = resp.likely === true ? "LIKELY" : resp.likely === false ? "UNLIKELY" : "NO DATA";
  const cls = resp.likely === true ? "success" : resp.likely === false ? "" : "warning";
  card.innerHTML = `<div class="card-head">${makeCardIcon("phishing")}<h3>Potential Fishing Zone</h3>
      <span class="badge ${cls}">${label}</span></div>
    <div class="stat-grid">
      <div class="stat-tile"><div class="k">Chl-a</div><div class="v">${fmt(resp.chlorophyll?.chlorophyll_mg_m3)}<span class="u">mg/m³</span></div></div>
      <div class="stat-tile"><div class="k">SST</div><div class="v">${fmt(resp.sst?.sst_celsius)}<span class="u">°C</span></div></div>
      <div class="stat-tile"><div class="k">Waves</div><div class="v">${fmt(resp.marine?.wave_height_m)}<span class="u">m</span></div></div>
    </div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>
    ${resp.reasons?.length ? `<div class="source-chips">${resp.reasons.map((r) => `<span class="source-chip"><span class="material-symbols-outlined">check</span><span>${escapeHtml(r)}</span></span>`).join("")}</div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderGeofenceCard(resp) {
  clearEmptyState();
  const level = resp.level || "safe";
  const cls = level === "safe" ? "success" : level === "warning" ? "warning" : "danger";
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "data";
  card.innerHTML = `<div class="card-head">
      ${makeCardIcon(level === "safe" ? "shield" : "warning")}<h3>Geofence Check</h3>
      <span class="badge ${cls}">${escapeHtml(level.toUpperCase())}</span></div>
    <div class="info-body ${level === "safe" ? "success" : "warning"}">${escapeHtml(resp.summary || "")}</div>
    ${resp.nearest_harbours?.length ? `<div class="source-chips">${
      resp.nearest_harbours.map((h) => `<span class="source-chip"><span class="material-symbols-outlined">anchor</span><span>${escapeHtml(h.name)} · ${h.distance_nm} nm</span></span>`).join("")
    }</div>` : ""}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderRouteCard(resp) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "data";
  const rows = (resp.waypoints || []).map((w) => {
    const c = w.risk === "severe" ? "#fca5a5" : w.risk === "high" ? "#fcd34d"
            : w.risk === "moderate" ? "#fde68a" : "#6ee7b7";
    return `<div class="stat-tile">
      <div class="k">${w.lat.toFixed(2)}, ${w.lon.toFixed(2)}</div>
      <div class="v">${fmt(w.wave_height_m)}<span class="u">m</span></div>
      <div class="sub" style="text-transform:uppercase;font-weight:700;color:${c};">${escapeHtml(w.risk)}</div>
    </div>`;
  }).join("");
  card.innerHTML = `<div class="card-head">${makeCardIcon("sailing")}<h3>Safe Route</h3>
      <span class="badge">${escapeHtml((resp.risk || "").toUpperCase())}</span></div>
    <div class="stat-grid">${rows}</div>
    <div class="card-body">${escapeHtml(resp.summary || "")}</div>`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

function renderWebSearchToolCard(resp) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "sources";
  const query = resp.query || "";
  const results = resp.results || [];
  const resultsHtml = results.length
    ? `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
        ${results.slice(0, 5).map((r) => `
          <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"
             style="display:block;padding:12px 14px;border:1px solid var(--border-hi);border-radius:10px;text-decoration:none;color:inherit;background:rgba(8,18,34,0.5);transition:all 0.2s;">
            <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:3px;line-height:1.35;">${escapeHtml(r.title)}</div>
            <div style="font-size:11.5px;color:var(--ink-3);line-height:1.5;">${escapeHtml(r.snippet || "")}</div>
          </a>`).join("")}
       </div>` : "";
  card.innerHTML = `<div class="card-head">${makeCardIcon("travel_explore")}<h3>Web Search</h3></div>
    ${query ? `<div class="query-chips"><span class="query-chip"><span class="material-symbols-outlined">search</span>${escapeHtml(query)}</span></div>` : ""}
    ${resultsHtml}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

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
    if (chunk.retrievedContext) sources.push({ title: chunk.retrievedContext.title, url: chunk.retrievedContext.uri });
  }
  const media = [];
  const allImages = images.concat(attachments.filter((a) => a?.image).map((a) => a.image));
  for (const img of allImages) {
    const src = img.source?.uri || img.source_uri || "";
    const thumb = img.thumbnail?.uri || img.thumbnail_uri || img.source?.uri || "";
    const title = img.source?.title || img.source_title || "";
    if (!thumb) continue;
    media.push({ src, thumb, title, videoId: extractYouTubeId(src) || extractYouTubeId(thumb) });
  }
  let summary = "";
  if (supports.length) summary = supports.map((s) => s.segment?.text || "").filter(Boolean).join(" ").trim();
  if (!queries.length && !sources.length && !media.length && !summary) return;
  renderedSearchThisTurn = true;
  for (const s of sources) if (s.url && !turnSources.web.has(s.title || s.url)) turnSources.web.set(s.title || s.url, s.url);
  renderSearchCard({ queries, sources, media, summary });
}

function renderSearchCard({ queries, sources, media, summary }) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "grounding-card";
  card.dataset.kind = "sources";
  const title = queries[0] ? prettify(queries[0]) : "Web Search Results";
  const queryHtml = queries.length
    ? `<div class="query-chips">${queries.map((q) =>
        `<span class="query-chip"><span class="material-symbols-outlined">search</span>${escapeHtml(q)}</span>`).join("")}</div>` : "";
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
          ${m.title ? `<span class="img-label">${escapeHtml(m.title)}</span>` : ""}</a>`);
      }
    }
    mediaHtml = `<div class="media-mosaic">${cells.join("")}</div>`;
  }
  const summaryHtml = summary ? `<div class="card-body">${escapeHtml(summary)}</div>` : "";
  const sourceHtml = sources.length
    ? `<div class="source-chips">${sources.slice(0, 8).map((s) =>
        `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
           <span class="material-symbols-outlined">article</span><span>${escapeHtml(s.title || s.url)}</span></a>`).join("")}</div>` : "";
  card.innerHTML = `<div class="card-head">${makeCardIcon("travel_explore")}<h3>${escapeHtml(title)}</h3></div>
    ${queryHtml}${mediaHtml}${summaryHtml}${sourceHtml}`;
  researchCards.appendChild(card);
  researchCards.scrollTop = researchCards.scrollHeight;
}

/* ═══════════ INPUT ═══════════ */
async function sendText() {
  const text = textInput.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  userHasSentMessage = true;
  if (!firstUserMessageSent && tryAskingEl) {
    tryAskingEl.style.display = "none";
    firstUserMessageSent = true;
  }
  renderedMapKeys = new Set();
  renderedSuggestionsThisTurn = false;
  renderedSearchThisTurn = false;
  renderedSearchToolCardThisTurn = false;
  renderedToolPillsThisTurn = new Set();
  turnSources = freshBucket();
  await ensurePlayer();
  addMessageBubble("user", text);
  textInput.value = "";
  showThinkingIndicator();
  ws.send(JSON.stringify({ type: "text", text }));
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
});

/* ═══════════ COPILOT-STYLE PRODUCT FLOW LISTENERS ═══════════ */
// Landing Page Buttons
document.getElementById("landing-auth-btn")?.addEventListener("click", () => showScreen("auth"));
document.getElementById("landing-explore-btn")?.addEventListener("click", () => {
  showScreen("app");
  setAppView("home");
});
document.getElementById("hero-start-btn")?.addEventListener("click", () => {
  showScreen("app");
  setAppView("home");
});
document.getElementById("hero-voice-btn")?.addEventListener("click", async () => {
  showScreen("app");
  try { await enterVoiceMode(); } catch (e) { showToast("Voice mode error: " + e.message, "error"); }
});

// Demo Auth Buttons
document.querySelectorAll(".demo-login-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const provider = btn.dataset.provider || "Guest";
    UIState.isDemoAuthed = true;
    UIState.userName = provider === "Guest" ? "Guest Explorer" : `${provider} User`;
    if (profileName) profileName.textContent = UIState.userName;
    if (profileStatus) profileStatus.textContent = provider === "Guest" ? "Demo Guest" : `${provider} Authenticated`;
    showToast(`Signed in as ${UIState.userName} (Demo)`, "success");
    showScreen("app");
    setAppView("home");
  });
});

// Navigation Tabs
document.querySelectorAll(".main-nav .nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const nav = tab.dataset.nav;
    if (nav) setAppView(nav);
  });
});

appBrandBtn?.addEventListener("click", () => setAppView("home"));

// AI Home Prompt Input
function handleHomePromptSend() {
  const query = homeTextInput?.value.trim();
  if (!query) return;
  textInput.value = query;
  if (homeTextInput) homeTextInput.value = "";
  setAppView("chat");
  sendText();
}

homeSendBtn?.addEventListener("click", handleHomePromptSend);
homeTextInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleHomePromptSend(); }
});
homeMicBtn?.addEventListener("click", async () => {
  setAppView("chat");
  try { await enterVoiceMode(); } catch (e) { showToast("Voice mode error: " + e.message, "error"); }
});

// Profile Menu Toggle & Actions
profileBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu?.classList.toggle("hidden");
});
document.addEventListener("click", () => profileMenu?.classList.add("hidden"));

document.getElementById("menu-explore-btn")?.addEventListener("click", () => setAppView("explore"));
document.getElementById("menu-voice-btn")?.addEventListener("click", async () => {
  try { await enterVoiceMode(); } catch (e) { showToast("Voice mode error: " + e.message, "error"); }
});
document.getElementById("menu-signout-btn")?.addEventListener("click", () => {
  UIState.isDemoAuthed = false;
  showToast("Signed out of demo session", "warning");
  showScreen("landing");
});

document.querySelectorAll(".chip-suggestion").forEach((btn) => {
  btn.addEventListener("click", () => {
    const query = btn.dataset.suggestion || "";
    textInput.value = query;
    setAppView("chat");
    sendText();
  });
});

/* ═══════════ RESPONSIVE & NAVIGATION LISTENERS ═══════════ */
togglePanelBtn?.addEventListener("click", toggleDesktopPanel);
topbarVoiceBtn?.addEventListener("click", async () => {
  try { await enterVoiceMode(); } catch (e) { showToast("Voice mode error: " + e.message, "error"); }
});

document.querySelectorAll(".tablet-switcher .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view) setAppView(view);
  });
});

document.querySelectorAll(".mobile-nav .nav-item").forEach((item) => {
  item.addEventListener("click", async () => {
    const tab = item.dataset.tab;
    if (tab === "voice") {
      try { await enterVoiceMode(); } catch (e) { showToast("Voice mode error: " + e.message, "error"); }
    } else if (tab) {
      setAppView(tab);
    }
  });
});

bsCloseBtn?.addEventListener("click", closeBottomSheet);

/* ═══════════ RESEARCH CONTROLS ═══════════ */
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const filter = btn.dataset.filter;
    UIState.activeFilter = filter;
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    researchCards.querySelectorAll(".grounding-card").forEach((card) => {
      const kind = card.dataset.kind || "other";
      card.classList.toggle("hidden", filter !== "all" && kind !== filter);
    });
  });
});

clearBtn.addEventListener("click", () => {
  researchCards.innerHTML = `<div class="empty-research">
    <div class="empty-research-icon"><span class="material-symbols-outlined">travel_explore</span></div>
    <h3>Operational Intelligence Feed</h3>
    <p>Grounding results, live satellite maps, marine weather, and data provenance will appear here.</p>
  </div>`;
});

newChatBtn.addEventListener("click", () => location.reload());

/* ═══════════ MIC ═══════════ */
function onAudioData(buf) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(new Uint8Array(buf));
}
async function startMic() {
  await ensurePlayer();
  if (!recorder) { recorder = new AudioRecorder(onAudioData); await recorder.start(); }
  micOn = true;
  startBtn.classList.add("recording");
  startBtn.querySelector(".material-symbols-outlined").textContent = "mic_off";
  voiceMuteBtn.classList.add("active");
  voiceMuteBtn.querySelector(".material-symbols-outlined").textContent = "mic";
  if (voiceModeActive) setVoiceState("listening");
}
function stopMic() {
  if (recorder) { try { recorder.stop(); } catch {} recorder = null; }
  micOn = false;
  startBtn.classList.remove("recording");
  startBtn.querySelector(".material-symbols-outlined").textContent = "mic";
  voiceMuteBtn.classList.remove("active");
  voiceMuteBtn.querySelector(".material-symbols-outlined").textContent = "mic_off";
  if (voiceModeActive) setVoiceState("muted");
}
startBtn.addEventListener("click", async () => {
  if (voiceModeActive) return;
  try { await enterVoiceMode(); } catch (e) { showToast("Voice mode failed: " + e.message, "error"); }
});
voiceExitBtn.addEventListener("click", exitVoiceMode);
voiceMuteBtn.addEventListener("click", async () => {
  if (micOn) stopMic();
  else { try { await startMic(); } catch (e) { console.error(e); } }
});
voiceCardsBtn.addEventListener("click", () => {
  voiceView.classList.toggle("no-cards");
  voiceCardsBtn.classList.toggle("active", !voiceView.classList.contains("no-cards"));
});
voiceSettingsBtn.addEventListener("click", () => voiceSourcesPop.classList.toggle("hidden"));
voiceSourcesClose.addEventListener("click", () => voiceSourcesPop.classList.add("hidden"));

document.addEventListener("keydown", (e) => {
  if (!voiceModeActive) return;
  if (e.key === "Escape") exitVoiceMode();
  if (e.key.toLowerCase() === "m") voiceMuteBtn.click();
  if (e.key.toLowerCase() === "c") voiceCardsBtn.click();
});

/* ═══════════ UTILS ═══════════ */
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function base64ToBytes(b64) {
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  const bin = atob(std); const bytes = new Uint8Array(bin.length);
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