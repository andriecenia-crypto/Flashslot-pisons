"""Business-owner (admin) endpoints: business profile, services, staff, appointments,
flash slots, waitlist and alert log. Everything is scoped to the admin's own business."""
from flask import Blueprint, g, jsonify, request
from postgrest.exceptions import APIError

from backend.config import api_error, get_supabase, iso, now_utc, parse_dt, require_admin
from backend.routes.booking_routes import DEFAULT_DURATION, has_conflict, load_service_and_staff
from backend.services.notification_service import expire_stale, trigger_quick_fill

bp = Blueprint("admin", __name__, url_prefix="/api/admin")

CATEGORIES = {"barbershop", "dental", "grooming", "other"}
STATUSES = {"booked", "completed", "cancelled"}


def my_business():
    rows = (
        get_supabase().table("businesses").select("*").eq("owner_id", g.user["id"])
        .order("created_at").limit(1).execute().data
    )
    return rows[0] if rows else None


def _need_business():
    business = my_business()
    if not business:
        return None, api_error("Set up your business first.", 404)
    return business, None


def _text(data, key, default=""):
    return str(data.get(key, default) if data.get(key) is not None else default).strip()


def _number(data, key, minimum=0):
    try:
        value = float(data.get(key))
    except (TypeError, ValueError):
        return None
    return value if value >= minimum else None


# ---------------------------------------------------------------------------
# Business profile + overview
# ---------------------------------------------------------------------------
@bp.get("/business")
@require_admin
def get_business():
    business, error = _need_business()
    return error or jsonify({"business": business})


@bp.post("/business")
@require_admin
def create_business():
    """Create the owner's business listing (only if they do not have one yet)."""
    if my_business():
        return api_error("You already have a business listing.", 409)
    data = request.get_json(silent=True) or {}
    if not _text(data, "name"):
        return api_error("Enter your business name.")
    category = data.get("category") if data.get("category") in CATEGORIES else "other"
    row = (
        get_supabase().table("businesses")
        .insert({
            "owner_id": g.user["id"], "name": _text(data, "name"), "category": category,
            "description": _text(data, "description"), "address": _text(data, "address"),
            "image_url": _text(data, "image_url"),
        })
        .execute().data[0]
    )
    return jsonify({"business": row}), 201


@bp.put("/business")
@require_admin
def update_business():
    business, error = _need_business()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    changes = {}
    for key in ("name", "description", "address", "image_url"):
        if key in data:
            changes[key] = _text(data, key)
    if "category" in data:
        changes["category"] = data["category"] if data["category"] in CATEGORIES else "other"
    if "name" in changes and not changes["name"]:
        return api_error("The business name cannot be empty.")
    if not changes:
        return api_error("Nothing to update.")
    updated = get_supabase().table("businesses").update(changes).eq("id", business["id"]).execute().data[0]
    return jsonify({"business": updated})


@bp.get("/overview")
@require_admin
def overview():
    business, error = _need_business()
    if error:
        return error
    expire_stale()
    sb = get_supabase()
    bid = business["id"]
    appts = sb.table("appointments").select("status, slot_time, services(price)").eq("business_id", bid).execute().data
    flashes = sb.table("flash_slots").select("status, flash_price").eq("business_id", bid).execute().data
    now = now_utc()
    upcoming = sum(1 for a in appts if a["status"] == "booked" and parse_dt(a["slot_time"]) > now)
    cancelled = sum(1 for a in appts if a["status"] == "cancelled")
    claimed = [f for f in flashes if f["status"] == "claimed"]
    waitlist = sb.table("waitlist").select("id").eq("business_id", bid).eq("status", "active").execute().data
    return jsonify({
        "upcoming": upcoming,
        "cancelled": cancelled,
        "active_flash_slots": sum(1 for f in flashes if f["status"] == "active"),
        "claimed_flash_slots": len(claimed),
        "recovered_revenue": round(sum(float(f["flash_price"]) for f in claimed), 2),
        "waitlist_active": len(waitlist),
    })


# ---------------------------------------------------------------------------
# Services CRUD
# ---------------------------------------------------------------------------
def _service_payload(data, partial=False):
    payload = {}
    if not partial or "name" in data:
        payload["name"] = _text(data, "name")
        if not payload["name"]:
            return None, "Enter a service name."
    if "description" in data:
        payload["description"] = _text(data, "description")
    if not partial or "duration_minutes" in data:
        duration = _number(data, "duration_minutes", 5)
        if duration is None:
            return None, "Duration must be at least 5 minutes."
        payload["duration_minutes"] = int(duration)
    if not partial or "price" in data:
        price = _number(data, "price", 0)
        if price is None:
            return None, "Enter a price of 0 or more."
        payload["price"] = round(price, 2)
    return payload, None


@bp.get("/services")
@require_admin
def list_services():
    business, error = _need_business()
    if error:
        return error
    rows = get_supabase().table("services").select("*").eq("business_id", business["id"]).order("created_at").execute().data
    return jsonify({"services": rows})


