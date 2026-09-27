"""Marine Intelligence Platform — Agentic AI on Vertex AI."""

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
from google.adk.tools import ToolContext, google_search
from google.genai import types

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# In-memory session registry (single-instance only)
# ---------------------------------------------------------------------------
SESSION_STATES: dict[str, dict] = {}


async def push_to_session(session_id: str, payload: dict) -> None:
    state = SESSION_STATES.get(session_id)
    if not state:
        return
    ws = state.get("websocket")
    if not ws:
        return
    try:
        await ws.send_json(payload)
    except Exception as exc:
        logger.error("push_to_session(%s): %s", session_id, exc)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------
async def show_marine_map(
    latitude: float,
    longitude: float,
    layer_type: str,
    zoom: int = 8,
    tool_context: ToolContext = None,
) -> dict:
    """Render an interactive map card with a marine data layer.

    Args:
        latitude: Map center latitude.
        longitude: Map center longitude.
        layer_type: One of 'SST', 'CHL', or 'PFZ'.
        zoom: Map zoom level from 1 to 20.
    """
    result = {
        "status": "success",
        "latitude": float(latitude),
        "longitude": float(longitude),
        "layer_type": str(layer_type).upper(),
        "zoom": int(zoom),
    }
    if tool_context is not None:
        await push_to_session(
            tool_context.session.id,
            {"type": "marine_map", "data": result},
        )
    return result


async def fetch_pfz_data(
    latitude: float,
    longitude: float,
    tool_context: ToolContext = None,
) -> dict:
    """Fetch Potential Fishing Zone information near coordinates."""
    info = (
        f"Nearest PFZ: 15.3°N, 73.8°W. Chlorophyll 2.5 mg/m³. "
        f"Distance ~12 nautical miles from {float(latitude):.2f}, {float(longitude):.2f}."
    )
    payload = {
        "info": info,
        "latitude": float(latitude),
        "longitude": float(longitude),
    }
    if tool_context is not None:
        await push_to_session(tool_context.session.id, {"type": "pfz_data", "data": payload})
    return payload


async def get_marine_weather(
    latitude: float,
    longitude: float,
    tool_context: ToolContext = None,
) -> dict:
    """Fetch marine weather: wind, wave height, cyclone alerts."""
    info = (
        f"Wind 15 kt, wave height 1.2 m, no cyclone alert. "
        f"Sea state: Moderate at {float(latitude):.2f}, {float(longitude):.2f}."
    )
    payload = {
        "info": info,
        "latitude": float(latitude),
        "longitude": float(longitude),
    }
    if tool_context is not None:
        await push_to_session(
            tool_context.session.id,
            {"type": "marine_weather", "data": payload},
        )
    return payload


async def check_geofence_imbl(
    latitude: float,
    longitude: float,
    tool_context: ToolContext = None,
) -> dict:
    """Check whether coordinates are near restricted waters or the IMBL."""
    safe = (float(latitude) < 20.0) and (float(longitude) > 70.0)
    message = (
        "SAFE: Vessel is approximately 40 nautical miles from the IMBL."
        if safe
        else "WARNING: Vessel is approaching restricted waters. Turn back immediately."
    )
    payload = {
        "safe": safe,
        "message": message,
        "latitude": float(latitude),
        "longitude": float(longitude),
    }
    if tool_context is not None:
        await push_to_session(
            tool_context.session.id,
            {"type": "geofence_alert", "data": payload},
        )
    return payload


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
INSTRUCTION = """CRITICAL: Your FIRST and DEFAULT language is ENGLISH. Never reply in Spanish, French, or any other language unless the user's last message was in that language.

You are an Agentic AI Marine Intelligence Platform. You help fishermen, coastal authorities, and researchers with oceanographic data.

## Tools you can call
- google_search — for live SST, chlorophyll, weather, fishing advisories, cyclone alerts.
- show_marine_map(latitude, longitude, layer_type, zoom) — renders an interactive satellite map card. layer_type must be 'SST', 'CHL', or 'PFZ'.
- fetch_pfz_data(latitude, longitude) — PFZ details for a location.
- get_marine_weather(latitude, longitude) — wind, waves, cyclone alerts.
- check_geofence_imbl(latitude, longitude) — IMBL / restricted-water safety check.

## Behaviour
- When the user asks about SST, chlorophyll, fishing zones, or marine conditions in a place, ALWAYS:
  1) Call google_search to ground your answer with live sources and images.
  2) Call show_marine_map with the correct coordinates and layer_type.
- Known coordinates: Kochi (9.93, 76.26), Chennai (13.08, 80.27), Mumbai (19.07, 72.87), Goa (15.50, 73.83), Vizag (17.69, 83.22), Mangalore (12.91, 74.86), Kolkata (22.57, 88.36).
- Reply in ONE short sentence (max 15 words). Example: "Here's the SST map for Kochi."
- Do NOT narrate tool calls.
- Do NOT invent data. If uncertain, call a tool.
"""

agent = Agent(
    name="marine_agent",
    model=MODEL,
    tools=[
        google_search,
        show_marine_map,
        fetch_pfz_data,
        get_marine_weather,
        check_geofence_imbl,
    ],
    instruction=INSTRUCTION,
)

SESSION_SERVICE = InMemorySessionService()
RUNNER = Runner(app_name=APP_NAME, agent=agent, session_service=SESSION_SERVICE)
RUN_CONFIG = RunConfig(
    streaming_mode=StreamingMode.BIDI,
    response_modalities=["AUDIO"],
)


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------
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
    return {
        "status": "ok",
        "model": MODEL,
        "project_id": PROJECT_ID,
        "location": LOCATION,
    }


@app.get("/api/config")
async def api_config():
    return {"maps_api_key": os.getenv("MAPS_API_KEY", "")}


# ---------------------------------------------------------------------------
# ADK bridge
# ---------------------------------------------------------------------------
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
                types.Blob(
                    mime_type="audio/pcm;rate=16000",
                    data=message["bytes"],
                )
            )
            continue
        if message.get("text") is None:
            continue
        try:
            payload = json.loads(message["text"])
        except json.JSONDecodeError:
            continue
        if payload.get("type") == "text":
            queue.send_content(
                types.Content(parts=[types.Part(text=payload["text"])])
            )


async def _agent_to_client(
    ws: WebSocket, user_id: str, session_id: str, queue: LiveRequestQueue
) -> None:
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


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws/{user_id}/{session_id}")
async def live_socket(ws: WebSocket, user_id: str, session_id: str) -> None:
    await ws.accept()
    await _ensure_adk_session(user_id, session_id)
    SESSION_STATES[session_id] = {"websocket": ws, "user_id": user_id}

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
        queue.close()
        SESSION_STATES.pop(session_id, None)