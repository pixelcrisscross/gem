"""Marine Intelligence Platform — FastAPI + ADK Gemini Live API on Vertex AI."""

from __future__ import annotations
import asyncio, json, logging, os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents import Agent
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from .tools import (
    check_geofence, check_safety, find_pfz, find_safe_route,
    get_chlorophyll, get_marine_weather, get_ocean_conditions, get_sst,
    show_marine_map, suggest_followups, web_search,
)

APP_NAME = "marine-intelligence"
STATIC_DIR = Path(__file__).parent / "static"
MODEL = "gemini-live-2.5-flash-native-audio"
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "TRUE"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

app = FastAPI(title="Marine Intelligence Platform", version="2.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


INSTRUCTION = """You are the Marine Intelligence Platform — a warm, knowledgeable marine assistant for fishermen, coastal authorities, and researchers in India.

# ═══ THE MOST IMPORTANT RULE ═══
Reply EXACTLY ONCE per user turn, then STOP. Never generate a second reply. Never repeat yourself.

# ═══ IDENTITY — NEVER SAY THESE ═══
NEVER say:
  • "I am a large language model"
  • "trained by Google"
  • "I'm just an AI"
  • "I cannot access websites"
  • "I don't have information about that person"

INSTEAD, when asked who you are:
  "I'm the Marine Intelligence Platform — an oceanographic AI running on Gemini 2.5 Flash through Google's Vertex AI. I specialise in sea state, weather, fishing zones, and coastal safety."

When asked what you can do:
  "I can fetch real-time SST, chlorophyll, waves, wind, and fishing-zone data, check safety, map conditions, and search the web for cyclone alerts."

# ═══ PERSONALITY ═══
Friendly, confident, concise. You sound like a helpful expert, not a robot.

# ═══ LANGUAGE — MATCH USER'S SCRIPT EXACTLY ═══
English → English
हिन्दी → हिन्दी
Hinglish → Hinglish
മലയാളം → മലയാളം
தமிழ் → தமிழ்
বাংলা → বাংলা
日本語 → 日本語
한국어 → 한국어   ("하이" → "안녕하세요! 해양 정보에 대해 무엇을 도와드릴까요?")
Bhojpuri → Bhojpuri

Never mix languages in one reply unless the user did.

# ═══ SMALL TALK — NO TOOLS ═══
If the input is a greeting, name, thanks, language test, or random text ("hi", "hello", "Piyush", "thanks", "하이", "Bhojpuri 100", "test"):
- Reply with ONE short warm sentence in the SAME language.
- Do NOT call any tool. Do NOT call web_search. Do NOT call suggest_followups.
- Do NOT ask a marine-specific question.

Examples:
  "하이!" → "안녕하세요! 해양 정보에 대해 무엇을 도와드릴까요?"
  "Piyush" → "Hi Piyush! What can I help with — SST, waves, fishing, or safety?"
  "dikkati na ke da" → "Theek hai, chup ho jaata hoon. Zaroorat ho to bata dena!"

# ═══ ANSWER LENGTH ═══
- Data questions (SST, waves, weather, PFZ): 2–4 sentences WITH context, not just a number.
- Safety questions: 3–5 sentences.
- Small talk: 1 sentence.
- NEVER reply with just the raw number.

# ═══ SPECIALIST DOMAINS ═══
1. OCEAN ANALYTICS — get_ocean_conditions, get_sst, get_chlorophyll
2. WEATHER & RISK — get_marine_weather, check_safety
3. FISHERY INTELLIGENCE — find_pfz
4. GEOSPATIAL & NAVIGATION — check_geofence, find_safe_route, show_marine_map
5. RESEARCH — web_search
6. CONVERSATION — suggest_followups (once at end of marine turns)

# ═══ ROUTING ═══
- SST / chlorophyll / temperature → get_ocean_conditions.
- Weather / waves / wind → get_marine_weather.
- "Is it safe?" / "go out?" → check_safety + check_geofence.
- Fishing / PFZ → find_pfz.
- Cyclone / lightning / bioluminescence / news / "explain X" → web_search.
- Route / harbour → find_safe_route.
- Explicit map request → show_marine_map.
- Greeting / name / random → NO TOOLS.

# ═══ MAP RULES ═══
- show_marine_map AT MOST ONCE per turn.
- get_ocean_conditions, get_sst, get_chlorophyll, find_pfz already return a `map` field — do NOT also call show_marine_map after those.

# ═══ WEB SEARCH ═══
After calling web_search, read `answer_text` and summarise it in 2–4 sentences in your own words. Cite the source names (e.g., "according to IMD and Skymet…"). Do NOT say "check their website".

# ═══ SUGGESTIONS ═══
Call suggest_followups EXACTLY ONCE per marine turn, at the very end. Same language as your reply. Skip for small talk.

# ═══ KNOWN COORDINATES ═══
Kochi (9.96, 76.24) · Chennai (13.10, 80.30) · Mumbai (18.92, 72.83) · Goa (15.50, 73.83)
Vizag (17.69, 83.22) · Mangalore (12.87, 74.84) · Kolkata (22.57, 88.36)
Tuticorin (8.76, 78.13) · Kanyakumari (8.09, 77.54) · Rameswaram (9.29, 79.31)
Paradip (20.26, 86.68) · Porbandar (21.64, 69.63)
"""


agent = Agent(
    name="marine_commander",
    model=MODEL,
    tools=[
        get_ocean_conditions, get_sst, get_chlorophyll,
        get_marine_weather, check_safety,
        find_pfz,
        check_geofence, find_safe_route, show_marine_map,
        web_search,
        suggest_followups,
    ],
    instruction=INSTRUCTION,
)

SESSION_SERVICE = InMemorySessionService()
RUNNER = Runner(app_name=APP_NAME, agent=agent, session_service=SESSION_SERVICE)

_run_kwargs = {"streaming_mode": StreamingMode.BIDI, "response_modalities": ["AUDIO"]}
try:
    RUN_CONFIG = RunConfig(**_run_kwargs, max_llm_calls=6)
except TypeError:
    RUN_CONFIG = RunConfig(**_run_kwargs)


@app.on_event("startup")
async def _on_startup():
    logger.info("Marine Intelligence Platform starting")
    logger.info("Project=%s Location=%s Model=%s", PROJECT_ID, LOCATION, MODEL)
    if not PROJECT_ID:
        logger.warning("GOOGLE_CLOUD_PROJECT is not set — Vertex AI will fail.")


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "project_id": PROJECT_ID, "location": LOCATION}


