/* =====================================================================
   FlashSlot — login and registration (Supabase Auth + role redirect)
   ===================================================================== */
(function () {
  "use strict";
  const { client, api, esc } = FS;
  const $ = (id) => document.getElementById(id);
  const PENDING_KEY = "fs-pending-owner";

  function showError(message) {
    const box = $("form-error");
    box.textContent = message;
    box.classList.remove("hidden");
  }
  const clearError = () => $("form-error").classList.add("hidden");

  function safeNext() {
    const next = new URLSearchParams(location.search).get("next") || "";
    // Only allow simple same-site page names, never external URLs
    return /^[a-z]+\.html$/i.test(next) ? next : "";
  }

  /** Complete any owner sign-up that was waiting for email confirmation. */
  async function applyPendingOwner() {
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch (e) { pending = null; }
    if (!pending) return;
    try {
      await api("/api/auth/become-admin", { method: "POST", body: pending });
      FS.toast("Your business is set up.", "success");
    } catch (e) {
      FS.toast(e.message, "error");
    } finally {
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    }
  }

  async function redirectByRole() {
    await applyPendingOwner();
    const { user } = await api("/api/auth/me");
    const next = safeNext();
    if (user.role === "admin") location.href = "admin.html";
    else location.href = next || "dashboard.html";
  }

  // ---------------- Login page ----------------
  if ($("login-btn")) {
    const submit = async () => {
      clearError();
      const email = $("email").value.trim();
      const password = $("password").value;
      if (!email || !password) return showError("Enter your email and password.");
      $("login-btn").disabled = true;
      try {
        const sb = await client();
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await redirectByRole();
      } catch (e) {
        showError(e.message || "We could not sign you in.");
        $("login-btn").disabled = false;
      }
    };
    $("login-btn").addEventListener("click", submit);
    $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    client().then((sb) => sb.auth.getSession()).then(({ data }) => { if (data.session) redirectByRole().catch(() => {}); }).catch(() => {});
  }

  // ---------------- Register page ----------------
  if ($("register-btn")) {
    const ownerBox = $("is-owner");
    const toggleOwner = () => $("owner-fields").classList.toggle("hidden", !ownerBox.checked);
    ownerBox.addEventListener("change", toggleOwner);
    if (new URLSearchParams(location.search).get("role") === "owner") { ownerBox.checked = true; toggleOwner(); }

    $("register-btn").addEventListener("click", async () => {
      clearError();
      const fullName = $("full-name").value.trim();
      const email = $("email").value.trim();
      const password = $("password").value;
      const isOwner = ownerBox.checked;
      if (!fullName || !email) return showError("Enter your name and email.");
      if (password.length < 8) return showError("Use a password with at least 8 characters.");
      const owner = isOwner ? { invite_code: $("invite-code").value.trim(), business_name: $("business-name").value.trim(), category: $("category").value } : null;
      if (isOwner && (!owner.invite_code || !owner.business_name)) return showError("Owners need an invite code and a business name.");

      $("register-btn").disabled = true;
      try {
        const sb = await client();
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
        if (error) throw error;

        if (!data.session) {
          // Email confirmation is switched on: finish owner set-up after the first login.
          if (owner) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(owner)); } catch (e) { /* ignore */ } }
          $("register-btn").closest(".card-body").innerHTML = `<h1>Check your inbox</h1><p class="muted">We sent a confirmation link to <strong>${esc(email)}</strong>. Confirm it, then <a href="login.html">sign in</a>.${owner ? " Your business will be set up on first sign-in." : ""}</p>`;
          return;
        }
        if (owner) await api("/api/auth/become-admin", { method: "POST", body: owner });
        location.href = owner ? "admin.html" : "dashboard.html";
      } catch (e) {
        showError(e.message || "We could not create your account.");
        $("register-btn").disabled = false;
      }
    });
  }
})();
