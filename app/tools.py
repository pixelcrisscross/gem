"""ADK tool functions exposed to the marine agent."""

from __future__ import annotations

import asyncio
import logging

from google.adk.tools import ToolContext, google_search  # noqa: F401

from .copernicus import get_layer_info
from .data import (
    INDIA_EEZ_POLYGON, nearest_harbour, point_in_polygon, restricted_zone_at,
)
from .marine import (
    fetch_chlorophyll, fetch_marine_state, fetch_ocean_snapshot, fetch_sst, fetch_weather,
)

logger = logging.getLogger(__name__)


def _normalize_layer_type(lt: str) -> str:
    """Accept SST / CHL / PFZ as well as their long names."""
    s = (lt or "").upper().strip()
    if s in ("SST", "SEA SURFACE TEMPERATURE", "TEMPERATURE", "TEMP"):
        return "SST"
    if s in ("CHL", "CHL-A", "CHLOROPHYLL", "CHLOROPHYLL A", "CHLOROPHYLL-A"):
        return "CHL"
    if s in ("PFZ", "FISHING", "POTENTIAL FISHING ZONE"):
        return "PFZ"
    return s or "SST"


def _map_payload(lat: float, lon: float, layer_type: str, zoom: int = 8) -> dict:
    key = _normalize_layer_type(layer_type)
    info = get_layer_info(key)
    return {
        "latitude": float(lat),
        "longitude": float(lon),
        "layer_type": key,
        "zoom": int(zoom),
        "wmts": info,
    }


async def get_ocean_conditions(latitude: float, longitude: float,
                                tool_context: ToolContext = None) -> dict:
    """Fetch Sea Surface Temperature (SST) and Chlorophyll concentration at a point."""
    snap = await fetch_ocean_snapshot(float(latitude), float(longitude))
    sst, chl = snap["sst"], snap["chlorophyll"]
    parts = []
    parts.append(f"SST is {sst['sst_celsius']}°C." if sst.get("available")
                 else "SST unavailable for this point.")
    parts.append(f"Chlorophyll is {chl['chlorophyll_mg_m3']} mg/m³ — {chl['category']}."
                 if chl.get("available") else "Chlorophyll unavailable for this point.")
    return {
        "kind": "ocean_conditions",
        "summary": " ".join(parts),
        "sst": sst, "chlorophyll": chl, "marine": snap["marine"],
        "map": _map_payload(latitude, longitude, "SST", 8),
    }


async def get_sst(latitude: float, longitude: float,
                  tool_context: ToolContext = None) -> dict:
    """Fetch the Sea Surface Temperature (SST) at a point."""
    sst = await fetch_sst(float(latitude), float(longitude))
    s = f"SST is {sst['sst_celsius']}°C." if sst.get("available") else sst.get("reason", "SST unavailable.")
    return {"kind": "sst", "summary": s, "sst": sst,
            "map": _map_payload(latitude, longitude, "SST", 8)}


async def get_chlorophyll(latitude: float, longitude: float,
                           tool_context: ToolContext = None) -> dict:
    """Fetch the Chlorophyll concentration at a point."""
    chl = await fetch_chlorophyll(float(latitude), float(longitude))
    s = (f"Chlorophyll is {chl['chlorophyll_mg_m3']} mg/m³ ({chl['category']})."
         if chl.get("available") else chl.get("reason", "Chlorophyll unavailable."))
    return {"kind": "chlorophyll", "summary": s, "chlorophyll": chl,
            "map": _map_payload(latitude, longitude, "CHL", 8)}


async def get_marine_weather(latitude: float, longitude: float,
                              tool_context: ToolContext = None) -> dict:
    """Fetch marine weather: wind speed/gusts, waves, swell, precipitation."""
    weather, marine = await asyncio.gather(
        fetch_weather(float(latitude), float(longitude)),
        fetch_marine_state(float(latitude), float(longitude)),
    )
    parts = []
    if weather.get("available"):
        parts.append(f"Wind {weather.get('wind_speed_kt')} kt (gusts {weather.get('wind_gusts_kt')} kt).")
        parts.append(f"Air temp {weather.get('temperature_c')}°C.")
    if marine.get("available"):
        parts.append(f"Wave height {marine.get('wave_height_m')} m with swell {marine.get('swell_wave_height_m')} m.")
    if not parts:
        parts.append("Weather data unavailable for this point.")
    return {"kind": "marine_weather", "summary": " ".join(parts),
            "weather": weather, "marine": marine}