@bp.post("/services")
@require_admin
def create_service():
    business, error = _need_business()
    if error:
        return error
    payload, problem = _service_payload(request.get_json(silent=True) or {})
    if problem:
        return api_error(problem)
    payload["business_id"] = business["id"]
    row = get_supabase().table("services").insert(payload).execute().data[0]
    return jsonify({"service": row}), 201


@bp.put("/services/<service_id>")
@require_admin
def update_service(service_id):
    business, error = _need_business()
    if error:
        return error
    payload, problem = _service_payload(request.get_json(silent=True) or {}, partial=True)
    if problem:
        return api_error(problem)
    rows = get_supabase().table("services").update(payload).eq("id", service_id).eq("business_id", business["id"]).execute().data
    return (jsonify({"service": rows[0]}) if rows else api_error("Service not found.", 404))


@bp.delete("/services/<service_id>")
@require_admin
def delete_service(service_id):
    business, error = _need_business()
    if error:
        return error
    rows = get_supabase().table("services").delete().eq("id", service_id).eq("business_id", business["id"]).execute().data
    return (jsonify({"deleted": True}) if rows else api_error("Service not found.", 404))


# ---------------------------------------------------------------------------
# Staff CRUD
# ---------------------------------------------------------------------------
@bp.get("/staff")
@require_admin
def list_staff():
    business, error = _need_business()
    if error:
        return error
    rows = get_supabase().table("staff").select("*").eq("business_id", business["id"]).order("created_at").execute().data
    return jsonify({"staff": rows})


@bp.post("/staff")
@require_admin
def create_staff():
    business, error = _need_business()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    if not _text(data, "name"):
        return api_error("Enter the staff member's name.")
    row = (
        get_supabase().table("staff")
        .insert({
            "business_id": business["id"], "name": _text(data, "name"),
            "role": _text(data, "role"), "avatar_url": _text(data, "avatar_url"),
        })
        .execute().data[0]
    )
    return jsonify({"staff": row}), 201


@bp.put("/staff/<staff_id>")
@require_admin
def update_staff(staff_id):
    business, error = _need_business()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    changes = {k: _text(data, k) for k in ("name", "role", "avatar_url") if k in data}
    if "name" in changes and not changes["name"]:
        return api_error("The name cannot be empty.")
    if not changes:
        return api_error("Nothing to update.")
    rows = get_supabase().table("staff").update(changes).eq("id", staff_id).eq("business_id", business["id"]).execute().data
    return (jsonify({"staff": rows[0]}) if rows else api_error("Staff member not found.", 404))


@bp.delete("/staff/<staff_id>")
@require_admin
def delete_staff(staff_id):
    business, error = _need_business()
    if error:
        return error
    rows = get_supabase().table("staff").delete().eq("id", staff_id).eq("business_id", business["id"]).execute().data
    return (jsonify({"deleted": True}) if rows else api_error("Staff member not found.", 404))


# ---------------------------------------------------------------------------
# Appointments CRUD (+ the Quick-Fill trigger on cancellation)
# ---------------------------------------------------------------------------
APPT_SELECT = "*, customer:users(full_name, email), services(name, price, duration_minutes), staff(name)"


@bp.get("/appointments")
@require_admin
def list_appointments():
    business, error = _need_business()
    if error:
        return error
    query = get_supabase().table("appointments").select(APPT_SELECT).eq("business_id", business["id"])
    status = request.args.get("status")
    if status in STATUSES:
        query = query.eq("status", status)
    return jsonify({"appointments": query.order("slot_time", desc=True).execute().data})


@bp.post("/appointments")
@require_admin
def create_appointment():
    """Create a booking on behalf of an existing customer (e.g. a phone booking)."""
    business, error = _need_business()
    if error:
        return error
    data = request.get_json(silent=True) or {}
    email = _text(data, "customer_email").lower()
    sb = get_supabase()
    customer = sb.table("users").select("id").eq("email", email).limit(1).execute().data
    if not customer:
        return api_error("No customer account uses that email. Ask them to sign up first.", 404)
    try:
        start = parse_dt(data.get("slot_time"))
    except (ValueError, TypeError):
        return api_error("That time is not valid.")
    service, staff = load_service_and_staff(business["id"], data.get("service_id"), data.get("staff_id"))
    if not service or not staff:
        return api_error("Choose a service and a staff member from your business.")
    if has_conflict(staff["id"], start, service["duration_minutes"]):
        return api_error("That staff member is already booked at that time.", 409)
    try:
        row = (
            sb.table("appointments")
            .insert({
                "customer_id": customer[0]["id"], "business_id": business["id"], "service_id": service["id"],
                "staff_id": staff["id"], "slot_time": iso(start), "status": "booked",
            })
            .execute().data[0]
        )
    except APIError:
        return api_error("That staff member is already booked at that time.", 409)
    return jsonify({"appointment": row}), 201


