/* Credit Ledger – script.js
   Author: Abhishek Grover · github.com/AbhishekGrover1 */
(() => {
  "use strict";

  // ── constants ──────────────────────────────────────────────────
  const CIRC   = 540.35;   // 2π × 86  (SVG gauge circumference)
  const HEALTH_RETRY_DELAYS = [2000, 4000, 8000, 16000]; // exponential back-off

  // ── element refs ───────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const form        = $("riskForm");
  const submitBtn   = $("submitBtn");
  const submitLabel = $("submitLabel");
  const errorEl     = $("error");
  const verdict     = $("verdict");
  const incomeEl    = $("person_income");
  const amountEl    = $("loan_amnt");
  const shareEl     = $("loan_percent_income");
  const statusDot   = $("statusDot");
  const statusText  = $("statusText");
  const gaugeFill   = $("gaugeFill");
  const gaugeMark   = $("gaugeMark");
  const probNumber  = $("probNumber");
  const verdictResult = $("verdictResult");

  // ── environment flags ──────────────────────────────────────────
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer  = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // ─────────────────────────────────────────────────────────────
  //  SEGMENTED RADIO KEYS
  //  Builds accessible radio-group buttons with arrow-key nav.
  // ─────────────────────────────────────────────────────────────
  function buildKeys(container, options, initial) {
    let current = initial;

    const buttons = options.map(([val, label]) => {
      const btn = document.createElement("button");
      btn.type      = "button";
      btn.className = "key";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.tabIndex  = -1;
      btn.dataset.value = val;
      btn.textContent   = label;
      btn.addEventListener("click", () => select(val, true));
      container.appendChild(btn);
      return btn;
    });

    function select(val, moveFocus) {
      current = val;
      buttons.forEach((btn) => {
        const active = btn.dataset.value === val;
        btn.setAttribute("aria-checked", String(active));
        btn.tabIndex = active ? 0 : -1;
        if (active && moveFocus) btn.focus();
      });
    }

    container.addEventListener("keydown", (e) => {
      const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (delta === undefined) return;
      e.preventDefault();
      const idx  = buttons.findIndex((btn) => btn.dataset.value === current);
      const next = (idx + delta + buttons.length) % buttons.length;
      select(buttons[next].dataset.value, true);
    });

    select(initial, false);
    return { get value() { return current; } };
  }

  const grade        = buildKeys($("gradeKeys"), "ABCDEFG".split("").map((g) => [g, g]), "C");
  const priorDefault = buildKeys($("defaultKeys"), [["N", "No"], ["Y", "Yes"]], "N");

  // ─────────────────────────────────────────────────────────────
  //  LOAN-TO-INCOME RATIO  (auto-computed)
  // ─────────────────────────────────────────────────────────────
  function loanShare() {
    const inc = parseFloat(incomeEl.value);
    const amt = parseFloat(amountEl.value);
    return inc > 0 && amt > 0 ? amt / inc : 0;
  }
  function refreshShare() {
    const pct = loanShare() * 100;
    shareEl.textContent = `${pct.toFixed(0)}%`;
  }
  incomeEl.addEventListener("input", refreshShare);
  amountEl.addEventListener("input", refreshShare);
  refreshShare();

  // ─────────────────────────────────────────────────────────────
  //  POINTER EFFECTS
  //  Surface spotlight: --mx/--my follow the cursor within each card.
  //  Key tilt: 3-D rotateX/Y on fine-pointer devices only.
  // ─────────────────────────────────────────────────────────────
  document.querySelectorAll(".surface").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const { left, top } = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - left}px`);
      el.style.setProperty("--my", `${e.clientY - top}px`);
    });
    el.addEventListener("pointerleave", () => {
      el.style.setProperty("--mx", "50%");
      el.style.setProperty("--my", "50%");
    });
  });

  if (finePointer && !reduceMotion) {
    // Tilt toward cursor
    document.addEventListener("pointermove", (e) => {
      const key = e.target.closest?.(".key");
      if (!key || key.disabled) return;
      const { left, top, width, height } = key.getBoundingClientRect();
      const px = (e.clientX - left) / width  - 0.5;   // -0.5 … 0.5
      const py = (e.clientY - top)  / height - 0.5;
      const max = key.classList.contains("key--primary") ? 9 : 16;
      key.style.setProperty("--ry",  `${( px * max).toFixed(2)}deg`);
      key.style.setProperty("--rx",  `${(-py * max).toFixed(2)}deg`);
      key.style.setProperty("--kx",  `${((px + 0.5) * 100).toFixed(1)}%`);
      key.style.setProperty("--ky",  `${((py + 0.5) * 100).toFixed(1)}%`);
    });

    // Reset tilt only when pointer truly leaves the button
    document.addEventListener("pointerout", (e) => {
      const key = e.target.closest?.(".key");
      if (!key) return;
      // e.relatedTarget is the element the pointer moved INTO
      if (key.contains(e.relatedTarget)) return;
      key.style.setProperty("--rx", "0deg");
      key.style.setProperty("--ry", "0deg");
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  SERVICE STATUS  (exponential back-off retry)
  // ─────────────────────────────────────────────────────────────
  async function checkHealth(attempt = 0) {
    if (attempt > 0) statusText.textContent = "Waking up…";
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      statusDot.className = "status__dot ok";
      statusText.textContent = "Model ready";
    } catch {
      const delay = HEALTH_RETRY_DELAYS[attempt];
      if (delay !== undefined) {
        setTimeout(() => checkHealth(attempt + 1), delay);
      } else {
        statusDot.className = "status__dot down";
        statusText.textContent = "Offline";
      }
    }
  }
  checkHealth();

  // ─────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────
  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle("is-loading", on);
    submitLabel.textContent = on ? "Assessing…" : "Assess risk";
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function parseApiError(body, status) {
    if (body && Array.isArray(body.detail)) {
      return body.detail
        .map((d) => {
          const field = (d.loc || []).slice(1).join(" ").replace(/_/g, " ");
          const msg   = String(d.msg || "").replace(/^Value error,\s*/i, "");
          return field && !/^[A-Z]/.test(msg) ? `${field}: ${msg}` : msg;
        })
        .join("  ·  ");
    }
    if (body?.detail) return String(body.detail);
    return `Request failed (HTTP ${status}).`;
  }

  // Smooth numeric count-up using an ease-out cubic
  function countUp(el, targetVal, durationMs) {
    if (reduceMotion) { el.textContent = targetVal.toFixed(1); return; }
    const start = performance.now();
    function tick(now) {
      const t       = Math.min(1, (now - start) / durationMs);
      const eased   = 1 - Math.pow(1 - t, 3);
      el.textContent = (targetVal * eased).toFixed(1);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = targetVal.toFixed(1);
    }
    requestAnimationFrame(tick);
  }

  // ─────────────────────────────────────────────────────────────
  //  RENDER RESULT
  // ─────────────────────────────────────────────────────────────
  function renderVerdict(data) {
    const probPct = data.default_probability * 100;
    const thrPct  = data.threshold * 100;
    const isHigh  = data.default_prediction === 1;

    // Show panel
    verdict.hidden = false;
    verdict.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });

    // --- gauge fill ---
    // Remove both classes, then re-add the right one; force reflow so the
    // dashoffset transition fires properly on repeated submissions.
    gaugeFill.classList.remove("is-low", "is-high");
    gaugeFill.style.transition = "none";
    gaugeFill.style.strokeDashoffset = String(CIRC);
    // Two rAF frames to let the browser reset before re-enabling transition
    requestAnimationFrame(() => requestAnimationFrame(() => {
      gaugeFill.style.transition = "";
      gaugeFill.classList.add(isHigh ? "is-high" : "is-low");
      const target = CIRC * (1 - Math.min(probPct, 100) / 100);
      gaugeFill.style.strokeDashoffset = String(target);
    }));

    // threshold marker tick
    gaugeMark.style.transform = `rotate(${(thrPct * 3.6).toFixed(2)}deg)`;

    // animated counter
    countUp(probNumber, probPct, 960);

    // verdict label
    verdictResult.className = `verdict__result ${isHigh ? "is-high" : "is-low"}`;
    verdictResult.textContent = isHigh ? "High risk" : "Low risk";

    // fact rows
    $("factProb").textContent     = `${probPct.toFixed(1)}%`;
    $("factThreshold").textContent = `${thrPct.toFixed(1)}%`;
    $("factDecision").textContent  = isHigh ? "Likely to default" : "Likely to repay";
  }

  // ─────────────────────────────────────────────────────────────
  //  SUBMIT
  // ─────────────────────────────────────────────────────────────
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    // Quick client-side sanity check before hitting the server
    const numFields = [
      "person_age", "person_income", "person_emp_length",
      "loan_amnt",  "loan_int_rate", "cb_person_cred_hist_length",
    ];
    const badField = numFields.find((id) => Number.isNaN(parseFloat($(id).value)));
    if (badField) {
      showError(`Please fill in: ${badField.replace(/_/g, " ")}`);
      return;
    }

    const payload = {
      person_age:               parseInt($(          "person_age").value, 10),
      person_income:            parseFloat(incomeEl.value),
      person_home_ownership:    $("person_home_ownership").value,
      person_emp_length:        parseFloat($("person_emp_length").value),
      loan_intent:              $("loan_intent").value,
      loan_grade:               grade.value,
      loan_amnt:                parseFloat(amountEl.value),
      loan_int_rate:            parseFloat($("loan_int_rate").value),
      loan_percent_income:      parseFloat(loanShare().toFixed(4)),
      cb_person_default_on_file: priorDefault.value,
      cb_person_cred_hist_length: parseInt($("cb_person_cred_hist_length").value, 10),
    };

    setLoading(true);
    try {
      const res  = await fetch("/predict", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(parseApiError(body, res.status));
      renderVerdict(body);
    } catch (err) {
      showError(
        err instanceof TypeError
          ? "Can't reach the service — please try again in a moment."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  });
})();