async def check_safety(latitude: float, longitude: float,
                        tool_context: ToolContext = None) -> dict:
    """Assess safety to venture into the sea: waves, wind, geofence, restricted zones."""
    marine, weather = await asyncio.gather(
        fetch_marine_state(float(latitude), float(longitude)),
        fetch_weather(float(latitude), float(longitude)),
    )
    hazards, advisories = [], []
    if marine.get("available"):
        wh = marine.get("wave_height_m") or 0
        if wh >= 3.5: hazards.append(f"wave height {wh} m")
        elif wh >= 3.0: advisories.append(f"wave height {wh} m")
        swh = marine.get("swell_wave_height_m") or 0
        if swh >= 3.0: hazards.append(f"swell {swh} m")
        elif swh >= 2.5: advisories.append(f"swell {swh} m")
    if weather.get("available"):
        wind = weather.get("wind_speed_kt") or 0
        gusts = weather.get("wind_gusts_kt") or 0
        if wind >= 25 or gusts >= 35: hazards.append(f"wind {wind} kt (gusts {gusts} kt)")
        elif wind >= 18 or gusts >= 25: advisories.append(f"wind {wind} kt (gusts {gusts} kt)")
    in_eez = point_in_polygon(float(latitude), float(longitude), INDIA_EEZ_POLYGON)
    zone = restricted_zone_at(float(latitude), float(longitude))
    nearest = nearest_harbour(float(latitude), float(longitude), count=1)
    nearest_nm = nearest[0]["distance_nm"] if nearest else None
    if not in_eez: hazards.append("position is outside India's EEZ")
    if zone: advisories.append(f"inside {zone['name']} — {zone['reason']}")
    if nearest_nm is not None and nearest_nm > 200:
        advisories.append(f"{nearest_nm} nm from nearest harbour")
    if hazards:
        verdict, level = "NOT safe to venture out", "danger"
    elif advisories:
        verdict, level = "Venture with caution", "warning"
    else:
        verdict, level = "Safe to venture out", "safe"
    parts = [verdict + "."]
    if hazards: parts.append("Hazards: " + "; ".join(hazards) + ".")
    if advisories: parts.append("Advisories: " + "; ".join(advisories) + ".")
    return {"kind": "safety", "level": level, "summary": " ".join(parts),
            "hazards": hazards, "advisories": advisories,
            "in_indian_eez": in_eez, "restricted_zone": zone,
            "nearest_harbour": nearest[0] if nearest else None,
            "weather": weather, "marine": marine}


async def find_pfz(latitude: float, longitude: float,
                    tool_context: ToolContext = None) -> dict:
    """Find the Potential Fishing Zone (PFZ) nearest to a point."""
    chl, sst, marine = await asyncio.gather(
        fetch_chlorophyll(float(latitude), float(longitude)),
        fetch_sst(float(latitude), float(longitude)),
        fetch_marine_state(float(latitude), float(longitude)),
    )
    chl_val = chl.get("chlorophyll_mg_m3") if chl.get("available") else None
    sst_val = sst.get("sst_celsius") if sst.get("available") else None

    score, reasons = 0, []
    if chl_val is not None:
        if 0.2 <= chl_val <= 2.5:
            score += 2; reasons.append(f"favourable chlorophyll ({chl_val} mg/m³)")
        elif chl_val > 2.5:
            score += 1; reasons.append(f"high chlorophyll ({chl_val} mg/m³)")
        else:
            reasons.append(f"low chlorophyll ({chl_val} mg/m³)")
    if sst_val is not None:
        if 25 <= sst_val <= 30:
            score += 2; reasons.append(f"favourable SST ({sst_val}°C)")
        elif 22 <= sst_val <= 32:
            score += 1; reasons.append(f"borderline SST ({sst_val}°C)")
        else:
            reasons.append(f"unfavourable SST ({sst_val}°C)")

    if not reasons:
        likely = None
        summary = ("Satellite chlorophyll and SST data are unavailable for this "
                   "location right now. Try a point further offshore or check the "
                   "latest INCOIS PFZ bulletin via web search.")
    elif score >= 3:
        likely = True
        summary = ("PFZ likely ~15 nm offshore: " + ", ".join(reasons)
                   + ". Verify against the latest INCOIS bulletin.")
    else:
        likely = False
        summary = ("PFZ unlikely at this exact point: " + ", ".join(reasons)
                   + ". Try deeper water or the nearest shelf break.")

    sign = -1 if longitude < 82 else 1
    offset_nm = 15 if likely else 8
    pfz_lat = float(latitude) + 0.05
    pfz_lon = float(longitude) + sign * (offset_nm / 60.0)

    return {
        "kind": "pfz", "likely": likely, "score": score, "summary": summary,
        "reasons": reasons, "chlorophyll": chl, "sst": sst, "marine": marine,
        "map": _map_payload(pfz_lat, pfz_lon, "PFZ", 9),
    }


