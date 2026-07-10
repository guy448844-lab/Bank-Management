/* ============================================================
   MoneyFlow — data layer.
   Everything lives in localStorage under one key. No network,
   no accounts, no bank connections — by design.
   ============================================================ */

const STORE_KEY = "moneyflow.v1";

const DEFAULT_DATA = () => ({
  settings: { currency: "₪" },
  categories: {
    expense: ["Groceries", "Rent & Home", "Transport", "Eating Out", "Bills & Utilities",
              "Health", "Shopping", "Leisure", "Taxes", "Other"],
    income: ["Salary", "Freelance", "Investments", "Gifts", "Other"]
  },
  transactions: [],   // {id, type, amount, category, date:"YYYY-MM-DD", note, recurringId?}
  recurring: [],      // {id, type, amount, category, note, dayOfMonth, startMonth:"YYYY-MM", lastApplied:"YYYY-MM"|null, active}
  budgets: {},        // {category: monthlyLimit}
  funds: []           // {id, name, goal, entries:[{id, amount, date, note}]}
});

const Store = {
  data: null,

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      this.data = raw ? Object.assign(DEFAULT_DATA(), JSON.parse(raw)) : DEFAULT_DATA();
    } catch {
      this.data = DEFAULT_DATA();
    }
    this.materializeRecurring();
    return this.data;
  },

  save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
  },

  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /* ---- recurring: create the concrete transaction for every month
     from the template's start month up to the current month ---- */
  materializeRecurring() {
    const now = new Date();
    const curYm = ymKey(now.getFullYear(), now.getMonth());
    let changed = false;

    for (const r of this.data.recurring) {
      if (!r.active) continue;
      let ym = r.lastApplied ? nextYm(r.lastApplied) : r.startMonth;
      while (ym && ym <= curYm) {
        const [y, m] = ym.split("-").map(Number);
        const day = Math.min(r.dayOfMonth, daysInMonth(y, m - 1));
        const date = `${ym}-${String(day).padStart(2, "0")}`;
        // only materialize once the day has arrived
        if (date > todayStr()) break;
        this.data.transactions.push({
          id: this.uid(), type: r.type, amount: r.amount, category: r.category,
          date, note: r.note, recurringId: r.id
        });
        r.lastApplied = ym;
        changed = true;
        ym = nextYm(ym);
      }
    }
    if (changed) this.save();
  },

  addTransaction(tx) {
    tx.id = this.uid();
    this.data.transactions.push(tx);
    this.save();
    return tx;
  },

  updateTransaction(id, patch) {
    const tx = this.data.transactions.find(t => t.id === id);
    if (tx) { Object.assign(tx, patch); this.save(); }
    return tx;
  },

  deleteTransaction(id) {
    this.data.transactions = this.data.transactions.filter(t => t.id !== id);
    this.save();
  },

  addRecurring(r) {
    r.id = this.uid();
    this.data.recurring.push(r);
    this.save();
    return r;
  },

  deleteRecurring(id) {
    this.data.recurring = this.data.recurring.filter(r => r.id !== id);
    this.save();
  },

  addFund(fund) {
    fund.id = this.uid();
    fund.entries = [];
    this.data.funds.push(fund);
    this.save();
    return fund;
  },

  fundBalance(fund) {
    return fund.entries.reduce((s, e) => s + e.amount, 0);
  },

  txForMonth(ym) {
    return this.data.transactions.filter(t => t.date.startsWith(ym));
  },

  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  },

  importJSON(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.transactions)) {
      throw new Error("Not a MoneyFlow backup file");
    }
    this.data = Object.assign(DEFAULT_DATA(), parsed);
    this.save();
  },

  wipe() {
    this.data = DEFAULT_DATA();
    this.save();
  },

  /* ---- demo data so a new user can explore the app ---- */
  loadDemo() {
    const d = DEFAULT_DATA();
    const now = new Date();
    const rnd = mulberry32(42);
    const pick = arr => arr[Math.floor(rnd() * arr.length)];

    const salaryDay = 10, rentDay = 3;
    for (let back = 5; back >= 0; back--) {
      const dt = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const y = dt.getFullYear(), m = dt.getMonth();
      const ym = ymKey(y, m);
      const push = (type, amount, category, day, note) => {
        const date = `${ym}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
        if (date > todayStr()) return;
        d.transactions.push({ id: ym + category + day + Math.floor(rnd() * 1e6), type, amount, category, date, note });
      };

      push("income", 12500, "Salary", salaryDay, "Monthly salary");
      if (rnd() > 0.55) push("income", Math.round(800 + rnd() * 1800), "Freelance", 18 + Math.floor(rnd() * 8), "Side project");
      push("expense", 4200, "Rent & Home", rentDay, "Rent");
      push("expense", Math.round(380 + rnd() * 160), "Bills & Utilities", 15, "Electricity & water");
      push("expense", Math.round(1500 + rnd() * 700), "Taxes", 20, "Income tax advance");

      const daysSoFar = back === 0 ? now.getDate() : daysInMonth(y, m);
      const nVar = 8 + Math.floor(rnd() * 6);
      for (let i = 0; i < nVar; i++) {
        const cat = pick(["Groceries", "Groceries", "Transport", "Eating Out", "Eating Out", "Health", "Shopping", "Leisure"]);
        const base = { "Groceries": 220, "Transport": 60, "Eating Out": 110, "Health": 150, "Shopping": 260, "Leisure": 140 }[cat];
        push("expense", Math.round(base * (0.5 + rnd())), cat, 1 + Math.floor(rnd() * daysSoFar),
          pick(["", "", "with family", "weekend", "online order", ""]));
      }
    }

    d.recurring = [
      { id: "rec-salary", type: "income", amount: 12500, category: "Salary", note: "Monthly salary", dayOfMonth: salaryDay, startMonth: ymKey(now.getFullYear(), now.getMonth()), lastApplied: ymKey(now.getFullYear(), now.getMonth()), active: true },
      { id: "rec-rent", type: "expense", amount: 4200, category: "Rent & Home", note: "Rent", dayOfMonth: rentDay, startMonth: ymKey(now.getFullYear(), now.getMonth()), lastApplied: ymKey(now.getFullYear(), now.getMonth()), active: true },
      { id: "rec-gym", type: "expense", amount: 189, category: "Health", note: "Gym membership", dayOfMonth: 27, startMonth: ymKey(now.getFullYear(), now.getMonth()), lastApplied: null, active: true },
      { id: "rec-stream", type: "expense", amount: 55, category: "Leisure", note: "Streaming subscription", dayOfMonth: 25, startMonth: ymKey(now.getFullYear(), now.getMonth()), lastApplied: null, active: true }
    ];

    d.budgets = {
      "Groceries": 2200, "Eating Out": 900, "Transport": 500,
      "Shopping": 800, "Leisure": 600
    };

    d.funds = [
      {
        id: "fund-emergency", name: "Emergency cushion", goal: 30000,
        entries: [
          { id: "fe1", amount: 12000, date: addMonthsStr(-4), note: "Opening deposit" },
          { id: "fe2", amount: 2500, date: addMonthsStr(-2), note: "Monthly saving" },
          { id: "fe3", amount: 2500, date: addMonthsStr(-1), note: "Monthly saving" }
        ]
      },
      {
        id: "fund-trust", name: "Kids' trust fund", goal: 50000,
        entries: [
          { id: "ft1", amount: 6000, date: addMonthsStr(-5), note: "Opening deposit" },
          { id: "ft2", amount: 1000, date: addMonthsStr(-3), note: "" },
          { id: "ft3", amount: 1000, date: addMonthsStr(-1), note: "" }
        ]
      }
    ];

    this.data = d;
    this.save();
  }
};

/* ---------- date helpers ---------- */
function ymKey(year, monthIdx) {
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
}
function nextYm(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function addMonthsStr(delta) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() + delta, Math.min(n.getDate(), 28));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* deterministic PRNG so demo data is stable */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