@bp.put("/appointments/<appointment_id>")
@require_admin
def update_appointment(appointment_id):
    """Update status, time, service or staff. Marking a booked appointment as
    'cancelled' automatically creates a Flash Slot and alerts the waitlist."""
    business, error = _need_business()
    if error:
        return error
    sb = get_supabase()
    found = sb.table("appointments").select("*, services(duration_minutes)").eq("id", appointment_id).eq("business_id", business["id"]).limit(1).execute().data
    if not found:
        return api_error("Appointment not found.", 404)
    current = found[0]
    data = request.get_json(silent=True) or {}
    changes = {}

    if "status" in data:
        if data["status"] not in STATUSES:
            return api_error("Status must be booked, completed or cancelled.")
        changes["status"] = data["status"]
    if "slot_time" in data:
        try:
            changes["slot_time"] = iso(parse_dt(data["slot_time"]))
        except (ValueError, TypeError):
            return api_error("That time is not valid.")
    if "service_id" in data or "staff_id" in data:
        service, staff = load_service_and_staff(
            business["id"], data.get("service_id", current["service_id"]), data.get("staff_id", current["staff_id"])
        )
        if not service or not staff:
            return api_error("Choose a service and a staff member from your business.")
        changes["service_id"], changes["staff_id"] = service["id"], staff["id"]
    if not changes:
        return api_error("Nothing to update.")

    final_status = changes.get("status", current["status"])
    if final_status == "booked":
        start = parse_dt(changes.get("slot_time", current["slot_time"]))
        staff_id = changes.get("staff_id", current["staff_id"])
        duration = (current.get("services") or {}).get("duration_minutes") or DEFAULT_DURATION
        if "service_id" in changes:
            duration = service["duration_minutes"]
        if staff_id and has_conflict(staff_id, start, duration, ignore_appointment_id=appointment_id):
            return api_error("That staff member is already booked at that time.", 409)

    try:
        updated = sb.table("appointments").update(changes).eq("id", appointment_id).execute().data[0]
    except APIError:
        return api_error("That staff member is already booked at that time.", 409)

    quick_fill = None
    if changes.get("status") == "cancelled" and current["status"] == "booked":
        quick_fill = trigger_quick_fill(appointment_id, data.get("discount_percentage"))
    elif changes.get("status") == "booked" and current["status"] != "booked":
        # Re-booked by the owner: withdraw any live flash slot for this appointment
        sb.table("flash_slots").update({"status": "expired"}).eq("appointment_id", appointment_id).eq("status", "active").execute()

    return jsonify({"appointment": updated, "quick_fill": quick_fill})


@bp.delete("/appointments/<appointment_id>")
@require_admin
def delete_appointment(appointment_id):
    business, error = _need_business()
    if error:
        return error
    rows = get_supabase().table("appointments").delete().eq("id", appointment_id).eq("business_id", business["id"]).execute().data
    return (jsonify({"deleted": True}) if rows else api_error("Appointment not found.", 404))


# ---------------------------------------------------------------------------
# Flash slots, waitlist and alert log
# ---------------------------------------------------------------------------
@bp.get("/flash-slots")
@require_admin
def list_flash_slots():
    business, error = _need_business()
    if error:
        return error
    expire_stale()
    rows = (
        get_supabase().table("flash_slots")
        .select("*, appointments(slot_time, services(name), staff(name))")
        .eq("business_id", business["id"]).order("created_at", desc=True).limit(100).execute().data
    )
    return jsonify({"flash_slots": rows})


@bp.post("/flash-slots/<slot_id>/withdraw")
@require_admin
def withdraw_flash_slot(slot_id):
    business, error = _need_business()
    if error:
        return error
    rows = (
        get_supabase().table("flash_slots").update({"status": "expired"})
        .eq("id", slot_id).eq("business_id", business["id"]).eq("status", "active").execute().data
    )
    return (jsonify({"flash_slot": rows[0]}) if rows else api_error("No live flash slot with that id.", 404))


@bp.get("/waitlist")
@require_admin
def list_waitlist():
    business, error = _need_business()
    if error:
        return error
    expire_stale()
    rows = (
        get_supabase().table("waitlist")
        .select("*, customer:users(full_name, email), services(name)")
        .eq("business_id", business["id"]).order("preferred_date").execute().data
    )
    return jsonify({"waitlist": rows})


@bp.get("/notifications")
@require_admin
def list_alerts():
    """Alert log: every mock notification sent to waitlisted customers for this business."""
    business, error = _need_business()
    if error:
        return error
    slots = get_supabase().table("flash_slots").select("id").eq("business_id", business["id"]).execute().data
    ids = [s["id"] for s in slots]
    if not ids:
        return jsonify({"notifications": []})
    rows = (
        get_supabase().table("notifications")
        .select("*, customer:users(full_name, email)")
        .in_("flash_slot_id", ids).order("created_at", desc=True).limit(100).execute().data
    )
    return jsonify({"notifications": rows})
