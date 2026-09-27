"""ADK tool functions — the specialists exposed to the marine agent."""

from __future__ import annotations
import asyncio, logging
from google.adk.tools import ToolContext

from .copernicus import get_layer_info
from .data import (INDIA_EEZ_POLYGON, nearest_harbour, point_in_polygon, restricted_zone_at)
from .marine import (fetch_chlorophyll, fetch_marine_state, fetch_ocean_snapshot,
                     fetch_sst, fetch_weather)
from .search import web_search as _ddg

logger = logging.getLogger(__name__)


def _norm_layer(lt: str) -> str:
    s = (lt or "").upper().strip()
    if s in ("SST", "SEA SURFACE TEMPERATURE", "TEMPERATURE", "TEMP"): return "SST"
    if s in ("CHL", "CHL-A", "CHLOROPHYLL", "CHLOROPHYLL-A"): return "CHL"
    if s in ("PFZ", "FISHING", "POTENTIAL FISHING ZONE"): return "PFZ"
    return s or "SST"


def _map_payload(lat, lon, layer_type, zoom=8):
    key = _norm_layer(layer_type)
    info = get_layer_info(key)
    return {"latitude": float(lat), "longitude": float(lon),
            "layer_type": key, "zoom": int(zoom), "wmts": info}


# ─── Ocean Analytics ─────────────────────────────────────────────
async def get_ocean_conditions(latitude: float, longitude: float,
                                tool_context: ToolContext = None) -> dict:
    """Fetch Sea Surface Temperature (SST), Chlorophyll, and wave state at a point in one call.

    Args:
        latitude: Latitude.
        longitude: Longitude.
    """
    snap = await fetch_ocean_snapshot(float(latitude), float(longitude))
    sst, chl = snap["sst"], snap["chlorophyll"]
    parts = []
    parts.append(f"SST is {sst['sst_celsius']}°C." if sst.get("available") else "SST unavailable.")
    parts.append(f"Chlorophyll is {chl['chlorophyll_mg_m3']} mg/m³ — {chl['category']}."
                 if chl.get("available") else "Chlorophyll unavailable.")
    return {"kind": "ocean_conditions", "summary": " ".join(parts),
            "sst": sst, "chlorophyll": chl, "marine": snap["marine"],
            "map": _map_payload(latitude, longitude, "SST", 8)}


