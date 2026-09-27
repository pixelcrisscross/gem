"""Marine Intelligence Platform — FastAPI + ADK on Vertex AI."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents import Agent
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import google_search
from google.genai import types

from .tools import (
    check_geofence, check_safety, find_pfz, find_safe_route,
    get_chlorophyll, get_marine_weather, get_ocean_conditions, get_sst,
    show_marine_map, suggest_followups,
)

APP_NAME = "marine-concierge"
STATIC_DIR = Path(__file__).parent / "static"
MODEL = "gemini-live-2.5-flash-native-audio"
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "TRUE"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Marine Intelligence Platform", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


INSTRUCTION = """CRITICAL: Your FIRST and DEFAULT language is ENGLISH. Reply in English unless the user's last message was in another language.

You are the Marine Intelligence Platform — an Agentic AI assistant for fishermen, coastal authorities, and researchers.

# SPECIALIST TOOLS
1. OCEAN ANALYTICS — get_ocean_conditions, get_sst, get_chlorophyll (SST, chlorophyll, water quality).
2. WEATHER & RISK — get_marine_weather, check_safety (wind, waves, swell, safety verdict).
3. FISHERY INTELLIGENCE — find_pfz (+ google_search for INCOIS advisories).
4. GEOSPATIAL & NAVIGATION — check_geofence, find_safe_route, show_marine_map.
5. RESEARCH — google_search for cyclone alerts, IMD bulletins, bioluminescence, news.
6. CONVERSATION — suggest_followups (call exactly ONCE per user turn).

# ROUTING
- SST / chlorophyll / temperature / water quality → get_ocean_conditions.
- Weather / waves / wind → get_marine_weather. If user asks "safe" or "go out" → also call check_safety.
- Fishing / PFZ → find_pfz + google_search (INCOIS bulletin).
- Safe / boundaries / limits → check_safety + check_geofence.
- Route / navigation → find_safe_route.
- Cyclone / lightning / bioluminescence / news → google_search only.

# MAPS — STRICT RULES
- Call show_marine_map AT MOST ONCE per turn. Never call it twice for the same location + layer.
- If get_ocean_conditions / get_chlorophyll / find_pfz already returned a `map` field, DO NOT also call show_marine_map — the map is rendered automatically.
- Valid layer_type values: 'SST', 'CHL', 'PFZ'. Nothing else.

# SUGGESTIONS — STRICT RULES
- Call suggest_followups EXACTLY ONCE, at the END of every turn.
- Exactly 3 suggestions, each ≤ 45 characters.
- Never call suggest_followups more than once per turn.

# KNOWN COORDINATES
Kochi 9.96/76.24 · Chennai 13.10/80.30 · Mumbai 18.92/72.83 · Goa 15.50/73.83 ·
Vizag 17.69/83.22 · Mangalore 12.87/74.84 · Kolkata 22.57/88.36 ·
Tuticorin 8.76/78.13 · Kanyakumari 8.09/77.54 · Rameswaram 9.29/79.31 ·
Paradip 20.26/86.68 · Porbandar 21.64/69.63.

# STYLE
- ONE short sentence per reply (≤ 15 words). Example: "Here's the SST for Kochi."
- Do NOT narrate tool calls or read raw numbers back. The UI displays details.
- Do NOT invent data. If a tool returns unavailable, say so briefly.
"""

agent = Agent(
    name="marine_agent",
    model=MODEL,
    tools=[
        get_ocean_conditions, get_sst, get_chlorophyll,
        get_marine_weather, check_safety,
        find_pfz,
        check_geofence, find_safe_route, show_marine_map,
        google_search,
        suggest_followups,
    ],
    instruction=INSTRUCTION,
)

SESSION_SERVICE = InMemorySessionService()
RUNNER = Runner(app_name=APP_NAME, agent=agent, session_service=SESSION_SERVICE)

# RunConfig: try to cap the LLM loop count; older ADK versions ignore the kwarg.
_run_cfg_kwargs = {
    "streaming_mode": StreamingMode.BIDI,
    "response_modalities": ["AUDIO"],
}
try:
    RUN_CONFIG = RunConfig(**_run_cfg_kwargs, max_llm_calls=8)
except TypeError:
    RUN_CONFIG = RunConfig(**_run_cfg_kwargs)


@app.on_event("startup")
async def _on_startup() -> None:
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


async def _ensure_adk_session(user_id: str, session_id: str) -> None:
    existing = await SESSION_SERVICE.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not existing:
        await SESSION_SERVICE.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )


async def _client_to_agent(ws: WebSocket, queue: LiveRequestQueue) -> None:
    while True:
        message = await ws.receive()
        if message.get("bytes") is not None:
            queue.send_realtime(
                types.Blob(mime_type="audio/pcm;rate=16000", data=message["bytes"])
            )
            continue
        if message.get("text") is None:
            continue
        try:
            payload = json.loads(message["text"])
        except json.JSONDecodeError:
            continue
        if payload.get("type") == "text":
            queue.send_content(types.Content(parts=[types.Part(text=payload["text"])]))


async def _agent_to_client(ws: WebSocket, user_id: str, session_id: str,
                            queue: LiveRequestQueue) -> None:
    async for event in RUNNER.run_live(
        user_id=user_id,
        session_id=session_id,
        live_request_queue=queue,
        run_config=RUN_CONFIG,
    ):
        await ws.send_text(event.model_dump_json(exclude_none=True, by_alias=True))


def _is_disconnect(exc: Exception) -> bool:
    if isinstance(exc, RuntimeError):
        return "disconnect message has been received" in str(exc)
    return False


@app.websocket("/ws/{user_id}/{session_id}")
async def live_socket(ws: WebSocket, user_id: str, session_id: str) -> None:
    await ws.accept()
    await _ensure_adk_session(user_id, session_id)

    async def _heartbeat():
        try:
            while True:
                await asyncio.sleep(20)
                await ws.send_text('{"type":"ping"}')
        except Exception:
            pass

    hb_task = asyncio.create_task(_heartbeat())
    queue = LiveRequestQueue()
    try:
        await asyncio.gather(
            _client_to_agent(ws, queue),
            _agent_to_client(ws, user_id, session_id, queue),
        )
    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", session_id)
    except Exception as exc:
        if _is_disconnect(exc):
            logger.info("Client disconnected: %s", session_id)
        else:
            logger.error("Stream error on %s: %s", session_id, exc, exc_info=True)
    finally:
        hb_task.cancel()
        queue.close()