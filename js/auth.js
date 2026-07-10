/* ============================================================
   MoneyFlow — accounts & sync (client side).

   When the app is served by the MoneyFlow sync server, api/ping
   answers and the app runs in "synced" mode: login screen,
   per-user encrypted storage on the server, changes synced
   across devices. When it isn't (e.g. GitHub Pages), the app
   quietly falls back to device-only mode, exactly as before.
   ============================================================ */

const USERNAME_RE = /^[A-Za-z0-9]{3,16}$/;
const PASSWORD_RE = /^[A-Za-z0-9]{6,32}$/;
const LOCAL_MODE_KEY = "moneyflow.localmode";

const Auth = {
  user: null,        // username when signed in
  serverMode: false, // true when the sync server is reachable
  syncTimer: null,
  mode: "signin",    // auth screen tab

  async boot() {
    try {
      const r = await fetch("api/ping", { cache: "no-store" });
      this.serverMode = r.ok && (await r.json()).ok === true;
    } catch { this.serverMode = false; }

    if (this.serverMode) {
      try {
        const me = await fetch("api/me", { cache: "no-store" });
        if (me.ok) this.user = (await me.json()).username;
      } catch { /* offline — fall through to cached data */ }
    }

    if (this.user) {
      await this.pullServerData();
      App.init();
    } else if (this.serverMode && localStorage.getItem(LOCAL_MODE_KEY) !== "1") {
      this.showScreen();
    } else {
      App.init(); // device-only mode
    }
  },

  /* ---------- data sync ---------- */

  async pullServerData() {
    try {
      const r = await fetch("api/data", { cache: "no-store" });
      if (!r.ok) return;
      const server = await r.json();
      if (server && Array.isArray(server.transactions)) {
        localStorage.setItem("moneyflow.v1", JSON.stringify(server));
      } else {
        // brand-new account: adopt whatever is on this device
        const local = localStorage.getItem("moneyflow.v1");
        if (local) this.pushNow(local);
      }
    } catch { /* offline — use the cached local copy */ }
  },

  // called from Store.save() — batches rapid edits into one upload
  scheduleSync() {
    if (!this.user) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.pushNow(JSON.stringify(Store.data)), 800);
  },

  async pushNow(json) {
    try {
      const r = await fetch("api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: json
      });
      if (r.status === 401) this.user = null; // session expired; next reload asks to sign in
    } catch { /* offline — will sync on a future save */ }
  },

  async logout() {
    try { await fetch("api/logout", { method: "POST" }); } catch { /* ignore */ }
    // shared devices: don't leave the money data behind
    localStorage.removeItem("moneyflow.v1");
    localStorage.removeItem(LOCAL_MODE_KEY);
    location.reload();
  },

  /* ---------- login / register screen ---------- */

  showScreen() {
    const el = document.getElementById("auth-screen");
    el.classList.remove("hidden");
    this.setMode("signin");

    document.getElementById("auth-tab-signin").addEventListener("click", () => this.setMode("signin"));
    document.getElementById("auth-tab-register").addEventListener("click", () => this.setMode("register"));
    document.getElementById("auth-local-btn").addEventListener("click", () => {
      localStorage.setItem(LOCAL_MODE_KEY, "1");
      el.classList.add("hidden");
      App.init();
    });
    document.getElementById("auth-form").addEventListener("submit", e => {
      e.preventDefault();
      this.submit();
    });
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById("auth-tab-signin").classList.toggle("active", mode === "signin");
    document.getElementById("auth-tab-register").classList.toggle("active", mode === "register");
    document.getElementById("auth-bank-field").classList.toggle("hidden", mode !== "register");
    document.getElementById("auth-submit").textContent = mode === "signin" ? "Sign in" : "Create account";
    document.getElementById("auth-hint").textContent = mode === "register"
      ? "3–16 letters/numbers for the username, 6–32 letters+numbers for the password. The bank identifier is just a label so you know which account you're looking at — don't use real bank details."
      : "";
    this.error("");
  },

  error(msg) {
    const el = document.getElementById("auth-error");
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  },

  async submit() {
    const username = document.getElementById("auth-username").value.trim();
    const password = document.getElementById("auth-password").value;
    const bankId = document.getElementById("auth-bankid").value.trim();

    if (!USERNAME_RE.test(username))
      return this.error("Username must be 3–16 letters or numbers — no spaces or special characters.");
    if (!PASSWORD_RE.test(password) || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return this.error("Password must be 6–32 characters, letters and numbers only, with at least one letter and one number.");
    if (this.mode === "register" && (!bankId || bankId.length > 30))
      return this.error("Give your bank account a short name (up to 30 characters), e.g. “Main account”.");

    const btn = document.getElementById("auth-submit");
    btn.disabled = true;
    try {
      const r = await fetch("api/" + (this.mode === "signin" ? "login" : "register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return this.error(out.error || "Something went wrong — try again.");

      this.user = out.username;
      localStorage.removeItem(LOCAL_MODE_KEY);
      if (this.mode === "register") {
        // fresh account: start from this device's data (or empty) + the label
        await this.pullServerData();
        const raw = JSON.parse(localStorage.getItem("moneyflow.v1") || "null");
        const data = raw && Array.isArray(raw.transactions) ? raw : null;
        if (data) {
          data.settings.bankId = bankId;
          localStorage.setItem("moneyflow.v1", JSON.stringify(data));
          this.pushNow(JSON.stringify(data));
        }
      } else {
        await this.pullServerData();
      }
      document.getElementById("auth-screen").classList.add("hidden");
      App.init();
      if (this.mode === "register" && !JSON.parse(localStorage.getItem("moneyflow.v1") || "null")) {
        // no local data existed: set the label on the fresh store App.init created
        Store.data.settings.bankId = bankId;
        Store.save();
        App.updateChip();
      }
    } finally {
      btn.disabled = false;
    }
  }
};

document.addEventListener("DOMContentLoaded", () => Auth.boot());