async def get_sst(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Fetch Sea Surface Temperature only."""
    sst = await fetch_sst(float(latitude), float(longitude))
    s = f"SST is {sst['sst_celsius']}°C." if sst.get("available") else sst.get("reason", "unavailable")
    return {"kind": "sst", "summary": s, "sst": sst,
            "map": _map_payload(latitude, longitude, "SST", 8)}


async def get_chlorophyll(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Fetch chlorophyll-a concentration only."""
    chl = await fetch_chlorophyll(float(latitude), float(longitude))
    s = (f"Chlorophyll is {chl['chlorophyll_mg_m3']} mg/m³ ({chl['category']})."
         if chl.get("available") else chl.get("reason", "unavailable"))
    return {"kind": "chlorophyll", "summary": s, "chlorophyll": chl,
            "map": _map_payload(latitude, longitude, "CHL", 8)}


# ─── Weather & Risk ──────────────────────────────────────────────
async def get_marine_weather(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Fetch marine weather: wind, gusts, waves, swell, precipitation, visibility."""
    weather, marine = await asyncio.gather(
        fetch_weather(float(latitude), float(longitude)),
        fetch_marine_state(float(latitude), float(longitude)))
    parts = []
    if weather.get("available"):
        parts.append(f"Wind {weather.get('wind_speed_kt')} kt, gusts {weather.get('wind_gusts_kt')} kt.")
        parts.append(f"Air {weather.get('temperature_c')}°C.")
    if marine.get("available"):
        parts.append(f"Waves {marine.get('wave_height_m')} m, swell {marine.get('swell_wave_height_m')} m.")
    if not parts: parts.append("Weather unavailable.")
    return {"kind": "marine_weather", "summary": " ".join(parts),
            "weather": weather, "marine": marine}


async def check_safety(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Assess safety to venture into the sea: waves, wind, geofence, restricted zones."""
    marine, weather = await asyncio.gather(
        fetch_marine_state(float(latitude), float(longitude)),
        fetch_weather(float(latitude), float(longitude)))
    hazards, advisories = [], []
    if marine.get("available"):
        wh = marine.get("wave_height_m") or 0
        swh = marine.get("swell_wave_height_m") or 0
        if wh >= 3.5: hazards.append(f"wave height {wh} m")
        elif wh >= 3.0: advisories.append(f"wave height {wh} m")
        if swh >= 3.0: hazards.append(f"swell {swh} m")
        elif swh >= 2.5: advisories.append(f"swell {swh} m")
    if weather.get("available"):
        w = weather.get("wind_speed_kt") or 0
        g = weather.get("wind_gusts_kt") or 0
        if w >= 25 or g >= 35: hazards.append(f"wind {w} kt (gusts {g} kt)")
        elif w >= 18 or g >= 25: advisories.append(f"wind {w} kt (gusts {g} kt)")
    in_eez = point_in_polygon(float(latitude), float(longitude), INDIA_EEZ_POLYGON)
    zone = restricted_zone_at(float(latitude), float(longitude))
    nearest = nearest_harbour(float(latitude), float(longitude), count=1)
    if not in_eez: hazards.append("outside Indian EEZ")
    if zone: advisories.append(f"inside {zone['name']} — {zone['reason']}")
    if hazards: verdict, level = "NOT safe to venture out", "danger"
    elif advisories: verdict, level = "Venture with caution", "warning"
    else: verdict, level = "Safe to venture out", "safe"
    parts = [verdict + "."]
    if hazards: parts.append("Hazards: " + "; ".join(hazards) + ".")
    if advisories: parts.append("Advisories: " + "; ".join(advisories) + ".")
    return {"kind": "safety", "level": level, "summary": " ".join(parts),
            "hazards": hazards, "advisories": advisories,
            "in_indian_eez": in_eez, "restricted_zone": zone,
            "nearest_harbour": nearest[0] if nearest else None,
            "weather": weather, "marine": marine}


# ─── Fishery Intelligence ────────────────────────────────────────
async def find_pfz(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Find the Potential Fishing Zone (PFZ) nearest to a point.

    Uses chlorophyll + SST heuristics (INCOIS criteria: 0.2–2.5 mg/m³ chl, 25–30°C SST).
    """
    chl, sst, marine = await asyncio.gather(
        fetch_chlorophyll(float(latitude), float(longitude)),
        fetch_sst(float(latitude), float(longitude)),
        fetch_marine_state(float(latitude), float(longitude)))
    chl_val = chl.get("chlorophyll_mg_m3") if chl.get("available") else None
    sst_val = sst.get("sst_celsius") if sst.get("available") else None
    score, reasons = 0, []
    if chl_val is not None:
        if 0.2 <= chl_val <= 2.5: score += 2; reasons.append(f"favourable chlorophyll ({chl_val} mg/m³)")
        elif chl_val > 2.5: score += 1; reasons.append(f"high chlorophyll ({chl_val} mg/m³)")
        else: reasons.append(f"low chlorophyll ({chl_val} mg/m³)")
    if sst_val is not None:
        if 25 <= sst_val <= 30: score += 2; reasons.append(f"favourable SST ({sst_val}°C)")
        elif 22 <= sst_val <= 32: score += 1; reasons.append(f"borderline SST ({sst_val}°C)")
        else: reasons.append(f"unfavourable SST ({sst_val}°C)")
    if not reasons:
        likely, summary = None, "Satellite chlorophyll and SST data unavailable — try further offshore or check the INCOIS PFZ bulletin."
    elif score >= 3:
        likely, summary = True, "PFZ likely ~15 nm offshore: " + ", ".join(reasons) + "."
    else:
        likely, summary = False, "PFZ unlikely here: " + ", ".join(reasons) + "."
    sign = -1 if longitude < 82 else 1
    offset_nm = 15 if likely else 8
    pfz_lat, pfz_lon = float(latitude) + 0.05, float(longitude) + sign * (offset_nm / 60.0)
    return {"kind": "pfz", "likely": likely, "score": score, "summary": summary,
            "reasons": reasons, "chlorophyll": chl, "sst": sst, "marine": marine,
            "map": _map_payload(pfz_lat, pfz_lon, "PFZ", 9)}


# ─── Geospatial & Navigation ─────────────────────────────────────
async def check_geofence(latitude: float, longitude: float, tool_context: ToolContext = None) -> dict:
    """Check EEZ status, restricted zones (MPAs), and nearest harbour for a position."""
    in_eez = point_in_polygon(float(latitude), float(longitude), INDIA_EEZ_POLYGON)
    zone = restricted_zone_at(float(latitude), float(longitude))
    nearest = nearest_harbour(float(latitude), float(longitude), count=3)
    if not in_eez: verdict, level = "OUTSIDE Indian EEZ — may be international waters.", "danger"
    elif zone: verdict, level = f"INSIDE {zone['name']} — {zone['reason']}.", "warning"
    else: verdict, level = f"Inside Indian EEZ. Nearest: {nearest[0]['name']} ({nearest[0]['distance_nm']} nm).", "safe"
    return {"kind": "geofence", "level": level, "summary": verdict,
            "in_indian_eez": in_eez, "restricted_zone": zone, "nearest_harbours": nearest,
            "map": _map_payload(latitude, longitude, "PFZ", 9)}


async def find_safe_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float,
                           tool_context: ToolContext = None) -> dict:
    """Compute a safe route between two points, sampling sea state at 5 waypoints."""
    wp = _sample_line(start_lat, start_lon, end_lat, end_lon, 5)
    results = await asyncio.gather(*[fetch_marine_state(w[0], w[1]) for w in wp])
    rows = []
    for w, m in zip(wp, results):
        wh = m.get("wave_height_m") if m.get("available") else None
        swh = m.get("swell_wave_height_m") if m.get("available") else None
        r = 0
        if wh is not None and wh >= 3.5: r = 3
        elif wh is not None and wh >= 3.0: r = 2
        elif wh is not None and wh >= 2.0: r = 1
        if swh is not None and swh >= 3.0: r = max(r, 3)
        rows.append({"lat": w[0], "lon": w[1], "wave_height_m": wh, "swell_wave_height_m": swh,
                     "risk": ["low", "moderate", "high", "severe"][r]})
    worst = max(rows, key=lambda x: ["low", "moderate", "high", "severe"].index(x["risk"]))
    summary = f"Route is {worst['risk']} — worst at {worst['lat']:.2f}, {worst['lon']:.2f}"
    if worst["wave_height_m"] is not None:
        summary += f" ({worst['wave_height_m']} m waves)."
    return {"kind": "route", "summary": summary, "risk": worst["risk"],
            "waypoints": rows, "start": {"lat": start_lat, "lon": start_lon},
            "end": {"lat": end_lat, "lon": end_lon}}


async def show_marine_map(latitude: float, longitude: float, layer_type: str,
                           zoom: int = 8, tool_context: ToolContext = None) -> dict:
    """Render an interactive satellite map with a Copernicus WMTS marine layer.

    Args:
        latitude: Map center latitude.
        longitude: Map center longitude.
        layer_type: One of 'SST', 'CHL', 'PFZ'.
        zoom: Map zoom (1–20).
    """
    payload = _map_payload(latitude, longitude, layer_type, zoom)
    payload["kind"] = "marine_map"
    payload["summary"] = f"Rendered {payload['layer_type']} map at {latitude:.2f}, {longitude:.2f}."
    return payload


# ─── Research ────────────────────────────────────────────────────
async def web_search(query: str, tool_context: ToolContext = None) -> dict:
    """Search the web for cyclone alerts, IMD bulletins, fishing advisories, bioluminescence, news, or general research.

    AFTER calling this, read `answer_text` and summarise it in your reply in 2–4 sentences,
    then cite the sources by name. Do NOT say "check their website".

    Args:
        query: A short, focused English search query.
    """
    return await _ddg(query)


# ─── Conversation ────────────────────────────────────────────────
async def suggest_followups(suggestions: list[str], tool_context: ToolContext = None) -> dict:
    """Provide 2–3 short follow-up questions shown as chips after your reply.

    Args:
        suggestions: List of short user-facing questions (max 3, each ≤ 45 chars).
    """
    return {"kind": "suggestions", "suggestions": suggestions[:3]}


def _sample_line(la1, lo1, la2, lo2, n):
    return [(la1 + (la2-la1)*i/(n-1), lo1 + (lo2-lo1)*i/(n-1)) for i in range(n)]