/* ============================================================
   MoneyFlow — application logic and rendering.
   ============================================================ */

const VIEW_ORDER = ["dashboard", "transactions", "budgets", "funds", "settings"];

const App = {
  view: "dashboard",
  month: null, // {y, m} month currently displayed
  editingTxId: null,
  editingFundId: null,
  fundEntrySign: 1,

  init() {
    Store.load();
    const now = new Date();
    this.month = { y: now.getFullYear(), m: now.getMonth() };
    this.updateChip();
    this.bindNav();
    this.bindMonthNav();
    this.bindTxModal();
    this.bindBudgets();
    this.bindFunds();
    this.bindSettings();
    this.renderAll();

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    window.addEventListener("resize", () => {
      if (this.view === "dashboard") this.renderCharts(false);
    });

    // stat tiles jump to the activity list, pre-filtered
    const tileGo = (id, type) => document.getElementById(id).closest(".tile")
      .addEventListener("click", () => {
        document.getElementById("tx-filter-type").value = type;
        this.showView("transactions");
      });
    tileGo("tile-income", "income");
    tileGo("tile-expenses", "expense");
    tileGo("tile-net", "");
  },

  /* ================= formatting ================= */
  currency() { return Store.data.settings.currency || "₪"; },

  fmtMoney(v) {
    const sign = v < 0 ? "-" : "";
    return `${sign}${this.currency()}${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  },

  fmtMoneyShort(v) {
    const a = Math.abs(v);
    if (a >= 1000) return `${v < 0 ? "-" : ""}${this.currency()}${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return this.fmtMoney(v);
  },

  ymStr() { return ymKey(this.month.y, this.month.m); },

  monthName(y, m, short = false) {
    return new Date(y, m, 1).toLocaleDateString("en-US", { month: short ? "short" : "long", year: short ? undefined : "numeric" });
  },

  // "March 12" from a 1-12 month number and day
  monthDayLabel(month, day) {
    const name = new Date(2000, (month || 1) - 1, 1).toLocaleDateString("en-US", { month: "long" });
    return `${name} ${day}`;
  },

  isCurrentMonth() {
    const n = new Date();
    return this.month.y === n.getFullYear() && this.month.m === n.getMonth();
  },

  /* ================= navigation ================= */
  bindNav() {
    document.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => this.showView(btn.dataset.view));
    });
    document.getElementById("settings-btn").addEventListener("click", () => this.showView("settings"));
  },

  updateChip() {
    const bankId = (Store.data.settings.bankId || "").trim();
    document.getElementById("bank-chip").classList.toggle("hidden", !bankId);
    document.getElementById("bank-chip-name").textContent = bankId;
  },

  showView(name) {
    const fromIdx = VIEW_ORDER.indexOf(this.view);
    const toIdx = VIEW_ORDER.indexOf(name);
    const changed = name !== this.view;
    this.view = name;
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    const el = document.getElementById(`view-${name}`);
    el.classList.remove("hidden", "enter-left", "enter-right");
    if (changed) {
      // slide in from the side the tab lives on
      void el.offsetWidth; // restart the animation
      el.classList.add(toIdx > fromIdx ? "enter-right" : "enter-left");
    }
    document.querySelectorAll(".nav-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.view === name));
    document.getElementById("settings-btn").classList.toggle("active", name === "settings");
    // month navigation only affects dashboard + transactions
    document.getElementById("month-nav").style.visibility =
      (name === "dashboard" || name === "transactions" || name === "budgets") ? "visible" : "hidden";
    this.renderAll();
    window.scrollTo({ top: 0, behavior: "instant" });
  },

  bindMonthNav() {
    document.getElementById("month-prev").addEventListener("click", () => this.shiftMonth(-1));
    document.getElementById("month-next").addEventListener("click", () => this.shiftMonth(1));
    document.getElementById("month-label").addEventListener("click", () => {
      const n = new Date();
      this.month = { y: n.getFullYear(), m: n.getMonth() };
      this.renderAll();
    });
  },

  shiftMonth(delta) {
    const d = new Date(this.month.y, this.month.m + delta, 1);
    this.month = { y: d.getFullYear(), m: d.getMonth() };
    this.renderAll();
  },

  /* ================= computations ================= */
  monthTotals(ym) {
    let income = 0, expense = 0;
    for (const t of Store.txForMonth(ym)) {
      if (t.type === "income") income += t.amount;
      else expense += t.amount;
    }
    return { income, expense, net: income - expense };
  },

  upcomingRecurring() {
    // active recurring templates whose day hasn't arrived yet this month
    if (!this.isCurrentMonth()) return [];
    const today = new Date().getDate();
    const dim = daysInMonth(this.month.y, this.month.m);
    const curMonth = this.month.m + 1; // 1-12
    return Store.data.recurring
      .filter(r => r.active && Math.min(r.dayOfMonth, dim) > today && r.startMonth <= this.ymStr()
        // yearly templates are only "upcoming" during their anchor month
        && (r.frequency !== "yearly" || r.month === curMonth))
      .sort((a, b) => a.dayOfMonth - b.dayOfMonth);
  },

  spendingByCategory(ym) {
    const map = new Map();
    for (const t of Store.txForMonth(ym)) {
      if (t.type !== "expense") continue;
      map.set(t.category, (map.get(t.category) || 0) + t.amount);
    }
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  },

  /* ================= rendering ================= */
  renderAll() {
    document.getElementById("month-label").textContent = this.monthName(this.month.y, this.month.m);
    if (this.view === "dashboard") this.renderDashboard();
    if (this.view === "transactions") this.renderTransactions();
    if (this.view === "budgets") this.renderBudgets();
    if (this.view === "funds") this.renderFunds();
    if (this.view === "settings") this.renderSettings();
  },

  renderDashboard() {
    const ym = this.ymStr();
    const { income, expense, net } = this.monthTotals(ym);

    // hero: money left to spend = income so far + upcoming recurring income
    //       − expenses so far − upcoming recurring expenses
    const upcoming = this.upcomingRecurring();
    const upIn = upcoming.filter(r => r.type === "income").reduce((s, r) => s + r.amount, 0);
    const upEx = upcoming.filter(r => r.type === "expense").reduce((s, r) => s + r.amount, 0);
    const left = income + upIn - expense - upEx;

    const heroLabel = document.getElementById("hero-label");
    const heroValue = document.getElementById("hero-value");
    const heroSub = document.getElementById("hero-sub");
    if (this.isCurrentMonth()) {
      heroLabel.textContent = "Left to spend this month";
      this.countUp(heroValue, left);
      heroValue.classList.toggle("negative", left < 0);
      heroSub.textContent = upEx > 0
        ? `after ${this.fmtMoney(upEx)} of fixed payments still to come`
        : "all fixed payments for this month are in";
    } else {
      heroLabel.textContent = `Net result · ${this.monthName(this.month.y, this.month.m)}`;
      this.countUp(heroValue, net);
      heroValue.classList.toggle("negative", net < 0);
      heroSub.textContent = net >= 0 ? "you ended this month in the green" : "you spent more than you earned";
    }

    document.getElementById("tile-income").textContent = this.fmtMoney(income);
    document.getElementById("tile-expenses").textContent = this.fmtMoney(expense);
    const netEl = document.getElementById("tile-net");
    netEl.textContent = this.fmtMoney(net);
    netEl.style.color = net < 0 ? "var(--status-critical)" : "";

    this.renderCharts();
    this.renderInsights(ym, income, expense);
    this.renderUpcoming(upcoming);
  },

  // animate a money value counting up to its target
  countUp(el, target) {
    if (el._anim) cancelAnimationFrame(el._anim);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = this.fmtMoney(target);
      return;
    }
    const dur = 600, start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = this.fmtMoney(Math.round(target * eased));
      if (t < 1) el._anim = requestAnimationFrame(step);
    };
    el._anim = requestAnimationFrame(step);
  },

  // meters are rendered at width 0 (data-w holds the target) then grown
  growMeters(container) {
    const spans = container.querySelectorAll(".meter > span[data-w]");
    requestAnimationFrame(() => requestAnimationFrame(() =>
      spans.forEach(s => { s.style.width = s.dataset.w; })));
  },

  renderCharts(animate = true) {
    const ym = this.ymStr();

    /* donut — top 7 categories + "Other" fold */
    const cats = this.spendingByCategory(ym);
    const colors = Charts.seriesColors();
    let slices = cats.slice(0, 7).map((c, i) => ({ ...c, color: colors[i] }));
    if (cats.length > 7) {
      slices.push({
        label: "Other",
        value: cats.slice(7).reduce((s, c) => s + c.value, 0),
        color: colors[7]
      });
    }
    const total = slices.reduce((s, c) => s + c.value, 0);
    const donutCard = document.getElementById("donut-chart").closest(".chart-card");
    document.getElementById("donut-empty").classList.toggle("hidden", slices.length > 0);
    document.getElementById("donut-chart").parentElement.style.display = slices.length ? "" : "none";
    document.getElementById("donut-total").textContent = slices.length ? "" : "";
    if (slices.length) {
      Charts.drawDonut(document.getElementById("donut-chart"), slices, "Total spent", this.fmtMoneyShort(total), animate);
      const legend = document.getElementById("donut-legend");
      legend.innerHTML = slices.map(s => `
        <li data-cat="${escapeHtml(s.label)}" title="Show these transactions">
        <i class="swatch" style="background:${s.color}"></i>
        <span>${escapeHtml(s.label)}</span>
        <span class="val">${this.fmtMoney(s.value)}</span></li>`).join("");
      // tapping a legend row slides over to the activity list for that category
      legend.querySelectorAll("li").forEach(li => li.addEventListener("click", () => {
        if (li.dataset.cat === "Other") return;
        document.getElementById("tx-search").value = li.dataset.cat;
        document.getElementById("tx-filter-type").value = "expense";
        this.showView("transactions");
      }));
    }
    void donutCard;

    /* cash-flow bars — displayed month and 5 before it */
    const months = [];
    for (let back = 5; back >= 0; back--) {
      const d = new Date(this.month.y, this.month.m - back, 1);
      const t = this.monthTotals(ymKey(d.getFullYear(), d.getMonth()));
      months.push({ label: this.monthName(d.getFullYear(), d.getMonth(), true), income: t.income, expense: t.expense });
    }
    Charts.drawFlow(document.getElementById("flow-chart"), months, animate);
  },

  renderInsights(ym, income, expense) {
    const list = document.getElementById("insights-list");
    const items = [];

    // compare with previous month, same day-span
    const prev = new Date(this.month.y, this.month.m - 1, 1);
    const prevYm = ymKey(prev.getFullYear(), prev.getMonth());
    const dayCap = this.isCurrentMonth() ? new Date().getDate() : 31;
    const spentSoFar = Store.txForMonth(ym)
      .filter(t => t.type === "expense" && Number(t.date.slice(8)) <= dayCap)
      .reduce((s, t) => s + t.amount, 0);
    const prevSame = Store.txForMonth(prevYm)
      .filter(t => t.type === "expense" && Number(t.date.slice(8)) <= dayCap)
      .reduce((s, t) => s + t.amount, 0);
    if (prevSame > 0) {
      const diff = spentSoFar - prevSame;
      const pct = Math.abs(Math.round((diff / prevSame) * 100));
      items.push(diff <= 0
        ? `<li><span class="emoji">📉</span><span>You've spent <strong>${pct}% less</strong> than at this point last month (${this.fmtMoney(Math.abs(diff))} saved).</span></li>`
        : `<li><span class="emoji">📈</span><span>You've spent <strong>${pct}% more</strong> than at this point last month (${this.fmtMoney(diff)} extra).</span></li>`);
    }

    const cats = this.spendingByCategory(ym);
    if (cats.length) {
      const top = cats[0];
      const share = expense > 0 ? Math.round((top.value / expense) * 100) : 0;
      items.push(`<li><span class="emoji">🏷️</span><span>Biggest category: <strong>${escapeHtml(top.label)}</strong> — ${this.fmtMoney(top.value)} (${share}% of spending).</span></li>`);
    }

    const days = this.isCurrentMonth() ? new Date().getDate() : daysInMonth(this.month.y, this.month.m);
    if (expense > 0 && days > 0) {
      items.push(`<li><span class="emoji">📆</span><span>Average daily spend: <strong>${this.fmtMoney(Math.round(expense / days))}</strong>.</span></li>`);
    }

    const taxes = cats.find(c => c.label === "Taxes");
    if (taxes) {
      items.push(`<li><span class="emoji">🧾</span><span>Taxes this month: <strong>${this.fmtMoney(taxes.value)}</strong>.</span></li>`);
    }

    if (income > 0 && expense >= 0) {
      const rate = Math.round(((income - expense) / income) * 100);
      if (rate >= 0) items.push(`<li><span class="emoji">💰</span><span>You're keeping <strong>${rate}%</strong> of your income this month.</span></li>`);
    }

    list.innerHTML = items.length ? items.join("") :
      `<li><span class="emoji">✍️</span><span>Add a few transactions and insights will appear here.</span></li>`;
  },

  renderUpcoming(upcoming) {
    const listEl = document.getElementById("upcoming-list");
    document.getElementById("upcoming-empty").classList.toggle("hidden", upcoming.length > 0);
    const dim = daysInMonth(this.month.y, this.month.m);
    listEl.innerHTML = upcoming.map(r => `
      <li title="Manage in Settings">
        <div class="grow">
          ${escapeHtml(r.note || r.category)}
          <span class="sub">${escapeHtml(r.category)} · on the ${Math.min(r.dayOfMonth, dim)}${ord(Math.min(r.dayOfMonth, dim))}</span>
        </div>
        <span class="amt" style="color:${r.type === "income" ? "var(--delta-good)" : "inherit"}">
          ${r.type === "income" ? "+" : "−"}${this.fmtMoney(r.amount)}
        </span>
      </li>`).join("");
    // tapping an upcoming payment slides to Settings and scrolls to the recurring list
    listEl.querySelectorAll("li").forEach(li => li.addEventListener("click", () => {
      this.showView("settings");
      const card = document.getElementById("recurring-list").closest(".card");
      setTimeout(() => {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        card.classList.remove("flash");
        void card.offsetWidth;
        card.classList.add("flash");
      }, 330);
    }));
  },

  /* ================= transactions ================= */
  renderTransactions() {
    const ym = this.ymStr();
    const q = (document.getElementById("tx-search").value || "").toLowerCase();
    const typeF = document.getElementById("tx-filter-type").value;

    let txs = Store.txForMonth(ym);
    if (typeF) txs = txs.filter(t => t.type === typeF);
    if (q) txs = txs.filter(t =>
      (t.note || "").toLowerCase().includes(q) || t.category.toLowerCase().includes(q));

    txs.sort((a, b) => b.date.localeCompare(a.date));
    document.getElementById("tx-empty").classList.toggle("hidden", txs.length > 0);

    const catColor = this.categoryColorMap();
    const byDay = new Map();
    for (const t of txs) {
      if (!byDay.has(t.date)) byDay.set(t.date, []);
      byDay.get(t.date).push(t);
    }

    let html = "";
    for (const [date, dayTxs] of byDay) {
      const d = new Date(date + "T00:00:00");
      const dayTotal = dayTxs.reduce((s, t) => s + (t.type === "income" ? t.amount : -t.amount), 0);
      html += `<div class="tx-day"><div class="tx-day-head">
        <span>${d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}</span>
        <span>${dayTotal >= 0 ? "+" : "−"}${this.fmtMoney(Math.abs(dayTotal))}</span></div>`;
      for (const t of dayTxs) {
        const color = t.type === "income" ? "var(--cat-4)" : (catColor.get(t.category) || "var(--cat-8)");
        html += `
          <button class="tx-item" data-id="${t.id}">
            <span class="tx-cat-dot" style="background:${color}">${escapeHtml(t.category[0] || "?")}</span>
            <span class="tx-main">
              <span class="tx-title">${escapeHtml(t.note || t.category)}${t.recurringId ? '<span class="badge">fixed</span>' : ""}</span>
              <span class="tx-sub">${escapeHtml(t.category)}</span>
            </span>
            <span class="tx-amt ${t.type}">${t.type === "income" ? "+" : "−"}${this.fmtMoney(t.amount)}</span>
          </button>`;
      }
      html += `</div>`;
    }
    const listEl = document.getElementById("tx-list");
    listEl.innerHTML = html;
    listEl.querySelectorAll(".tx-item").forEach(el =>
      el.addEventListener("click", () => this.openTxModal(el.dataset.id)));
  },

  categoryColorMap() {
    // stable color per expense category: fixed order, never cycled beyond 8
    const colors = Charts.seriesColors();
    const map = new Map();
    Store.data.categories.expense.forEach((c, i) => map.set(c, colors[i % 8]));
    return map;
  },

  bindTxModal() {
    document.getElementById("tx-add-btn").addEventListener("click", () => this.openTxModal(null));
    const modal = document.getElementById("tx-modal");
    modal.addEventListener("click", e => {
      if (e.target === modal || e.target.closest("[data-close]")) this.closeModals();
    });
    document.querySelectorAll('input[name="tx-type"]').forEach(r =>
      r.addEventListener("change", () => this.fillTxCategories()));

    document.getElementById("tx-form").addEventListener("submit", e => {
      e.preventDefault();
      this.saveTx();
    });
    document.getElementById("tx-delete-btn").addEventListener("click", () => {
      if (this.editingTxId && confirm("Delete this transaction?")) {
        Store.deleteTransaction(this.editingTxId);
        this.closeModals();
        this.renderAll();
        this.toast("Transaction deleted");
      }
    });

    document.getElementById("tx-search").addEventListener("input", () => this.renderTransactions());
    document.getElementById("tx-filter-type").addEventListener("change", () => this.renderTransactions());
  },

  fillTxCategories(selected) {
    const type = document.querySelector('input[name="tx-type"]:checked').value;
    const sel = document.getElementById("tx-category");
    sel.innerHTML = Store.data.categories[type]
      .map(c => `<option value="${escapeHtml(c)}" ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`)
      .join("");
  },

  openTxModal(txId) {
    this.editingTxId = txId;
    const tx = txId ? Store.data.transactions.find(t => t.id === txId) : null;
    document.getElementById("tx-modal-title").textContent = tx ? "Edit transaction" : "Add transaction";
    document.getElementById("tx-delete-btn").classList.toggle("hidden", !tx);
    document.querySelector(`input[name="tx-type"][value="${tx ? tx.type : "expense"}"]`).checked = true;
    this.fillTxCategories(tx ? tx.category : undefined);
    document.getElementById("tx-amount").value = tx ? tx.amount : "";
    document.getElementById("tx-date").value = tx ? tx.date : todayStr();
    document.getElementById("tx-note").value = tx ? (tx.note || "") : "";
    const repEl = document.getElementById("tx-repeat");
    repEl.value = "none";
    repEl.disabled = !!tx; // recurrence is set when creating, managed in Settings
    document.getElementById("tx-repeat-field").style.opacity = tx ? 0.45 : 1;
    this.openModal("tx-modal");
    setTimeout(() => document.getElementById("tx-amount").focus(), 60);
  },

  saveTx() {
    const type = document.querySelector('input[name="tx-type"]:checked').value;
    const amount = parseFloat(document.getElementById("tx-amount").value);
    const category = document.getElementById("tx-category").value;
    const date = document.getElementById("tx-date").value;
    const note = document.getElementById("tx-note").value.trim();
    if (!(amount > 0) || !category || !date) return;

    if (this.editingTxId) {
      Store.updateTransaction(this.editingTxId, { type, amount, category, date, note });
      this.toast("Transaction updated");
    } else {
      const repeat = document.getElementById("tx-repeat").value; // none | monthly | yearly
      let recurringId;
      if (repeat !== "none") {
        const rec = Store.addRecurring({
          type, amount, category, note,
          frequency: repeat,
          dayOfMonth: Number(date.slice(8)),
          month: Number(date.slice(5, 7)), // anchor month (used by yearly)
          startMonth: date.slice(0, 7),
          lastApplied: date.slice(0, 7),
          active: true
        });
        recurringId = rec.id;
      }
      Store.addTransaction({ type, amount, category, date, note, recurringId });
      this.toast(repeat === "monthly" ? "Saved — will repeat monthly"
        : repeat === "yearly" ? "Saved — will repeat every year" : "Transaction saved");
    }
    this.closeModals();
    // jump the view to the month of the saved transaction
    const [y, m] = date.split("-").map(Number);
    this.month = { y, m: m - 1 };
    this.renderAll();
  },

  /* ================= budgets ================= */
  bindBudgets() {
    document.getElementById("budget-edit-btn").addEventListener("click", () => this.openBudgetModal());
    const modal = document.getElementById("budget-modal");
    modal.addEventListener("click", e => {
      if (e.target === modal || e.target.closest("[data-close]")) this.closeModals();
    });
    document.getElementById("budget-form").addEventListener("submit", e => {
      e.preventDefault();
      const budgets = {};
      modal.querySelectorAll("input[data-cat]").forEach(inp => {
        const v = parseFloat(inp.value);
        if (v > 0) budgets[inp.dataset.cat] = v;
      });
      Store.data.budgets = budgets;
      Store.save();
      this.closeModals();
      this.renderBudgets();
      this.toast("Budgets saved");
    });
  },

  openBudgetModal() {
    const wrap = document.getElementById("budget-form-fields");
    wrap.innerHTML = Store.data.categories.expense.map(c => `
      <label class="field">
        <span>${escapeHtml(c)}</span>
        <input type="number" min="0" step="1" inputmode="decimal" data-cat="${escapeHtml(c)}"
          value="${Store.data.budgets[c] || ""}" placeholder="No budget">
      </label>`).join("");
    this.openModal("budget-modal");
  },

  renderBudgets() {
    const ym = this.ymStr();
    const spent = new Map(this.spendingByCategory(ym).map(c => [c.label, c.value]));
    const entries = Object.entries(Store.data.budgets);
    document.getElementById("budget-empty").classList.toggle("hidden", entries.length > 0);

    document.getElementById("budget-list").innerHTML = entries.map(([cat, limit]) => {
      const used = spent.get(cat) || 0;
      const pct = Math.min(100, Math.round((used / limit) * 100));
      // status thresholds: <75% good, 75–100% warning, >100% critical
      const status = used > limit ? "critical" : (used >= limit * 0.75 ? "warning" : "good");
      const barColor = { good: "var(--status-good)", warning: "var(--status-warning)", critical: "var(--status-critical)" }[status];
      const icon = { good: "✓", warning: "⚠", critical: "✕" }[status];
      const msg = status === "critical"
        ? `Over budget by ${this.fmtMoney(used - limit)}`
        : `${this.fmtMoney(limit - used)} left`;
      return `
        <div class="budget-row">
          <div class="budget-top">
            <span class="name">${escapeHtml(cat)}</span>
            <span class="nums">${this.fmtMoney(used)} / ${this.fmtMoney(limit)}</span>
          </div>
          <div class="meter"><span style="width:0;background:${barColor}" data-w="${pct}%"></span></div>
          <div class="budget-status ${status}"><span aria-hidden="true">${icon}</span> ${msg} · ${pct}%</div>
        </div>`;
    }).join("");
    this.growMeters(document.getElementById("budget-list"));
  },

  /* ================= funds ================= */
  bindFunds() {
    document.getElementById("fund-add-btn").addEventListener("click", () => this.openFundModal(null));
    const modal = document.getElementById("fund-modal");
    modal.addEventListener("click", e => {
      if (e.target === modal || e.target.closest("[data-close]")) this.closeModals();
    });
    document.getElementById("fund-form").addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("fund-name").value.trim();
      const goal = parseFloat(document.getElementById("fund-goal").value) || 0;
      if (!name) return;
      if (this.editingFundId) {
        const f = Store.data.funds.find(f => f.id === this.editingFundId);
        Object.assign(f, { name, goal });
        Store.save();
      } else {
        Store.addFund({ name, goal });
      }
      this.closeModals();
      this.renderFunds();
      this.toast("Fund saved");
    });
    document.getElementById("fund-delete-btn").addEventListener("click", () => {
      const f = Store.data.funds.find(f => f.id === this.editingFundId);
      if (f && confirm(`Delete "${f.name}" and its history?`)) {
        Store.data.funds = Store.data.funds.filter(x => x.id !== f.id);
        Store.save();
        this.closeModals();
        this.renderFunds();
        this.toast("Fund deleted");
      }
    });

    const entryModal = document.getElementById("fund-entry-modal");
    entryModal.addEventListener("click", e => {
      if (e.target === entryModal || e.target.closest("[data-close]")) this.closeModals();
    });
    document.getElementById("fund-entry-form").addEventListener("submit", e => {
      e.preventDefault();
      const amount = parseFloat(document.getElementById("fund-entry-amount").value);
      if (!(amount > 0)) return;
      const fund = Store.data.funds.find(f => f.id === this.editingFundId);
      if (this.fundEntrySign < 0 && Store.fundBalance(fund) < amount) {
        this.toast("Not enough in the fund for that withdrawal");
        return;
      }
      fund.entries.push({
        id: Store.uid(),
        amount: amount * this.fundEntrySign,
        date: todayStr(),
        note: document.getElementById("fund-entry-note").value.trim()
      });
      Store.save();
      this.closeModals();
      this.renderFunds();
      this.toast(this.fundEntrySign > 0 ? "Deposit saved" : "Withdrawal saved");
    });
  },

  openFundModal(fundId) {
    this.editingFundId = fundId;
    const f = fundId ? Store.data.funds.find(f => f.id === fundId) : null;
    document.getElementById("fund-modal-title").textContent = f ? "Edit fund" : "New fund";
    document.getElementById("fund-delete-btn").classList.toggle("hidden", !f);
    document.getElementById("fund-name").value = f ? f.name : "";
    document.getElementById("fund-goal").value = f && f.goal ? f.goal : "";
    this.openModal("fund-modal");
  },

  openFundEntryModal(fundId, sign) {
    this.editingFundId = fundId;
    this.fundEntrySign = sign;
    document.getElementById("fund-entry-title").textContent = sign > 0 ? "Deposit" : "Withdraw";
    document.getElementById("fund-entry-amount").value = "";
    document.getElementById("fund-entry-note").value = "";
    this.openModal("fund-entry-modal");
    setTimeout(() => document.getElementById("fund-entry-amount").focus(), 60);
  },

  renderFunds() {
    const funds = Store.data.funds;
    document.getElementById("fund-empty").classList.toggle("hidden", funds.length > 0);
    const wrap = document.getElementById("fund-list");
    wrap.innerHTML = funds.map(f => {
      const bal = Store.fundBalance(f);
      const pct = f.goal > 0 ? Math.min(100, Math.round((bal / f.goal) * 100)) : null;
      return `
        <div class="fund" data-id="${f.id}">
          <div class="fund-top">
            <span class="fund-name">${escapeHtml(f.name)}</span>
            <span class="fund-balance">${this.fmtMoney(bal)}</span>
          </div>
          ${pct !== null ? `
            <div class="fund-goal-note">${pct}% of ${this.fmtMoney(f.goal)} goal</div>
            <div class="meter"><span style="width:0" data-w="${pct}%"></span></div>` : ""}
          <div class="fund-actions">
            <button class="btn small" data-act="deposit">Deposit</button>
            <button class="btn small" data-act="withdraw">Withdraw</button>
            <span class="spacer" style="flex:1"></span>
            <button class="btn small subtle" data-act="edit">Edit</button>
          </div>
        </div>`;
    }).join("");

    wrap.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".fund").dataset.id;
        if (btn.dataset.act === "deposit") this.openFundEntryModal(id, 1);
        if (btn.dataset.act === "withdraw") this.openFundEntryModal(id, -1);
        if (btn.dataset.act === "edit") this.openFundModal(id);
      });
    });
    this.growMeters(wrap);
  },

  /* ================= settings ================= */
  bindSettings() {
    document.getElementById("set-currency").addEventListener("change", e => {
      Store.data.settings.currency = e.target.value;
      Store.save();
      this.renderAll();
    });

    document.getElementById("set-bankid").addEventListener("change", e => {
      Store.data.settings.bankId = e.target.value.trim().slice(0, 30);
      Store.save();
      this.updateChip();
      this.toast("Bank identifier updated");
    });

    document.getElementById("cat-add-btn").addEventListener("click", () => {
      const name = document.getElementById("cat-new-name").value.trim();
      const type = document.getElementById("cat-new-type").value;
      if (!name) return;
      if (!Store.data.categories[type].includes(name)) {
        Store.data.categories[type].push(name);
        Store.save();
      }
      document.getElementById("cat-new-name").value = "";
      this.renderSettings();
    });

    document.getElementById("export-btn").addEventListener("click", () => {
      const blob = new Blob([Store.exportJSON()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `moneyflow-backup-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.toast("Backup downloaded");
    });

    document.getElementById("import-btn").addEventListener("click", () =>
      document.getElementById("import-file").click());
    document.getElementById("import-file").addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        Store.importJSON(await file.text());
        this.renderAll();
        this.toast("Backup imported");
      } catch {
        this.toast("That file isn't a valid MoneyFlow backup");
      }
      e.target.value = "";
    });

    document.getElementById("demo-btn").addEventListener("click", () => {
      if (Store.data.transactions.length === 0 || confirm("Replace your current data with demo data?")) {
        Store.loadDemo();
        const n = new Date();
        this.month = { y: n.getFullYear(), m: n.getMonth() };
        this.showView("dashboard");
        this.toast("Demo data loaded");
      }
    });

    document.getElementById("wipe-btn").addEventListener("click", () => {
      if (confirm("Erase ALL data? This cannot be undone. Consider exporting a backup first.")) {
        Store.wipe();
        this.renderAll();
        this.toast("All data erased");
      }
    });

    document.getElementById("reset-money-btn").addEventListener("click", () => {
      if (confirm("Reset all balances? This deletes every transaction and sets all funds to zero. Your categories, budgets, funds and recurring payments are kept. This cannot be undone — consider exporting a backup first.")) {
        Store.resetBalances();
        const n = new Date();
        this.month = { y: n.getFullYear(), m: n.getMonth() };
        this.renderAll();
        this.toast("Balances reset to zero");
      }
    });
  },

  renderSettings() {
    document.getElementById("set-currency").value = this.currency();
    document.getElementById("set-bankid").value = Store.data.settings.bankId || "";

    /* recurring list */
    const recs = Store.data.recurring.filter(r => r.active);
    document.getElementById("recurring-empty").classList.toggle("hidden", recs.length > 0);
    const recList = document.getElementById("recurring-list");
    recList.innerHTML = recs.map(r => `
      <li data-id="${r.id}">
        <div class="grow">
          ${escapeHtml(r.note || r.category)}
          <span class="sub">${escapeHtml(r.category)} · ${r.frequency === "yearly"
            ? `every year on ${this.monthDayLabel(r.month, r.dayOfMonth)}`
            : `every month on the ${r.dayOfMonth}${ord(r.dayOfMonth)}`}</span>
        </div>
        <span class="amt" style="color:${r.type === "income" ? "var(--delta-good)" : "inherit"}">
          ${r.type === "income" ? "+" : "−"}${this.fmtMoney(r.amount)}
        </span>
        <button class="icon-btn" data-del aria-label="Stop this recurring transaction">✕</button>
      </li>`).join("");
    recList.querySelectorAll("[data-del]").forEach(btn =>
      btn.addEventListener("click", () => {
        const li = btn.closest("li");
        if (confirm("Stop this recurring transaction? Past entries stay.")) {
          Store.deleteRecurring(li.dataset.id);
          this.renderSettings();
        }
      }));

    /* categories */
    const catList = document.getElementById("cat-list");
    const chip = (c, type) => `
      <span class="chip">${escapeHtml(c)}
        <button class="x" data-type="${type}" data-cat="${escapeHtml(c)}" aria-label="Remove category ${escapeHtml(c)}">✕</button>
      </span>`;
    catList.innerHTML =
      Store.data.categories.expense.map(c => chip(c, "expense")).join("") +
      Store.data.categories.income.map(c => chip(c, "income")).join("");
    catList.querySelectorAll(".x").forEach(btn =>
      btn.addEventListener("click", () => {
        const { type, cat } = btn.dataset;
        const inUse = Store.data.transactions.some(t => t.category === cat);
        if (inUse) { this.toast("Category is used by existing transactions"); return; }
        Store.data.categories[type] = Store.data.categories[type].filter(c => c !== cat);
        delete Store.data.budgets[cat];
        Store.save();
        this.renderSettings();
      }));
  },

  /* ================= misc ================= */
  openModal(id) {
    const m = document.getElementById(id);
    m.classList.remove("closing", "hidden");
  },

  closeModals() {
    // play the slide-down/fade-out before actually hiding
    document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach(m => {
      m.classList.add("closing");
      setTimeout(() => m.classList.add("hidden"), 230);
    });
    this.editingTxId = null;
  },

  toastTimer: null,
  toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
  }
};

function ord(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

document.addEventListener("DOMContentLoaded", () => App.init());
