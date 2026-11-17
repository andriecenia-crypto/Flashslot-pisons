/* =====================================================================
   FlashSlot — owner dashboard
   Tabs: overview, appointments, services, staff, flash slots, waitlist, business
   ===================================================================== */
(async function () {
  "use strict";
  const { api, esc, money, fmtDateTime, confirmDialog, toast, modal, requireLogin } = FS;
  const $ = (id) => document.getElementById(id);
  const panel = $("panel");

  if (!(await requireLogin())) return;
  let profile;
  try {
    profile = await FS.me();
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  if (profile.user.role !== "admin") { location.href = "dashboard.html"; return; }

  let business = profile.business;
  let currentTab = "overview";

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocalInput = (value) => new Date(value).toISOString();

  const header = (title, actionHtml = "") => `<div class="panel-head"><h2>${esc(title)}</h2><div>${actionHtml}</div></div>`;
  const empty = (title, text) => `<div class="card empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

  /** Responsive table: on small screens each row becomes a labelled card (see CSS). */
  function table(columns, rows) {
    return `<div class="card table-wrap"><table class="rtable"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((cells) => `<tr>${cells.map((cell, i) => `<td data-label="${esc(columns[i])}">${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  /** Generic form modal. fields: [{name,label,type,options,required,step,min,placeholder,value}] */
  function formModal({ title, fields, submitText = "Save", onSubmit }) {
    const control = (f) => {
      const common = `id="f-${f.name}" name="${f.name}" ${f.required ? "required" : ""}`;
      if (f.type === "select") {
        return `<select ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? "") ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
      }
      if (f.type === "textarea") return `<textarea ${common} placeholder="${esc(f.placeholder || "")}">${esc(f.value ?? "")}</textarea>`;
      return `<input ${common} type="${f.type || "text"}" value="${esc(f.value ?? "")}" ${f.step ? `step="${f.step}"` : ""} ${f.min !== undefined ? `min="${f.min}"` : ""} placeholder="${esc(f.placeholder || "")}">`;
    };
    modal({
      title,
      body: `<form class="inline-form" novalidate>
        <div class="form-error hidden" role="alert"></div>
        ${fields.map((f) => `<div class="field" style="margin:0"><label for="f-${f.name}">${esc(f.label)}</label>${control(f)}${f.hint ? `<div class="muted small">${esc(f.hint)}</div>` : ""}</div>`).join("")}
        <div class="modal-foot" style="margin-top:0"><button type="submit" class="btn btn-primary">${esc(submitText)}</button></div>
      </form>`,
      onMount: (root, close) => {
        const form = root.querySelector("form");
        const errorBox = root.querySelector(".form-error");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          errorBox.classList.add("hidden");
          const values = {};
          fields.forEach((f) => { values[f.name] = form.elements[f.name].value.trim(); });
          const missing = fields.find((f) => f.required && !values[f.name]);
          if (missing) { errorBox.textContent = `Fill in "${missing.label}".`; errorBox.classList.remove("hidden"); return; }
          const btn = form.querySelector("button[type=submit]");
          btn.disabled = true;
          try {
            await onSubmit(values);
            close();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove("hidden");
            btn.disabled = false;
          }
        });
      },
    });
  }

  async function guarded(fn) {
    try { await fn(); } catch (e) { toast(e.message, "error"); }
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------
  const tabs = {
    overview: renderOverview,
    appointments: renderAppointments,
    services: renderServices,
    staff: renderStaff,
    flash: renderFlash,
    waitlist: renderWaitlist,
    business: renderBusiness,
  };

  async function show(tab) {
    currentTab = tab;
    document.querySelectorAll("#side button").forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    panel.innerHTML = '<div class="skeleton"></div>';
    try {
      if (!business && tab !== "business") { await renderBusiness(); return; }
      await tabs[tab]();
    } catch (e) {
      panel.innerHTML = empty("Something went wrong", e.message);
    }
  }
  document.getElementById("side").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) show(btn.dataset.tab);
  });
  const refresh = () => show(currentTab);

  // ---------------- Overview ----------------
  async function renderOverview() {
    const s = await api("/api/admin/overview");
    panel.innerHTML = `
      ${header(business.name)}
      <div class="stat-grid">
        <div class="card stat"><b>${s.upcoming}</b><span>Upcoming bookings</span></div>
        <div class="card stat"><b>${s.cancelled}</b><span>Cancellations</span></div>
        <div class="card stat"><b>${s.active_flash_slots}</b><span>Live flash slots</span></div>
        <div class="card stat"><b>${s.claimed_flash_slots}</b><span>Flash slots claimed</span></div>
        <div class="card stat"><b>${money(s.recovered_revenue)}</b><span>Revenue recovered</span></div>
        <div class="card stat"><b>${s.waitlist_active}</b><span>People on waitlists</span></div>
      </div>
      <div class="card card-body" style="margin-top:1.25rem">
        <h3>How Quick-Fill works</h3>
        <p class="muted" style="margin:.5rem 0 0">Mark any booked appointment as cancelled and FlashSlot instantly lists that time on the homepage at a discount, with a countdown. Waitlisted customers for the same service and date get an alert. If someone claims it, the revenue shows up above.</p>
      </div>`;
  }

  // ---------------- Appointments ----------------
  let apptFilter = "";
  async function renderAppointments() {
    const { appointments } = await api("/api/admin/appointments" + (apptFilter ? `?status=${apptFilter}` : ""));
    const filter = `<select id="appt-filter" style="width:auto;display:inline-block;margin-right:.5rem" aria-label="Filter by status">
      ${[["", "All statuses"], ["booked", "Booked"], ["completed", "Completed"], ["cancelled", "Cancelled"]].map(([v, l]) => `<option value="${v}" ${v === apptFilter ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn btn-primary" id="new-appt">New appointment</button>`;
    panel.innerHTML = header("Appointments", filter) + (appointments.length
      ? table(["When", "Customer", "Service", "Staff", "Status", "Actions"], appointments.map((a) => [
          `<strong>${esc(fmtDateTime(a.slot_time))}</strong>`,
          `${esc(a.customer ? a.customer.full_name || a.customer.email : "Unknown")}<div class="muted small">${esc(a.customer ? a.customer.email : "")}</div>`,
          a.services ? `${esc(a.services.name)}<div class="muted small">${money(a.services.price)}</div>` : '<span class="muted">Removed</span>',
          esc(a.staff ? a.staff.name : "Removed"),
          `<span class="badge badge-${esc(a.status)}">${esc(a.status)}</span>`,
          `<div class="row-actions">
            ${a.status === "booked" ? `<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(a.id)}">Cancel</button><button class="btn btn-sm" data-act="complete" data-id="${esc(a.id)}">Complete</button>` : ""}
            ${a.status === "cancelled" ? `<button class="btn btn-sm" data-act="reopen" data-id="${esc(a.id)}">Reopen</button>` : ""}
            <button class="btn btn-sm btn-ghost" data-act="edit" data-id="${esc(a.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-act="delete" data-id="${esc(a.id)}">Delete</button></div>`,
        ]))
      : empty("No appointments", "Bookings from customers will appear here."));

    $("appt-filter").addEventListener("change", (e) => { apptFilter = e.target.value; refresh(); });
    $("new-appt").addEventListener("click", () => guarded(() => appointmentForm(null)));
    panel.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => guarded(() => appointmentAction(btn.dataset.act, appointments.find((x) => x.id === btn.dataset.id))))
    );
  }

  async function appointmentAction(act, appt) {
    if (act === "cancel") {
      formModal({
        title: "Cancel and offer as a flash slot",
        submitText: "Cancel appointment",
        fields: [{ name: "discount", label: "Flash discount (%)", type: "number", min: 1, step: 1, value: 30, required: true, hint: "The freed time is listed on the homepage at this discount until shortly before it starts." }],
        onSubmit: async (v) => {
          const res = await api(`/api/admin/appointments/${appt.id}`, { method: "PUT", body: { status: "cancelled", discount_percentage: Number(v.discount) } });
          const qf = res.quick_fill;
          if (qf && qf.flash_slot) toast(`Flash slot live at ${qf.flash_slot.discount_percentage}% off. ${qf.notified} waitlisted customer(s) alerted.`, "success");
          else toast(`Cancelled. ${qf && qf.reason ? qf.reason : ""}`, "info");
          refresh();
        },
      });
    } else if (act === "complete" || act === "reopen") {
      await api(`/api/admin/appointments/${appt.id}`, { method: "PUT", body: { status: act === "complete" ? "completed" : "booked" } });
      toast(act === "complete" ? "Marked as completed." : "Appointment reopened.", "success");
      refresh();
    } else if (act === "edit") {
      await appointmentForm(appt);
    } else if (act === "delete") {
      if (await confirmDialog({ title: "Delete this appointment?", message: "This removes the record permanently.", confirmText: "Delete", danger: true })) {
        await api(`/api/admin/appointments/${appt.id}`, { method: "DELETE" });
        toast("Appointment deleted.", "success");
        refresh();
      }
    }
  }

  async function appointmentForm(appt) {
    const [{ services }, { staff }] = await Promise.all([api("/api/admin/services"), api("/api/admin/staff")]);
    if (!services.length || !staff.length) { toast("Add at least one service and one staff member first.", "error"); return; }
    const fields = [];
    if (!appt) fields.push({ name: "customer_email", label: "Customer email", type: "email", required: true, hint: "The customer must already have a FlashSlot account." });
    fields.push(
      { name: "service_id", label: "Service", type: "select", value: appt ? appt.service_id : services[0].id, options: services.map((s) => ({ value: s.id, label: `${s.name} (${s.duration_minutes} min)` })) },
      { name: "staff_id", label: "Staff member", type: "select", value: appt ? appt.staff_id : staff[0].id, options: staff.map((s) => ({ value: s.id, label: s.name })) },
      { name: "slot_time", label: "Date and time", type: "datetime-local", required: true, value: appt ? toLocalInput(appt.slot_time) : "" },
    );
    formModal({
      title: appt ? "Edit appointment" : "New appointment",
      fields,
      onSubmit: async (v) => {
        const body = { service_id: v.service_id, staff_id: v.staff_id, slot_time: fromLocalInput(v.slot_time) };
        if (appt) await api(`/api/admin/appointments/${appt.id}`, { method: "PUT", body });
        else await api("/api/admin/appointments", { method: "POST", body: { ...body, customer_email: v.customer_email } });
        toast(appt ? "Appointment updated." : "Appointment created.", "success");
        refresh();
      },
    });
  }

  // ---------------- Services ----------------
  async function renderServices() {
    const { services } = await api("/api/admin/services");
    panel.innerHTML = header("Services", '<button class="btn btn-primary" id="add-service">Add service</button>') + (services.length
      ? table(["Service", "Duration", "Price", "Actions"], services.map((s) => [
          `<div class="person"><img class="thumb" src="${esc(FS.thumbFor(business.category))}" alt=""><div><strong>${esc(s.name)}</strong><div class="muted small">${esc(s.description)}</div></div></div>`,
          `${s.duration_minutes} min`,
          money(s.price),
          `<div class="row-actions"><button class="btn btn-sm btn-ghost" data-edit="${esc(s.id)}">Edit</button><button class="btn btn-sm btn-danger" data-del="${esc(s.id)}">Delete</button></div>`,
        ]))
      : empty("No services yet", "Add the services customers can book."));

    const form = (svc) => formModal({
      title: svc ? "Edit service" : "Add service",
      fields: [
        { name: "name", label: "Name", required: true, value: svc ? svc.name : "" },
        { name: "description", label: "Description", type: "textarea", value: svc ? svc.description : "" },
        { name: "duration_minutes", label: "Duration (minutes)", type: "number", min: 5, step: 5, required: true, value: svc ? svc.duration_minutes : 30 },
        { name: "price", label: "Price", type: "number", min: 0, step: "0.01", required: true, value: svc ? svc.price : "" },
      ],
      onSubmit: async (v) => {
        const body = { name: v.name, description: v.description, duration_minutes: Number(v.duration_minutes), price: Number(v.price) };
        if (svc) await api(`/api/admin/services/${svc.id}`, { method: "PUT", body });
        else await api("/api/admin/services", { method: "POST", body });
        toast("Service saved.", "success");
        refresh();
      },
    });
    $("add-service").addEventListener("click", () => form(null));
    panel.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => form(services.find((s) => s.id === b.dataset.edit))));
    panel.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => guarded(async () => {
      if (await confirmDialog({ title: "Delete this service?", message: "Existing appointments keep their history but lose the service name.", confirmText: "Delete", danger: true })) {
        await api(`/api/admin/services/${b.dataset.del}`, { method: "DELETE" });
        toast("Service deleted.", "success");
        refresh();
      }
    })));
  }

  // ---------------- Staff ----------------
  async function renderStaff() {
    const { staff } = await api("/api/admin/staff");
    panel.innerHTML = header("Staff", '<button class="btn btn-primary" id="add-staff">Add staff member</button>') + (staff.length
      ? table(["Name", "Role", "Actions"], staff.map((s) => [
          `<div class="person"><img class="avatar" src="${esc(s.avatar_url || "")}" alt=""><strong>${esc(s.name)}</strong></div>`,
          esc(s.role),
          `<div class="row-actions"><button class="btn btn-sm btn-ghost" data-edit="${esc(s.id)}">Edit</button><button class="btn btn-sm btn-danger" data-del="${esc(s.id)}">Delete</button></div>`,
        ]))
      : empty("No staff yet", "Add the people customers can book with."));

    const form = (member) => formModal({
      title: member ? "Edit staff member" : "Add staff member",
      fields: [
        { name: "name", label: "Name", required: true, value: member ? member.name : "" },
        { name: "role", label: "Role", value: member ? member.role : "", placeholder: "Barber, Dentist, Groomer…" },
        { name: "avatar_url", label: "Photo URL", type: "url", value: member ? member.avatar_url : "", placeholder: "https://images.unsplash.com/…", hint: "Optional. Use any public image link." },
      ],
      onSubmit: async (v) => {
        if (member) await api(`/api/admin/staff/${member.id}`, { method: "PUT", body: v });
        else await api("/api/admin/staff", { method: "POST", body: v });
        toast("Staff member saved.", "success");
        refresh();
      },
    });
    $("add-staff").addEventListener("click", () => form(null));
    panel.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => form(staff.find((s) => s.id === b.dataset.edit))));
    panel.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => guarded(async () => {
      if (await confirmDialog({ title: "Remove this staff member?", message: "Their past appointments are kept.", confirmText: "Remove", danger: true })) {
        await api(`/api/admin/staff/${b.dataset.del}`, { method: "DELETE" });
        toast("Staff member removed.", "success");
        refresh();
      }
    })));
  }

  // ---------------- Flash slots ----------------
  async function renderFlash() {
    const { flash_slots } = await api("/api/admin/flash-slots");
    panel.innerHTML = header("Flash slots") + (flash_slots.length
      ? table(["Slot", "Service", "Offer", "Ends", "Status", "Actions"], flash_slots.map((f) => {
          const appt = f.appointments || {};
          const live = f.status === "active";
          return [
            `<strong>${esc(appt.slot_time ? fmtDateTime(appt.slot_time) : "n/a")}</strong><div class="muted small">${esc(appt.staff ? appt.staff.name : "")}</div>`,
            esc(appt.services ? appt.services.name : "Removed"),
            `${money(f.flash_price)} <span class="badge">${f.discount_percentage}% off</span>`,
            live ? `<span class="countdown" data-expires="${esc(f.expires_at)}">${FS.remaining(new Date(f.expires_at) - Date.now())}</span>` : esc(fmtDateTime(f.expires_at)),
            `<span class="badge badge-${esc(f.status)}">${esc(f.status)}</span>`,
            live ? `<button class="btn btn-sm btn-danger" data-withdraw="${esc(f.id)}">Withdraw</button>` : "",
          ];
        }))
      : empty("No flash slots yet", "Cancel a booked appointment and a flash slot is created automatically."));
    FS.startTicker();
    panel.querySelectorAll("[data-withdraw]").forEach((b) => b.addEventListener("click", () => guarded(async () => {
      await api(`/api/admin/flash-slots/${b.dataset.withdraw}/withdraw`, { method: "POST" });
      toast("Flash slot withdrawn.", "success");
      refresh();
    })));
  }

  // ---------------- Waitlist + alert log ----------------
  async function renderWaitlist() {
    const [{ waitlist }, { notifications }] = await Promise.all([api("/api/admin/waitlist"), api("/api/admin/notifications")]);
    panel.innerHTML = header("Waitlist") + (waitlist.length
      ? table(["Customer", "Service", "Preferred date", "Status"], waitlist.map((w) => [
          `${esc(w.customer ? w.customer.full_name || w.customer.email : "Unknown")}<div class="muted small">${esc(w.customer ? w.customer.email : "")}</div>`,
          esc(w.services ? w.services.name : "Any service"),
          esc(new Date(w.preferred_date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })),
          `<span class="badge badge-${esc(w.status)}">${esc(w.status)}</span>`,
        ]))
      : empty("Nobody is waiting", "Customers who join your waitlist show up here."))
      + `<div style="height:1.5rem"></div>` + header("Alert log")
      + (notifications.length
        ? `<div class="card">${notifications.map((n) => `<div class="alert-item"><div><div>${esc(n.message)}</div><div class="muted small">To ${esc(n.customer ? n.customer.email : "customer")} &middot; ${esc(fmtDateTime(n.created_at))} &middot; ${esc(n.channel)} (simulated)</div></div></div>`).join("")}</div>`
        : empty("No alerts sent", "Alerts are created when a flash slot matches a waitlist entry."));
  }

  // ---------------- Business profile ----------------
  async function renderBusiness() {
    const b = business || {};
    panel.innerHTML = header(business ? "My business" : "Set up your business") + `
      <div class="card card-body">
        <form id="biz-form" class="inline-form" novalidate>
          <div class="form-error hidden" role="alert"></div>
          <div class="field" style="margin:0"><label for="b-name">Business name</label><input id="b-name" value="${esc(b.name || "")}" required></div>
          <div class="field" style="margin:0"><label for="b-category">Category</label>
            <select id="b-category">${[["barbershop", "Barbershop"], ["dental", "Dental clinic"], ["grooming", "Pet groomer"], ["other", "Other"]].map(([v, l]) => `<option value="${v}" ${b.category === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="field" style="margin:0"><label for="b-address">Address</label><input id="b-address" value="${esc(b.address || "")}"></div>
          <div class="field" style="margin:0"><label for="b-image">Cover image URL</label><input id="b-image" type="url" value="${esc(b.image_url || "")}" placeholder="https://images.unsplash.com/…"></div>
          <div class="field" style="margin:0"><label for="b-desc">Description</label><textarea id="b-desc">${esc(b.description || "")}</textarea></div>
          <div><button class="btn btn-primary" type="submit">Save business</button></div>
        </form>
      </div>`;
    const form = $("biz-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      guarded(async () => {
        const body = { name: $("b-name").value.trim(), category: $("b-category").value, address: $("b-address").value.trim(), image_url: $("b-image").value.trim(), description: $("b-desc").value.trim() };
        if (!body.name) throw new Error("Enter your business name.");
        const res = business ? await api("/api/admin/business", { method: "PUT", body }) : await api("/api/admin/business", { method: "POST", body });
        business = res.business;
        toast("Business saved.", "success");
        if (currentTab === "business" && !profile.business) { profile.business = business; show("overview"); }
      });
    });
  }

  show("overview");
})();
