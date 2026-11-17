"""Quick-Fill pipeline.

When an appointment is cancelled this module:
  1. creates a discounted Flash Slot for the freed time,
  2. finds matching waitlist entries, and
  3. writes a mock notification record for each waitlisted customer
     (swap `_deliver` for an email/SMS/WhatsApp provider in production).
"""
import logging
from datetime import timedelta

from backend.config import Config, get_supabase, iso, now_utc, parse_dt

log = logging.getLogger("flashslot.notifications")


def _deliver(user, channel, message):
    """Mock delivery: log it. Replace with a real provider (Twilio, SendGrid...)."""
    log.info("[MOCK %s] to=%s :: %s", channel.upper(), user.get("email"), message)


def create_notification(user, message, flash_slot_id=None, waitlist_id=None, channel="in_app"):
    sb = get_supabase()
    row = (
        sb.table("notifications")
        .insert({
            "user_id": user["id"],
            "waitlist_id": waitlist_id,
            "flash_slot_id": flash_slot_id,
            "channel": channel,
            "message": message,
        })
        .execute()
        .data[0]
    )
    _deliver(user, channel, message)
    return row


def expire_stale():
    """Mark overdue flash slots and past waitlist entries as expired."""
    sb = get_supabase()
    now = iso(now_utc())
    sb.table("flash_slots").update({"status": "expired"}).eq("status", "active").lt("expires_at", now).execute()
    today = now_utc().date().isoformat()
    sb.table("waitlist").update({"status": "expired"}).in_("status", ["active", "notified"]).lt("preferred_date", today).execute()


def notify_waitlist(flash_slot, business, service, slot_time, exclude_customer_id=None):
    """Create an alert for every active waitlist entry that matches the freed slot."""
    sb = get_supabase()
    slot_date = slot_time.date().isoformat()
    query = (
        sb.table("waitlist")
        .select("id, customer_id, service_id, preferred_date, users(id, email, full_name)")
        .eq("business_id", business["id"])
        .eq("status", "active")
        .eq("preferred_date", slot_date)
    )
    entries = query.execute().data or []
    notified = []
    for entry in entries:
        if entry["service_id"] not in (None, service["id"]):
            continue
        if exclude_customer_id and entry["customer_id"] == exclude_customer_id:
            continue
        customer = entry.get("users") or {"id": entry["customer_id"], "email": ""}
        message = (
            f"Good news! {business['name']} just opened {service['name']} on "
            f"{slot_time.strftime('%a %d %b at %H:%M')} UTC for {flash_slot['discount_percentage']}% off "
            f"(now {float(flash_slot['flash_price']):.2f}). Claim it before it expires."
        )
        create_notification(customer, message, flash_slot_id=flash_slot["id"], waitlist_id=entry["id"])
        sb.table("waitlist").update({"status": "notified"}).eq("id", entry["id"]).execute()
        notified.append(entry["id"])
    return notified


def trigger_quick_fill(appointment_id, discount_percentage=None):
    """Create a Flash Slot for a cancelled appointment and alert the waitlist.

    Returns {"flash_slot": dict | None, "notified": int, "reason": str | None}.
    """
    sb = get_supabase()
    rows = (
        sb.table("appointments")
        .select("*, services(*), businesses(id, name)")
        .eq("id", appointment_id)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        return {"flash_slot": None, "notified": 0, "reason": "Appointment not found."}
    appt = rows[0]
    service, business = appt.get("services"), appt.get("businesses")
    if not service or not business:
        return {"flash_slot": None, "notified": 0, "reason": "The service no longer exists, so no flash slot was created."}

    existing = (
        sb.table("flash_slots").select("*").eq("appointment_id", appointment_id).eq("status", "active").limit(1).execute().data
    )
    if existing:
        return {"flash_slot": existing[0], "notified": 0, "reason": "A flash slot is already live for this time."}

    slot_time = parse_dt(appt["slot_time"])
    expires_at = slot_time - timedelta(minutes=Config.FLASH_LEAD_MINUTES)
    if expires_at <= now_utc():
        return {"flash_slot": None, "notified": 0, "reason": "The appointment starts too soon to offer as a flash slot."}

    try:
        discount = int(discount_percentage if discount_percentage is not None else Config.FLASH_DISCOUNT_PERCENT)
    except (TypeError, ValueError):
        discount = Config.FLASH_DISCOUNT_PERCENT
    discount = max(1, min(90, discount))
    flash_price = round(float(service["price"]) * (100 - discount) / 100, 2)

    flash_slot = (
        sb.table("flash_slots")
        .insert({
            "appointment_id": appointment_id,
            "business_id": business["id"],
            "discount_percentage": discount,
            "flash_price": flash_price,
            "expires_at": iso(expires_at),
            "status": "active",
        })
        .execute()
        .data[0]
    )
    notified = notify_waitlist(flash_slot, business, service, slot_time, exclude_customer_id=appt["customer_id"])
    return {"flash_slot": flash_slot, "notified": len(notified), "reason": None}
