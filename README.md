# FlashSlot

A cancellation "slot-filler" booking site for small businesses (barbershops, dental clinics, pet groomers).
When an appointment is cancelled, FlashSlot instantly lists the freed time as a discounted **Flash Slot** with a live
countdown, and alerts customers on the matching waitlist.

**Stack:** HTML/CSS/vanilla JS (Supabase JS SDK for auth and public reads) · Flask API · Supabase PostgreSQL · Render.

## How Quick-Fill works

1. An owner marks a booked appointment **Cancelled** (or a customer cancels their own).
2. `trigger_quick_fill()` in `backend/services/notification_service.py` creates a `flash_slots` row with a discounted
   price, expiring `FLASH_LEAD_MINUTES` before the original start time.
3. Waitlist entries for the same business, date and service (or "any service") get a `notifications` row (a mock alert,
   also written to the server log) and move to `notified`.
4. The homepage polls `/api/flash-slots` and shows each slot with a ticking countdown. The first signed-in customer to
   click **Claim slot** gets the booking. The claim is an atomic `active -> claimed` update, so two people cannot both win.

## Project layout

```
backend/   Flask app (app.py, config.py, routes/, services/)
database/  schema.sql (tables, indexes, triggers, RLS) and seed.sql (demo data)
frontend/  index, login, register, dashboard (customer), admin (owner) + css/ and js/
```

The Flask app also serves `frontend/`, so one process runs everything.

## Setup

### 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor:** run `database/schema.sql`, then `database/seed.sql`.
3. **Project Settings -> API:** copy the Project URL, the `anon` key and the `service_role` key.
4. For quick local testing, turn off **Authentication -> Providers -> Email -> Confirm email**. If you leave it on,
   sign-up shows a "check your inbox" message and owner set-up finishes on first sign-in.

### 2. Run locally
```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                    # then fill in the values
python -m backend.app                                   # http://localhost:5000
```

### 3. Try the flow
1. **Register an owner:** `register.html`, tick "I own a business", enter your `ADMIN_SIGNUP_CODE` and a business name.
   You land on the owner dashboard. Add a service and a staff member.
2. **Register a customer** in a private window and book your service from the homepage.
3. As the owner, open **Appointments -> Cancel**, choose a discount. A flash slot appears on the homepage.
4. Re-run `database/seed.sql` after your first sign-up to add demo flash slots to the homepage.

## Security model

- New accounts are always `customer`. Owners are promoted by `POST /api/auth/become-admin`, which requires the private
  `ADMIN_SIGNUP_CODE`. Keep that code secret and rotate it if it leaks.
- The browser only ever receives the public `anon` key. The `service_role` key stays on the server (Render env var).
- The API validates every request's Supabase JWT and checks ownership before any owner action.
- RLS policies in `schema.sql` protect direct database access from the browser (public catalogue, private bookings).
- A unique partial index prevents two booked appointments for the same staff member at the same start time.

## API summary

| Area | Endpoints |
| --- | --- |
| Auth | `GET /api/auth/me`, `POST /api/auth/become-admin` |
| Public | `GET /api/flash-slots`, `GET /api/availability?staff_id=&date=`, `GET /api/config`, `GET /api/health` |
| Customer | `POST /api/appointments`, `GET /api/appointments/mine`, `POST /api/appointments/<id>/cancel`, `POST /api/flash-slots/<id>/claim` |
| Waitlist | `POST /api/waitlist`, `GET /api/waitlist/mine`, `DELETE /api/waitlist/<id>`, `GET /api/notifications`, `POST /api/notifications/read` |
| Owner | `/api/admin/business`, `/api/admin/overview`, `/api/admin/services`, `/api/admin/staff`, `/api/admin/appointments`, `/api/admin/flash-slots`, `/api/admin/waitlist`, `/api/admin/notifications` |

## Deploy to Render

1. Push this folder to GitHub.
2. In Render choose **New -> Blueprint** and select the repo (it reads `render.yaml`).
3. Fill the prompted secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SIGNUP_CODE`.
4. In Supabase **Authentication -> URL Configuration**, set the Site URL to your Render URL.

## Customising

- **Currency:** change `CURRENCY` at the top of `frontend/js/app.js` (default `PHP`).
- **Booking hours:** `OPEN_HOUR`, `CLOSE_HOUR`, `SLOT_STEP` in the same file (visitor's local time).
- **Default discount / expiry lead time:** `FLASH_DISCOUNT_PERCENT`, `FLASH_LEAD_MINUTES` in `.env`.
- **Real notifications:** replace `_deliver()` in `notification_service.py` with an email/SMS provider.
- **Extra table:** `notifications` is an eighth table that stores the waitlist alerts.

## Notes

- Appointment times are stored in UTC and shown in each visitor's local time zone. Alert text written by the server
  shows times in UTC.
- Flash slots and waitlist entries are marked expired lazily whenever the API is read, so no background job is needed.
