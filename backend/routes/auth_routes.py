"""Authentication-related endpoints. Sign-up and sign-in themselves happen in the
browser via the Supabase JS SDK; the backend validates the resulting JWT."""
import hmac

from flask import Blueprint, g, jsonify, request

from backend.config import Config, api_error, get_supabase, require_auth

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

CATEGORIES = {"barbershop", "dental", "grooming", "other"}


def _owned_business(user_id):
    rows = (
        get_supabase().table("businesses").select("*").eq("owner_id", user_id)
        .order("created_at").limit(1).execute().data
    )
    return rows[0] if rows else None


@bp.get("/me")
@require_auth
def me():
    """Return the signed-in user's profile (role drives the dashboard redirect)."""
    business = _owned_business(g.user["id"]) if g.user["role"] == "admin" else None
    return jsonify({"user": g.user, "business": business})


@bp.post("/become-admin")
@require_auth
def become_admin():
    """Promote the signed-in user to business owner using the private invite code,
    and create their business listing."""
    data = request.get_json(silent=True) or {}
    code = str(data.get("invite_code", ""))
    if not Config.ADMIN_SIGNUP_CODE or not hmac.compare_digest(code.encode(), Config.ADMIN_SIGNUP_CODE.encode()):
        return api_error("That owner invite code is not valid.", 403)

    name = str(data.get("business_name", "")).strip()
    category = str(data.get("category", "other")).strip()
    if not name:
        return api_error("Enter your business name.")
    if category not in CATEGORIES:
        category = "other"

    sb = get_supabase()
    sb.table("users").update({"role": "admin"}).eq("id", g.user["id"]).execute()
    business = _owned_business(g.user["id"])
    if not business:
        business = (
            sb.table("businesses")
            .insert({
                "owner_id": g.user["id"],
                "name": name,
                "category": category,
                "description": str(data.get("description", "")).strip(),
                "address": str(data.get("address", "")).strip(),
                "image_url": str(data.get("image_url", "")).strip(),
            })
            .execute()
            .data[0]
        )
    return jsonify({"role": "admin", "business": business}), 201
