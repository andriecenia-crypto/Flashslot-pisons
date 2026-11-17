"""Configuration, Supabase client, auth decorators and small shared helpers."""
import os
from datetime import datetime, timezone
from functools import wraps

from dotenv import load_dotenv
from flask import g, jsonify, request
from supabase import Client, create_client

load_dotenv()


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-me")
    SUPABASE_URL = os.getenv("SUPABASE_URL", "")
    SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
    SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    ADMIN_SIGNUP_CODE = os.getenv("ADMIN_SIGNUP_CODE", "")
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
    FLASH_DISCOUNT_PERCENT = int(os.getenv("FLASH_DISCOUNT_PERCENT", "30"))
    FLASH_LEAD_MINUTES = int(os.getenv("FLASH_LEAD_MINUTES", "15"))

    @classmethod
    def missing(cls):
        """Return the names of required settings that are not set."""
        required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]
        return [name for name in required if not getattr(cls, name)]


_client = None


def get_supabase() -> Client:
    """Return a cached service-role Supabase client (bypasses RLS, server-side only)."""
    global _client
    if _client is None:
        if Config.missing():
            raise RuntimeError("Missing environment variables: " + ", ".join(Config.missing()))
        _client = create_client(Config.SUPABASE_URL, Config.SUPABASE_SERVICE_ROLE_KEY)
    return _client


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def api_error(message, status=400):
    return jsonify({"error": message}), status


def now_utc():
    return datetime.now(timezone.utc)


def parse_dt(value):
    """Parse an ISO-8601 string into an aware UTC datetime. Raises ValueError if invalid."""
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        # Postgres may return fractional seconds with 5 digits; normalise them.
        if "." in text:
            head, rest = text.split(".", 1)
            digits = ""
            for ch in rest:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            tail = rest[len(digits):]
            text = f"{head}.{digits.ljust(6, '0')[:6]}{tail}"
        dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Authentication helpers
# ---------------------------------------------------------------------------
def _bearer_token():
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def _load_profile(auth_user):
    """Fetch the public.users row for an auth user, creating it if the trigger missed it."""
    sb = get_supabase()
    rows = sb.table("users").select("*").eq("id", auth_user.id).limit(1).execute().data
    if rows:
        return rows[0]
    meta = getattr(auth_user, "user_metadata", None) or {}
    created = (
        sb.table("users")
        .insert({
            "id": auth_user.id,
            "email": auth_user.email,
            "full_name": meta.get("full_name", ""),
            "role": "customer",
        })
        .execute()
        .data
    )
    return created[0]


def require_auth(fn):
    """Validate the Supabase JWT in the Authorization header and set g.user."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _bearer_token()
        if not token:
            return api_error("Sign in to continue.", 401)
        try:
            auth_user = get_supabase().auth.get_user(token).user
        except Exception:
            return api_error("Your session has expired. Sign in again.", 401)
        if not auth_user:
            return api_error("Your session has expired. Sign in again.", 401)
        g.user = _load_profile(auth_user)
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn):
    """Like require_auth, but the profile must have role 'admin'."""

    @wraps(fn)
    @require_auth
    def wrapper(*args, **kwargs):
        if g.user.get("role") != "admin":
            return api_error("This area is for business owners only.", 403)
        return fn(*args, **kwargs)

    return wrapper