async def check_geofence(latitude: float, longitude: float,
                          tool_context: ToolContext = None) -> dict:
    """Check whether a position is safe under geofencing."""
    in_eez = point_in_polygon(float(latitude), float(longitude), INDIA_EEZ_POLYGON)
    zone = restricted_zone_at(float(latitude), float(longitude))
    nearest = nearest_harbour(float(latitude), float(longitude), count=3)
    if not in_eez:
        verdict, level = "OUTSIDE Indian EEZ — may be international waters.", "danger"
    elif zone:
        verdict, level = f"INSIDE {zone['name']} — {zone['reason']}.", "warning"
    else:
        verdict, level = (f"Inside Indian EEZ. Nearest: {nearest[0]['name']} "
                          f"({nearest[0]['distance_nm']} nm)."), "safe"
    return {"kind": "geofence", "level": level, "summary": verdict,
            "in_indian_eez": in_eez, "restricted_zone": zone,
            "nearest_harbours": nearest,
            "map": _map_payload(latitude, longitude, "PFZ", 9)}


async def find_safe_route(start_lat: float, start_lon: float,
                           end_lat: float, end_lon: float,
                           tool_context: ToolContext = None) -> dict:
    """Compute a coarse safe route between two points."""
    waypoints = _sample_line(start_lat, start_lon, end_lat, end_lon, 5)
    results = await asyncio.gather(*[fetch_marine_state(wp[0], wp[1]) for wp in waypoints])
    risk_rows = []
    for wp, m in zip(waypoints, results):
        wh = m.get("wave_height_m") if m.get("available") else None
        swh = m.get("swell_wave_height_m") if m.get("available") else None
        r = 0
        if wh is not None and wh >= 3.5: r = 3
        elif wh is not None and wh >= 3.0: r = 2
        elif wh is not None and wh >= 2.0: r = 1
        if swh is not None and swh >= 3.0: r = max(r, 3)
        risk_rows.append({"lat": wp[0], "lon": wp[1],
                          "wave_height_m": wh, "swell_wave_height_m": swh,
                          "risk": ["low", "moderate", "high", "severe"][r]})
    worst = max(risk_rows, key=lambda x: ["low", "moderate", "high", "severe"].index(x["risk"]))
    summary = (f"Route is {worst['risk']} — worst point at {worst['lat']:.2f}, "
               f"{worst['lon']:.2f}"
               + (f" with {worst['wave_height_m']} m waves."
                  if worst['wave_height_m'] is not None else "."))
    return {"kind": "route", "summary": summary, "risk": worst["risk"],
            "waypoints": risk_rows,
            "start": {"lat": start_lat, "lon": start_lon},
            "end": {"lat": end_lat, "lon": end_lon}}


async def show_marine_map(latitude: float, longitude: float, layer_type: str,
                           zoom: int = 8, tool_context: ToolContext = None) -> dict:
    """Render an interactive satellite map with a Copernicus WMTS marine layer.

    Args:
        latitude: Map center latitude.
        longitude: Map center longitude.
        layer_type: One of 'SST', 'CHL', 'PFZ'.
        zoom: Map zoom level (1-20).
    """
    payload = _map_payload(latitude, longitude, layer_type, zoom)
    payload["kind"] = "marine_map"
    payload["summary"] = f"Rendered {payload['layer_type']} map at {latitude:.2f}, {longitude:.2f}."
    return payload


async def suggest_followups(suggestions: list[str],
                             tool_context: ToolContext = None) -> dict:
    """Provide 2-3 short follow-up questions that appear as chips.

    Args:
        suggestions: List of short user-facing questions (max 3, each ≤ 45 chars).
    """
    return {"kind": "suggestions", "suggestions": suggestions[:3]}


def _sample_line(lat1, lon1, lat2, lon2, n):
    return [(lat1 + (lat2 - lat1) * i / (n - 1),
             lon1 + (lon2 - lon1) * i / (n - 1)) for i in range(n)]