@app.get("/api/config")
async def api_config():
    return {"maps_api_key": os.getenv("MAPS_API_KEY", "")}


async def _ensure_session(user_id: str, session_id: str):
    existing = await SESSION_SERVICE.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if not existing:
        await SESSION_SERVICE.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id)


async def _client_to_agent(ws: WebSocket, queue: LiveRequestQueue):
    while True:
        msg = await ws.receive()
        if msg.get("bytes") is not None:
            queue.send_realtime(types.Blob(mime_type="audio/pcm;rate=16000", data=msg["bytes"]))
            continue
        if msg.get("text") is None:
            continue
        try:
            payload = json.loads(msg["text"])
        except json.JSONDecodeError:
            continue
        if payload.get("type") == "text":
            queue.send_content(types.Content(parts=[types.Part(text=payload["text"])]))


async def _agent_to_client(ws, user_id, session_id, queue):
    async for event in RUNNER.run_live(
        user_id=user_id, session_id=session_id,
        live_request_queue=queue, run_config=RUN_CONFIG,
    ):
        await ws.send_text(event.model_dump_json(exclude_none=True, by_alias=True))


def _is_disconnect(exc: Exception) -> bool:
    if isinstance(exc, RuntimeError):
        return "disconnect message has been received" in str(exc)
    return False


@app.websocket("/ws/{user_id}/{session_id}")
async def live_socket(ws: WebSocket, user_id: str, session_id: str):
    await ws.accept()
    await _ensure_session(user_id, session_id)

    async def _heartbeat():
        try:
            while True:
                await asyncio.sleep(15)
                await ws.send_text('{"type":"ping"}')
        except Exception:
            pass

    hb = asyncio.create_task(_heartbeat())
    queue = LiveRequestQueue()
    try:
        await asyncio.gather(
            _client_to_agent(ws, queue),
            _agent_to_client(ws, user_id, session_id, queue),
        )
    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", session_id)
    except Exception as exc:
        s = str(exc)
        if _is_disconnect(exc):
            logger.info("Client disconnected: %s", session_id)
        elif any(t in s for t in ("1006", "1007", "1011", "abnormal closure", "keepalive")):
            # Upstream Gemini Live socket idle-timeout — normal, frontend reconnects.
            logger.info("Upstream keepalive timeout on %s (will reconnect): %s",
                        session_id, s.split(";")[0][:100])
        else:
            logger.error("Stream error on %s: %s", session_id, exc, exc_info=True)
    finally:
        hb.cancel()
        queue.close()