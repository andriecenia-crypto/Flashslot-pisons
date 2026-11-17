"""Customer-facing booking endpoints: availability, appointments and flash slots."""
from datetime import timedelta

from flask import Blueprint, g, jsonify, request
from postgrest.exceptions import APIError

from backend.config import api_error, get_supabase, iso, now_utc, parse_dt, require_auth
from backend.services.notification_service import expire_stale, trigger_quick_fill

bp = Blueprint("bookings", __name__, url_prefix="/api")

DEFAULT_DURATION = 30


def has_conflict(staff_id, start, duration_minutes, ignore_appointment_id=None):
    """True if the staff member already has a booked appointment overlapping [start, start+duration)."""
    end = start + timedelta(minutes=duration_minutes)
    rows = (
        get_supabase().table("appointments")
        .select("id, slot_time, services(duration_minutes)")
        .eq("staff_id", staff_id)
        .eq("status", "booked")
        .gte("slot_time", iso(start - timedelta(days=1)))
        .lt("slot_time", iso(start + timedelta(days=1)))
        .execute()
        .data
    )
    for row in rows:
        if ignore_appointment_id and row["id"] == ignore_appointment_id:
            continue
        other_start = parse_dt(row["slot_time"])
        other_len = (row.get("services") or {}).get("duration_minutes") or DEFAULT_DURATION
        if other_start < end and other_start + timedelta(minutes=other_len) > start:
            return True
    return False


def load_service_and_staff(business_id, service_id, staff_id):
    """Fetch and validate that the service and staff member belong to the business."""
    sb = get_supabase()
    svc = sb.table("services").select("*").eq("id", service_id).eq("business_id", business_id).limit(1).execute().data
    stf = sb.table("staff").select("*").eq("id", staff_id).eq("business_id", business_id).limit(1).execute().data
    return (svc[0] if svc else None), (stf[0] if stf else None)


def _flatten_flash(row):
    appt = row.get("appointments") or {}
    service = appt.get("services") or {}
    staff = appt.get("staff") or {}
    business = row.get("businesses") or {}
    price = float(service.get("price") or 0)
    return {
        "id": row["id"],
        "business_id": row["business_id"],
        "service_id": appt.get("service_id"),
        "discount_percentage": row["discount_percentage"],
        "flash_price": float(row["flash_price"]),
        "original_price": price,
        "expires_at": row["expires_at"],
        "slot_time": appt.get("slot_time"),
        "business": {k: business.get(k) for k in ("id", "name", "category", "image_url", "address")},
        "service": {"name": service.get("name"), "duration_minutes": service.get("duration_minutes")},
        "staff": {"name": staff.get("name"), "avatar_url": staff.get("avatar_url")},
    }


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------
@bp.get("/availability")
def availability():
    """Busy intervals for one staff member around a date. The browser builds the
    time grid in the visitor's own time zone and greys out anything that overlaps."""
    staff_id = request.args.get("staff_id", "")
    date = request.args.get("date", "")
    if not staff_id or not date:
        return api_error("staff_id and date are required.")
    try:
        day = parse_dt(date + "T00:00:00+00:00")
    except ValueError:
        return api_error("Use the date format YYYY-MM-DD.")
    rows = (
        get_supabase().table("appointments")
        .select("slot_time, services(duration_minutes)")
        .eq("staff_id", staff_id)
        .eq("status", "booked")
        .gte("slot_time", iso(day - timedelta(days=1)))
        .lt("slot_time", iso(day + timedelta(days=2)))
        .execute()
        .data
    )
    busy = []
    for row in rows:
        start = parse_dt(row["slot_time"])
        length = (row.get("services") or {}).get("duration_minutes") or DEFAULT_DURATION
        busy.append({"start": iso(start), "end": iso(start + timedelta(minutes=length))})
    return jsonify({"busy": busy})


@bp.get("/flash-slots")
def list_flash_slots():
    """All live flash slots, soonest-expiring first (powers the homepage)."""
    expire_stale()
    rows = (
        get_supabase().table("flash_slots")
        .select("*, businesses(id, name, category, image_url, address), "
                "appointments(slot_time, service_id, services(name, duration_minutes, price), staff(name, avatar_url))")
        .eq("status", "active")
        .gt("expires_at", iso(now_utc()))
        .order("expires_at")
        .execute()
        .data
    )
    return jsonify({"flash_slots": [_flatten_flash(r) for r in rows]})


