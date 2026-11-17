/* =====================================================================
   FlashSlot — shared helpers (window.FS) + homepage logic
   Loaded on every page after the Supabase JS SDK.
   ===================================================================== */
(function () {
  "use strict";

  const CURRENCY = "PHP"; // change to "USD", "EUR"... to switch every price in the UI
  const OPEN_HOUR = 9;    // booking grid opens at 09:00 (visitor's local time)
  const CLOSE_HOUR = 18;  // last appointment must finish by 18:00
  const SLOT_STEP = 30;   // minutes between start times

  const CATEGORY_LABELS = { barbershop: "Barbershop", dental: "Dental clinic", grooming: "Pet groomer", other: "Other" };
  const CATEGORY_THUMBS = {
    barbershop: "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=400&q=70",
    dental: "https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=400&q=70",
    grooming: "https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=400&q=70",
    other: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=400&q=70",
  };

  // ------------------------------------------------------------------
  // Small utilities
  // ------------------------------------------------------------------
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const money = (n) => {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: CURRENCY, maximumFractionDigits: 2 }).format(Number(n) || 0); }
    catch (e) { return CURRENCY + " " + (Number(n) || 0).toFixed(2); }
  };
  const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const categoryLabel = (c) => CATEGORY_LABELS[c] || "Other";
  const thumbFor = (category) => CATEGORY_THUMBS[category] || CATEGORY_THUMBS.other;

  function remaining(ms) {
    if (ms <= 0) return "Expired";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  let tickerStarted = false;
  function startTicker() {
    if (tickerStarted) return;
    tickerStarted = true;
    setInterval(() => {
      let expired = false;
      document.querySelectorAll("[data-expires]").forEach((el) => {
        const ms = new Date(el.dataset.expires).getTime() - Date.now();
        el.textContent = remaining(ms);
        if (ms <= 0) expired = true;
      });
      if (expired) document.dispatchEvent(new CustomEvent("fs:expired"));
    }, 1000);
  }

  // Hide broken images instead of showing a broken-image icon
  document.addEventListener("error", (e) => {
    if (e.target && e.target.tagName === "IMG") e.target.style.visibility = "hidden";
  }, true);

  // ------------------------------------------------------------------
  // Supabase + API
  // ------------------------------------------------------------------
  let clientPromise = null;
  function client() {
    if (!clientPromise) {
      clientPromise = fetch("/api/config")
        .then((r) => r.json())
        .then((cfg) => {
          if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error("Supabase is not configured on the server.");
          return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        });
    }
    return clientPromise;
  }

  async function getSession() {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    return data.session || null;
  }

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const session = await getSession();
      if (session) headers.Authorization = "Bearer " + session.access_token;
    }
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let payload = {};
    try { payload = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(payload.error || "Request failed (" + res.status + ").");
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  let profileCache = null;
  async function me() {
    if (profileCache) return profileCache;
    profileCache = await api("/api/auth/me");
    return profileCache;
  }

  async function signOut() {
    const sb = await client();
    await sb.auth.signOut();
    profileCache = null;
    location.href = "index.html";
  }

  /** Redirect to login unless signed in. Returns the session otherwise. */
  async function requireLogin() {
    const session = await getSession();
    if (!session) {
      location.href = "login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() || "index.html");
      return null;
    }
    return session;
  }

  // ------------------------------------------------------------------
  // UI helpers: toast, modal, header, theme
  // ------------------------------------------------------------------
  function toast(message, type = "info") {
    let host = document.getElementById("toasts");
    if (!host) { host = document.createElement("div"); host.id = "toasts"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function modal({ title, body, onMount }) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" type="button" data-close aria-label="Close">&times;</button></div>
        <div class="modal-body">${body}</div>
      </div>`;
    const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("[data-close]").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    const first = backdrop.querySelector("input, select, textarea, button.btn-primary");
    if (first) first.focus();
    const root = backdrop.querySelector(".modal-body");
    if (onMount) onMount(root, close);
    return { root, close };
  }

  function confirmDialog({ title, message, confirmText = "Confirm", danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const { root, close } = modal({
        title,
        body: `<p>${esc(message)}</p><div class="modal-foot"><button class="btn btn-ghost" data-no>Not now</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(confirmText)}</button></div>`,
      });
      root.querySelector("[data-no]").addEventListener("click", () => { done(false); close(); });
      root.querySelector("[data-yes]").addEventListener("click", () => { done(true); close(); });
      const backdrop = root.closest(".modal-backdrop");
      new MutationObserver(() => { if (!document.body.contains(backdrop)) done(false); }).observe(document.body, { childList: true });
    });
  }

  const ICON_BOLT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
  const ICON_THEME = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const ICON_MENU = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("fs-theme", next); } catch (e) { /* storage unavailable */ }
  }

  async function renderHeader() {
    const host = document.getElementById("site-header");
    if (!host) return;
    const page = document.body.dataset.page || "";
    const link = (href, label, key) => `<a href="${href}" class="${page === key ? "active" : ""}">${label}</a>`;
    const draw = (extra) => {
      host.className = "site-header";
      host.innerHTML = `
        <div class="container nav">
          <a class="brand" href="index.html"><span class="brand-mark">${ICON_BOLT}</span>FlashSlot</a>
          <nav class="nav-links" id="nav-links" aria-label="Main">
            ${link("index.html#flash", "Flash slots", "")}
            ${link("index.html#businesses", "Businesses", "")}
            ${extra}
            <button class="icon-btn" id="theme-btn" type="button" aria-label="Toggle dark mode">${ICON_THEME}</button>
          </nav>
          <button class="icon-btn nav-toggle" id="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">${ICON_MENU}</button>
        </div>`;
      host.querySelector("#theme-btn").addEventListener("click", toggleTheme);
      const toggle = host.querySelector("#nav-toggle");
      toggle.addEventListener("click", () => {
        const open = host.querySelector("#nav-links").classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
      });
      const out = host.querySelector("#signout-btn");
      if (out) out.addEventListener("click", signOut);
    };

    draw(`${link("login.html", "Sign in", "login")}<a class="btn btn-primary btn-sm" href="register.html">Join free</a>`);
    try {
      const session = await getSession();
      if (!session) return;
      const profile = await me();
      const dash = profile.user.role === "admin" ? link("admin.html", "Owner dashboard", "admin") : link("dashboard.html", "My bookings", "dashboard");
      draw(`${dash}<button class="btn btn-ghost btn-sm" id="signout-btn" type="button">Sign out</button>`);
    } catch (e) { /* header stays in signed-out state */ }
  }

  // ------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------
  window.FS = {
    esc, money, fmtDateTime, fmtTime, localDateStr, remaining, categoryLabel, thumbFor,
    client, getSession, api, me, signOut, requireLogin, toast, modal, confirmDialog, startTicker, renderHeader,
    OPEN_HOUR, CLOSE_HOUR, SLOT_STEP,
  };

  document.addEventListener("DOMContentLoaded", () => {
    renderHeader();
    if (document.body.dataset.page === "home") initHome();
  });

  // ==================================================================
  // HOMEPAGE
  // ==================================================================
  let businesses = [];
  let activeCategory = "all";

  function initHome() {
    startTicker();
    loadFlashSlots();
    loadBusinesses();
    document.addEventListener("fs:expired", loadFlashSlots);
    setInterval(loadFlashSlots, 30000);
    document.querySelectorAll("[data-filter]").forEach((btn) =>
      btn.addEventListener("click", () => {
        activeCategory = btn.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        renderBusinesses();
      })
    );
  }

  async function loadFlashSlots() {
    try {
      const { flash_slots } = await api("/api/flash-slots", { auth: false });
      renderBoard(flash_slots);
      renderFlashGrid(flash_slots);
    } catch (e) {
      document.getElementById("flash-grid").innerHTML = `<div class="card empty" style="grid-column:1/-1"><h3>Flash slots are unavailable</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  function renderBoard(slots) {
    const board = document.getElementById("board-rows");
    if (!slots.length) {
      board.innerHTML = `<div class="board-empty">No flash slots right now. Join a waitlist below and we will alert you the moment one opens.</div>`;
      return;
    }
    board.innerHTML = slots.slice(0, 3).map((s) => `
      <div class="board-row">
        <div><b>${esc(s.business.name)}</b><span>${esc(s.service.name)} &middot; ${esc(fmtDateTime(s.slot_time))}</span></div>
        <div class="board-time" data-expires="${esc(s.expires_at)}">${remaining(new Date(s.expires_at) - Date.now())}</div>
      </div>`).join("");
  }

  function renderFlashGrid(slots) {
    const grid = document.getElementById("flash-grid");
    if (!slots.length) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1"><h3>Nothing flashing at the moment</h3><p>New slots appear here the second a booking is cancelled. Check back soon or join a waitlist.</p><a class="btn btn-primary" href="#businesses">Browse businesses</a></div>`;
      return;
    }
    grid.innerHTML = slots.map((s) => `
      <article class="card flash-card">
        <span class="discount">${s.discount_percentage}% off</span>
        <img class="card-img" src="${esc(s.business.image_url || thumbFor(s.business.category))}" alt="" loading="lazy">
        <div class="card-body">
          <div><h3>${esc(s.service.name)}</h3><div class="muted small">${esc(s.business.name)} &middot; ${esc(categoryLabel(s.business.category))}</div></div>
          <div class="price-row"><span class="price">${money(s.flash_price)}</span><span class="price-old">${money(s.original_price)}</span></div>
          <div class="staff-line"><img class="avatar" src="${esc(s.staff.avatar_url || "")}" alt="">
            <span>${esc(s.staff.name || "Any available staff")}<br><strong>${esc(fmtDateTime(s.slot_time))}</strong></span></div>
          <div class="countdown-wrap">
            <div><div class="muted small">Offer ends in</div><div class="countdown" data-expires="${esc(s.expires_at)}">${remaining(new Date(s.expires_at) - Date.now())}</div></div>
            <button class="btn btn-primary" data-claim="${esc(s.id)}">Claim slot</button>
          </div>
        </div>
      </article>`).join("");

    grid.querySelectorAll("[data-claim]").forEach((btn) =>
      btn.addEventListener("click", () => claimSlot(slots.find((x) => x.id === btn.dataset.claim)))
    );
  }

  async function claimSlot(slot) {
    if (!(await getSession())) {
      toast("Sign in to claim this slot.", "info");
      setTimeout(() => (location.href = "login.html?next=index.html"), 700);
      return;
    }
    const ok = await confirmDialog({
      title: "Claim this flash slot?",
      message: `${slot.service.name} at ${slot.business.name}, ${fmtDateTime(slot.slot_time)}, for ${money(slot.flash_price)} (usually ${money(slot.original_price)}).`,
      confirmText: "Claim slot",
    });
    if (!ok) return;
    try {
      await api(`/api/flash-slots/${slot.id}/claim`, { method: "POST" });
      toast("Slot claimed. See you there!", "success");
      setTimeout(() => (location.href = "dashboard.html"), 900);
    } catch (e) {
      toast(e.message, "error");
      loadFlashSlots();
    }
  }

  // ---------------- Businesses ----------------
  async function loadBusinesses() {
    const grid = document.getElementById("business-grid");
    try {
      const sb = await client();
      const { data, error } = await sb.from("businesses").select("*, services(*), staff(*)").order("created_at");
      if (error) throw error;
      businesses = data || [];
      renderBusinesses();
    } catch (e) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1"><h3>Businesses could not be loaded</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  function renderBusinesses() {
    const grid = document.getElementById("business-grid");
    const list = businesses.filter((b) => activeCategory === "all" || b.category === activeCategory);
    if (!list.length) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1"><h3>No businesses here yet</h3><p>Try another category.</p></div>`;
      return;
    }
    grid.innerHTML = list.map((b) => `
      <article class="card" data-business="${esc(b.id)}">
        <img class="card-img" src="${esc(b.image_url || thumbFor(b.category))}" alt="" loading="lazy">
        <div class="card-body">
          <span class="badge">${esc(categoryLabel(b.category))}</span>
          <h3 style="margin-top:.5rem">${esc(b.name)}</h3>
          <p class="muted small">${esc(b.address)}</p>
          <p class="small">${esc(b.description)}</p>
          <ul class="svc-list">
            ${(b.services || []).map((s) => `
              <li class="svc-item">
                <div class="person"><img class="avatar" style="border-radius:10px" src="${esc(thumbFor(b.category))}" alt="">
                  <div><strong>${esc(s.name)}</strong><small>${s.duration_minutes} min &middot; ${money(s.price)}</small></div></div>
                <button class="btn btn-sm btn-primary" data-book="${esc(s.id)}">Book</button>
              </li>`).join("") || '<li class="muted small">No services listed yet.</li>'}
          </ul>
          <button class="btn btn-ghost btn-block" style="margin-top:.9rem" data-waitlist="${esc(b.id)}">Join the waitlist</button>
        </div>
      </article>`).join("");

    grid.querySelectorAll("[data-book]").forEach((btn) => {
      const biz = businesses.find((b) => b.id === btn.closest("[data-business]").dataset.business);
      btn.addEventListener("click", () => openBooking(biz, biz.services.find((s) => s.id === btn.dataset.book)));
    });
    grid.querySelectorAll("[data-waitlist]").forEach((btn) =>
      btn.addEventListener("click", () => openWaitlist(businesses.find((b) => b.id === btn.dataset.waitlist)))
    );
  }

  // ---------------- Booking modal ----------------
  function openBooking(business, service) {
    const staff = business.staff || [];
    if (!staff.length) { toast("This business has not added staff yet.", "error"); return; }
    const state = { staffId: staff[0].id, date: localDateStr(), slot: null, busy: [] };

    modal({
      title: `Book ${service.name}`,
      body: `
        <p class="muted small">${esc(business.name)} &middot; ${service.duration_minutes} min &middot; ${money(service.price)}</p>
        <div class="field"><label>Who would you like?</label>
          <div class="staff-pick" id="bk-staff">${staff.map((s) => `
            <button type="button" class="staff-opt" data-staff="${esc(s.id)}" aria-pressed="${s.id === state.staffId}">
              <img class="avatar" src="${esc(s.avatar_url || "")}" alt=""><span>${esc(s.name)}</span></button>`).join("")}</div></div>
        <div class="field"><label for="bk-date">Date</label><input type="date" id="bk-date" min="${localDateStr()}" value="${state.date}"></div>
        <div class="field"><label>Pick a time</label><div class="slot-grid" id="bk-slots" aria-live="polite"></div></div>
        <div class="form-error hidden" id="bk-error"></div>
        <div class="modal-foot"><button class="btn btn-primary" id="bk-confirm" disabled>Choose a time</button></div>`,
      onMount: (root, close) => {
        const slotsEl = root.querySelector("#bk-slots");
        const confirmBtn = root.querySelector("#bk-confirm");
        const errorEl = root.querySelector("#bk-error");

        async function refresh() {
          state.slot = null;
          confirmBtn.disabled = true;
          confirmBtn.textContent = "Choose a time";
          slotsEl.innerHTML = '<span class="muted small">Checking availability…</span>';
          try {
            const { busy } = await api(`/api/availability?staff_id=${encodeURIComponent(state.staffId)}&date=${state.date}`, { auth: false });
            state.busy = busy;
          } catch (e) { state.busy = []; }
          drawSlots();
        }

        function drawSlots() {
          const [y, mo, d] = state.date.split("-").map(Number);
          const buttons = [];
          for (let mins = OPEN_HOUR * 60; mins + service.duration_minutes <= CLOSE_HOUR * 60; mins += SLOT_STEP) {
            const start = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
            const end = new Date(start.getTime() + service.duration_minutes * 60000);
            const taken = state.busy.some((b) => new Date(b.start) < end && new Date(b.end) > start);
            const unavailable = start <= new Date() || taken;
            buttons.push(`<button type="button" class="slot" data-start="${start.toISOString()}" ${unavailable ? "disabled" : ""} aria-pressed="false">${esc(start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</button>`);
          }
          slotsEl.innerHTML = buttons.join("") || '<span class="muted small">No times on this date.</span>';
          if (!slotsEl.querySelector(".slot:not([disabled])")) slotsEl.insertAdjacentHTML("beforeend", '<p class="muted small" style="grid-column:1/-1">Fully booked. Try another day or join the waitlist.</p>');
        }

        root.querySelector("#bk-staff").addEventListener("click", (e) => {
          const btn = e.target.closest("[data-staff]");
          if (!btn) return;
          state.staffId = btn.dataset.staff;
          root.querySelectorAll("[data-staff]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
          refresh();
        });
        root.querySelector("#bk-date").addEventListener("change", (e) => { if (e.target.value) { state.date = e.target.value; refresh(); } });
        slotsEl.addEventListener("click", (e) => {
          const btn = e.target.closest(".slot");
          if (!btn || btn.disabled) return;
          slotsEl.querySelectorAll(".slot").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
          state.slot = btn.dataset.start;
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Book " + fmtDateTime(state.slot);
        });
        confirmBtn.addEventListener("click", async () => {
          if (!state.slot) return;
          if (!(await getSession())) { location.href = "login.html?next=index.html"; return; }
          confirmBtn.disabled = true;
          errorEl.classList.add("hidden");
          try {
            await api("/api/appointments", { method: "POST", body: { business_id: business.id, service_id: service.id, staff_id: state.staffId, slot_time: state.slot } });
            close();
            toast("Booked! Find it under My bookings.", "success");
          } catch (e) {
            errorEl.textContent = e.message;
            errorEl.classList.remove("hidden");
            confirmBtn.disabled = false;
            if (e.status === 409) refresh();
          }
        });
        refresh();
      },
    });
  }

  // ---------------- Waitlist modal ----------------
  function openWaitlist(business) {
    modal({
      title: "Join the waitlist",
      body: `
        <p class="muted">We will alert you if ${esc(business.name)} frees up a matching slot on your chosen date.</p>
        <div class="field"><label for="wl-service">Service</label>
          <select id="wl-service"><option value="">Any service</option>${(business.services || []).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="wl-date">Preferred date</label><input type="date" id="wl-date" min="${localDateStr()}" value="${localDateStr()}"></div>
        <div class="form-error hidden" id="wl-error"></div>
        <div class="modal-foot"><button class="btn btn-primary" id="wl-submit">Join waitlist</button></div>`,
      onMount: (root, close) => {
        root.querySelector("#wl-submit").addEventListener("click", async (ev) => {
          if (!(await getSession())) { location.href = "login.html?next=index.html"; return; }
          const errorEl = root.querySelector("#wl-error");
          ev.target.disabled = true;
          errorEl.classList.add("hidden");
          try {
            await api("/api/waitlist", { method: "POST", body: { business_id: business.id, service_id: root.querySelector("#wl-service").value || null, preferred_date: root.querySelector("#wl-date").value } });
            close();
            toast("You are on the waitlist.", "success");
          } catch (e) {
            errorEl.textContent = e.message;
            errorEl.classList.remove("hidden");
            ev.target.disabled = false;
          }
        });
      },
    });
  }
})();
