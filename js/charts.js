/* ============================================================
   MoneyFlow — canvas charts.
   Donut (spending by category) and grouped bars (cash flow).
   Colors are read from CSS custom properties so light/dark
   mode swap in one place. Both charts ship hover tooltips.
   ============================================================ */

const Charts = {
  cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },

  seriesColors() {
    return [1, 2, 3, 4, 5, 6, 7, 8].map(i => this.cssVar(`--cat-${i}`));
  },

  setupCanvas(canvas, cssWidth, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    return ctx;
  },

  // drive frame(progress 0→1) with ease-out; cancels any prior run on the canvas
  animateDraw(canvas, duration, animate, frame) {
    if (canvas._anim) cancelAnimationFrame(canvas._anim);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduced) { frame(1); return; }
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      frame(1 - Math.pow(1 - t, 3));
      if (t < 1) canvas._anim = requestAnimationFrame(step);
    };
    canvas._anim = requestAnimationFrame(step);
  },

  /* ---------------- donut ---------------- */
  // slices: [{label, value, color}] — already sorted, ≤8 (rest folded to "Other")
  drawDonut(canvas, slices, centerLabel, centerValue, animate = true) {
    const size = 220;
    const ctx = this.setupCanvas(canvas, size, size);
    const cx = size / 2, cy = size / 2;
    const rOuter = 92, rInner = 62;
    const total = slices.reduce((s, d) => s + d.value, 0);
    const surface = this.cssVar("--surface-1");
    const startA = -Math.PI / 2;

    // final segment geometry (hover hit-testing always uses this)
    let angle = startA;
    const hitArcs = [];
    for (const s of slices) {
      const sweep = total > 0 ? (s.value / total) * Math.PI * 2 : 0;
      hitArcs.push({ from: angle, to: angle + sweep, slice: s });
      angle += sweep;
    }

    const render = p => {
      ctx.clearRect(0, 0, size, size);
      const limit = startA + p * Math.PI * 2; // clockwise wipe
      for (const h of hitArcs) {
        const to = Math.min(h.to, limit);
        if (to <= h.from) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, rOuter, h.from, to);
        ctx.arc(cx, cy, rInner, to, h.from, true);
        ctx.closePath();
        ctx.fillStyle = h.slice.color;
        ctx.fill();
        // 2px surface spacer between segments
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // center text — ink tokens, never series color
      ctx.textAlign = "center";
      ctx.fillStyle = this.cssVar("--text-muted");
      ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillText(centerLabel, cx, cy - 8);
      ctx.fillStyle = this.cssVar("--text-primary");
      ctx.font = "650 17px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillText(centerValue, cx, cy + 12);
    };
    this.animateDraw(canvas, 550, animate, render);

    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - cx, y = e.clientY - rect.top - cy;
      const r = Math.hypot(x, y);
      let hit = null;
      if (r >= rInner && r <= rOuter) {
        let a = Math.atan2(y, x);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        hit = hitArcs.find(h => a >= h.from && a < h.to);
      }
      if (hit) {
        const pct = total > 0 ? Math.round((hit.slice.value / total) * 100) : 0;
        Tooltip.show(e.clientX, e.clientY,
          `<div class="tt-title">${escapeHtml(hit.slice.label)}</div>
           <div class="tt-row">${App.fmtMoney(hit.slice.value)} · ${pct}% of spending</div>`);
      } else {
        Tooltip.hide();
      }
    };
    canvas.onmouseleave = () => Tooltip.hide();
  },

  /* ---------------- grouped bars ---------------- */
  // months: [{label, income, expense}]
  drawFlow(canvas, months, animate = true) {
    const cssWidth = canvas.parentElement.clientWidth || 320;
    const cssHeight = 180;
    const ctx = this.setupCanvas(canvas, cssWidth, cssHeight);

    const padL = 8, padR = 8, padTop = 14, padBottom = 22;
    const plotW = cssWidth - padL - padR;
    const plotH = cssHeight - padTop - padBottom;
    const baseY = padTop + plotH;

    const maxVal = Math.max(1, ...months.flatMap(m => [m.income, m.expense]));
    const scale = v => (v / maxVal) * plotH;

    const groupW = plotW / months.length;
    const barW = Math.min(22, Math.max(8, groupW * 0.24));
    const gap = 2; // surface gap between adjacent bars

    const incomeC = this.cssVar("--series-income");
    const expenseC = this.cssVar("--series-expense");
    const hitRects = [];

    // final geometry for hover hit-testing
    months.forEach((m, i) => {
      const cxg = padL + groupW * i + groupW / 2;
      const put = (x, val, name, color) => {
        const h = Math.max(val > 0 ? 2 : 0, scale(val));
        hitRects.push({ x, y: baseY - Math.max(h, 14), w: barW, h: Math.max(h, 14), month: m, name, val, color, barH: h });
      };
      put(cxg - barW - gap / 2, m.income, "Income", incomeC);
      put(cxg + gap / 2, m.expense, "Expenses", expenseC);
    });

    const render = p => {
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      // hairline baseline
      ctx.strokeStyle = this.cssVar("--baseline");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, baseY + 0.5);
      ctx.lineTo(cssWidth - padR, baseY + 0.5);
      ctx.stroke();

      // bars grow up from the baseline
      for (const r of hitRects) {
        const h = r.barH * p;
        if (h <= 0) continue;
        roundedTopRect(ctx, r.x, baseY - h, barW, h, 4);
        ctx.fillStyle = r.color;
        ctx.fill();
      }

      ctx.textAlign = "center";
      ctx.fillStyle = this.cssVar("--text-muted");
      ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
      months.forEach((m, i) => {
        ctx.fillText(m.label, padL + groupW * i + groupW / 2, cssHeight - 6);
      });

      // direct label on the latest month only (selective labeling)
      const last = months[months.length - 1];
      if (p === 1 && last && (last.income > 0 || last.expense > 0)) {
        const cxg = padL + groupW * (months.length - 1) + groupW / 2;
        ctx.fillStyle = this.cssVar("--text-secondary");
        ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
        const topVal = Math.max(last.income, last.expense);
        ctx.fillText(App.fmtMoneyShort(topVal), cxg, baseY - scale(topVal) - 5);
      }
    };
    this.animateDraw(canvas, 550, animate, render);

    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const hit = hitRects.find(r => x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y - 4 && y <= r.y + r.h + 4);
      if (hit) {
        Tooltip.show(e.clientX, e.clientY,
          `<div class="tt-title">${escapeHtml(hit.month.label)} · ${hit.name}</div>
           <div class="tt-row">${App.fmtMoney(hit.val)}</div>`);
      } else {
        Tooltip.hide();
      }
    };
    canvas.onmouseleave = () => Tooltip.hide();
  }
};

function roundedTopRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

const Tooltip = {
  el: null,
  show(clientX, clientY, html) {
    if (!this.el) this.el = document.getElementById("chart-tooltip");
    this.el.innerHTML = html;
    this.el.classList.remove("hidden");
    const pad = 12;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let x = clientX + pad, y = clientY - h - pad;
    if (x + w > window.innerWidth - 8) x = clientX - w - pad;
    if (y < 8) y = clientY + pad;
    this.el.style.left = x + "px";
    this.el.style.top = y + "px";
  },
  hide() {
    if (this.el) this.el.classList.add("hidden");
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