# ---------------------------------------------------------------------------
# Customer (signed in)
# ---------------------------------------------------------------------------
@bp.post("/appointments")
@require_auth
def create_appointment():
    data = request.get_json(silent=True) or {}
    business_id, service_id, staff_id = data.get("business_id"), data.get("service_id"), data.get("staff_id")
    if not (business_id and service_id and staff_id and data.get("slot_time")):
        return api_error("Choose a service, a staff member and a time.")
    try:
        start = parse_dt(data["slot_time"])
    except ValueError:
        return api_error("That time is not valid.")
    if start <= now_utc():
        return api_error("Pick a time in the future.")

    service, staff = load_service_and_staff(business_id, service_id, staff_id)
    if not service or not staff:
        return api_error("That service or staff member is not available at this business.", 404)
    if has_conflict(staff_id, start, service["duration_minutes"]):
        return api_error("That time was just taken. Pick another slot.", 409)

    try:
        appt = (
            get_supabase().table("appointments")
            .insert({
                "customer_id": g.user["id"], "business_id": business_id, "service_id": service_id,
                "staff_id": staff_id, "slot_time": iso(start), "status": "booked",
            })
            .execute()
            .data[0]
        )
    except APIError:
        return api_error("That time was just taken. Pick another slot.", 409)
    return jsonify({"appointment": appt}), 201


@bp.get("/appointments/mine")
@require_auth
def my_appointments():
    expire_stale()
    rows = (
        get_supabase().table("appointments")
        .select("*, businesses(id, name, address, image_url), services(name, price, duration_minutes), staff(name, avatar_url)")
        .eq("customer_id", g.user["id"])
        .order("slot_time", desc=True)
        .execute()
        .data
    )
    return jsonify({"appointments": rows})


@bp.post("/appointments/<appointment_id>/cancel")
@require_auth
def cancel_my_appointment(appointment_id):
    sb = get_supabase()
    rows = sb.table("appointments").select("*").eq("id", appointment_id).eq("customer_id", g.user["id"]).limit(1).execute().data
    if not rows:
        return api_error("Appointment not found.", 404)
    if rows[0]["status"] != "booked":
        return api_error("Only booked appointments can be cancelled.", 409)
    sb.table("appointments").update({"status": "cancelled"}).eq("id", appointment_id).execute()
    result = trigger_quick_fill(appointment_id)
    return jsonify({"status": "cancelled", "flash_slot": result["flash_slot"], "notified": result["notified"]})


@bp.post("/flash-slots/<slot_id>/claim")
@require_auth
def claim_flash_slot(slot_id):
    """Book a flash slot at its discounted price."""
    expire_stale()
    sb = get_supabase()
    rows = sb.table("flash_slots").select("*, appointments(*, services(duration_minutes))").eq("id", slot_id).limit(1).execute().data
    if not rows:
        return api_error("Flash slot not found.", 404)
    flash = rows[0]
    src = flash["appointments"]
    start = parse_dt(src["slot_time"])
    if flash["status"] != "active" or parse_dt(flash["expires_at"]) <= now_utc() or start <= now_utc():
        return api_error("Sorry, this flash slot is no longer available.", 409)
    if not src.get("service_id") or not src.get("staff_id"):
        return api_error("This slot can no longer be booked.", 409)
    duration = (src.get("services") or {}).get("duration_minutes") or DEFAULT_DURATION
    if has_conflict(src["staff_id"], start, duration):
        return api_error("This time has just been booked by someone else.", 409)

    # Atomic claim: only one request can flip active -> claimed
    claimed = sb.table("flash_slots").update({"status": "claimed"}).eq("id", slot_id).eq("status", "active").execute().data
    if not claimed:
        return api_error("Someone else just claimed this slot.", 409)
    try:
        appt = (
            sb.table("appointments")
            .insert({
                "customer_id": g.user["id"], "business_id": src["business_id"], "service_id": src["service_id"],
                "staff_id": src["staff_id"], "slot_time": iso(start), "status": "booked",
            })
            .execute()
            .data[0]
        )
    except APIError:
        sb.table("flash_slots").update({"status": "active"}).eq("id", slot_id).execute()
        return api_error("This time has just been booked by someone else.", 409)
    return jsonify({"appointment": appt, "paid_price": float(flash["flash_price"])}), 201
