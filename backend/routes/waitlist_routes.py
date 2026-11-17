"""Waitlist and notification endpoints for customers."""
from flask import Blueprint, g, jsonify, request

from backend.config import api_error, get_supabase, now_utc, parse_dt, require_auth
from backend.services.notification_service import expire_stale

bp = Blueprint("waitlist", __name__, url_prefix="/api")


@bp.post("/waitlist")
@require_auth
def join_waitlist():
    data = request.get_json(silent=True) or {}
    business_id = data.get("business_id")
    service_id = data.get("service_id") or None
    preferred = str(data.get("preferred_date", ""))
    if not business_id or not preferred:
        return api_error("Choose a business and a preferred date.")
    try:
        preferred_date = parse_dt(preferred + "T00:00:00+00:00").date()
    except ValueError:
        return api_error("Use the date format YYYY-MM-DD.")
    if preferred_date < now_utc().date():
        return api_error("Pick today or a future date.")

    sb = get_supabase()
    if not sb.table("businesses").select("id").eq("id", business_id).limit(1).execute().data:
        return api_error("Business not found.", 404)
    if service_id and not sb.table("services").select("id").eq("id", service_id).eq("business_id", business_id).limit(1).execute().data:
        return api_error("That service does not belong to this business.", 404)

    query = (
        sb.table("waitlist").select("id").eq("customer_id", g.user["id"]).eq("business_id", business_id)
        .eq("preferred_date", preferred_date.isoformat()).eq("status", "active")
    )
    query = query.eq("service_id", service_id) if service_id else query.is_("service_id", "null")
    if query.limit(1).execute().data:
        return api_error("You are already on this waitlist.", 409)

    entry = (
        sb.table("waitlist")
        .insert({
            "customer_id": g.user["id"], "business_id": business_id, "service_id": service_id,
            "preferred_date": preferred_date.isoformat(), "status": "active",
        })
        .execute()
        .data[0]
    )
    return jsonify({"waitlist": entry}), 201


@bp.get("/waitlist/mine")
@require_auth
def my_waitlist():
    expire_stale()
    rows = (
        get_supabase().table("waitlist")
        .select("*, businesses(name), services(name)")
        .eq("customer_id", g.user["id"])
        .order("preferred_date")
        .execute()
        .data
    )
    return jsonify({"waitlist": rows})


@bp.delete("/waitlist/<entry_id>")
@require_auth
def leave_waitlist(entry_id):
    deleted = get_supabase().table("waitlist").delete().eq("id", entry_id).eq("customer_id", g.user["id"]).execute().data
    if not deleted:
        return api_error("Waitlist entry not found.", 404)
    return jsonify({"deleted": True})


@bp.get("/notifications")
@require_auth
def my_notifications():
    expire_stale()
    rows = (
        get_supabase().table("notifications")
        .select("*, flash_slots(status, expires_at)")
        .eq("user_id", g.user["id"])
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
    )
    return jsonify({"notifications": rows, "unread": sum(1 for r in rows if not r["is_read"])})


@bp.post("/notifications/read")
@require_auth
def mark_notifications_read():
    get_supabase().table("notifications").update({"is_read": True}).eq("user_id", g.user["id"]).eq("is_read", False).execute()
    return jsonify({"ok": True})
