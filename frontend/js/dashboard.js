/* =====================================================================
   FlashSlot — customer dashboard: appointments, waitlists and alerts
   ===================================================================== */
(async function () {
  "use strict";
  const { api, esc, money, fmtDateTime, confirmDialog, toast, requireLogin } = FS;
  const $ = (id) => document.getElementById(id);

  if (!(await requireLogin())) return;

  let profile;
  try {
    profile = await FS.me();
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  if (profile.user.role === "admin") { location.href = "admin.html"; return; }
  $("greeting").textContent = `Signed in as ${profile.user.full_name || profile.user.email}.`;

  const emptyBlock = (title, text, action = "") => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;

  function apptRow(a, { cancellable }) {
    const d = new Date(a.slot_time);
    const status = a.status === "booked" && d < new Date() ? "completed" : a.status;
    return `
      <div class="appt">
        <div class="appt-date"><b>${d.getDate()}</b><span>${esc(d.toLocaleString(undefined, { month: "short" }))}</span></div>
        <div>
          <strong>${esc(a.services ? a.services.name : "Service removed")}</strong>
          <span class="badge badge-${esc(status)}" style="margin-left:.4rem">${esc(status)}</span>
          <div class="muted small">${esc(a.businesses ? a.businesses.name : "")} &middot; ${esc(fmtDateTime(a.slot_time))}${a.staff ? " &middot; with " + esc(a.staff.name) : ""}</div>
          ${a.services ? `<div class="small">${money(a.services.price)} &middot; ${a.services.duration_minutes} min</div>` : ""}
        </div>
        <div class="row-actions">${cancellable ? `<button class="btn btn-danger btn-sm" data-cancel="${esc(a.id)}">Cancel</button>` : ""}</div>
      </div>`;
  }

  async function load() {
    const [appts, wl, notes] = await Promise.all([
      api("/api/appointments/mine"), api("/api/waitlist/mine"), api("/api/notifications"),
    ]);

    // Alerts (mock notifications created when a waitlisted slot opens)
    $("alerts").innerHTML = notes.notifications.length
      ? notes.notifications.map((n) => {
          const live = n.flash_slots && n.flash_slots.status === "active" && new Date(n.flash_slots.expires_at) > new Date();
          const state = n.flash_slots ? (live ? '<a class="btn btn-primary btn-sm" href="index.html#flash">Claim now</a>' : `<span class="badge badge-${esc(n.flash_slots.status === "claimed" ? "claimed" : "expired")}">${n.flash_slots.status === "claimed" ? "Claimed" : "Expired"}</span>`) : "";
          return `<div class="alert-item ${n.is_read ? "" : "unread"}"><div><div>${esc(n.message)}</div><div class="muted small">${esc(fmtDateTime(n.created_at))} &middot; ${esc(n.channel)}</div></div>${state}</div>`;
        }).join("")
      : emptyBlock("No alerts yet", "Join a waitlist and we will tell you when a matching slot opens.", '<a class="btn btn-ghost btn-sm" href="index.html#businesses">Find a business</a>');
    $("mark-read").classList.toggle("hidden", notes.unread === 0);

    const now = new Date();
    const upcoming = appts.appointments.filter((a) => a.status === "booked" && new Date(a.slot_time) >= now).sort((a, b) => new Date(a.slot_time) - new Date(b.slot_time));
    const history = appts.appointments.filter((a) => !upcoming.includes(a));

    $("upcoming").innerHTML = upcoming.length
      ? upcoming.map((a) => apptRow(a, { cancellable: true })).join("")
      : emptyBlock("Nothing booked", "Book a regular appointment or grab a flash slot.", '<a class="btn btn-primary btn-sm" href="index.html">Browse slots</a>');
    $("history").innerHTML = history.length ? history.map((a) => apptRow(a, { cancellable: false })).join("") : emptyBlock("No history yet", "Past and cancelled appointments will show up here.");

    $("waitlist").innerHTML = wl.waitlist.length
      ? wl.waitlist.map((w) => `
          <div class="alert-item">
            <div><strong>${esc(w.businesses ? w.businesses.name : "Business")}</strong>
              <span class="badge badge-${esc(w.status)}" style="margin-left:.4rem">${esc(w.status)}</span>
              <div class="muted small">${esc(w.services ? w.services.name : "Any service")} &middot; ${esc(new Date(w.preferred_date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</div></div>
            <button class="btn btn-ghost btn-sm" data-leave="${esc(w.id)}">Leave waitlist</button>
          </div>`).join("")
      : emptyBlock("Not on any waitlist", "Waitlists are the fastest way to catch a cancelled slot.");
  }

  document.addEventListener("click", async (e) => {
    const cancelBtn = e.target.closest("[data-cancel]");
    const leaveBtn = e.target.closest("[data-leave]");
    try {
      if (cancelBtn) {
        const ok = await confirmDialog({ title: "Cancel this appointment?", message: "Your time will be offered to others as a discounted flash slot.", confirmText: "Cancel appointment", danger: true });
        if (!ok) return;
        await api(`/api/appointments/${cancelBtn.dataset.cancel}/cancel`, { method: "POST" });
        toast("Appointment cancelled.", "success");
        await load();
      } else if (leaveBtn) {
        await api(`/api/waitlist/${leaveBtn.dataset.leave}`, { method: "DELETE" });
        toast("You left the waitlist.", "success");
        await load();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("mark-read").addEventListener("click", async () => {
    try { await api("/api/notifications/read", { method: "POST" }); await load(); } catch (err) { toast(err.message, "error"); }
  });

  try { await load(); } catch (e) { toast(e.message, "error"); }
  setInterval(() => load().catch(() => {}), 45000);
})();
