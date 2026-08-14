/**
 * 閒置登出守衛（影像上傳入口與電子病歷交換平台共用）。
 *
 * 規則：
 *   - 有操作就重新計時，閒置滿 20 分鐘才登出（不是登入後固定 20 分鐘）。
 *   - 閒置滿 18 分鐘跳出「是否要延長登入時間」，倒數 2 分鐘。
 *   - 警示跳出後，滑鼠鍵盤動作不會自動延長，一定要按按鈕，避免無人看顧的電腦被誤觸而續命。
 *
 * 兩個前端共用 localStorage 的 tokenSet.authenticated_until，
 * 所以在任一分頁操作都會一起延長，任一分頁登出也會一起結束。
 */
(function (global) {
  const STORAGE_KEY = "tokenSet";
  const DEFAULTS = {
    idleMs: 20 * 60 * 1000,   // 閒置多久登出
    warnMs: 2 * 60 * 1000,    // 登出前多久跳警示（20 - 2 = 第 18 分鐘）
    writeThrottleMs: 5000,    // 避免每次滑鼠移動都寫 localStorage
    refreshLeadMs: 60 * 1000, // access token 剩多久時先在背景換新的
  };

  let cfg = null;
  let ticker = null;
  let dialog = null;
  let lastWrite = 0;
  let warning = false;
  let refreshing = false;

  function readSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function hasSession() {
    const s = readSession();
    return !!(s && s.access_token);
  }

  function deadline() {
    return readSession()?.authenticated_until || 0;
  }

  function setDeadline(until) {
    const session = readSession();
    if (!session) return;
    session.authenticated_until = until;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    if (cfg?.onTouch) cfg.onTouch(until);
  }

  function touch(force = false) {
    if (warning && !force) return;      // 警示中只認按鈕
    if (!hasSession()) return;
    const now = Date.now();
    if (!force && now - lastWrite < cfg.writeThrottleMs) return;
    lastWrite = now;
    setDeadline(now + cfg.idleMs);
  }

  /* ---------------- 警示對話框 ---------------- */

  function injectStyles() {
    if (document.getElementById("sg-styles")) return;
    const style = document.createElement("style");
    style.id = "sg-styles";
    style.textContent = `
      .sg-backdrop {
        position: fixed; inset: 0; z-index: 2147483000;
        display: grid; place-items: center; padding: 20px;
        background: rgba(8, 20, 36, .62);
        font-family: system-ui, -apple-system, "Segoe UI", "PingFang TC",
                     "Noto Sans TC", "Microsoft JhengHei", sans-serif;
      }
      .sg-card {
        width: min(430px, 100%); padding: 26px 26px 20px; text-align: center;
        background: #fff; color: #16202e; border-radius: 12px;
        box-shadow: 0 20px 54px rgba(6, 20, 40, .38);
      }
      .sg-icon {
        width: 50px; height: 50px; margin: 0 auto 14px;
        display: grid; place-items: center; border-radius: 50%;
        background: #fdf1de; color: #b26a00; font-size: 24px;
      }
      .sg-card h2 { margin: 0 0 8px; font-size: 18px; letter-spacing: .02em; }
      .sg-card p { margin: 0 0 6px; font-size: 14px; line-height: 1.6; color: #47566b; }
      .sg-count { font-size: 30px; font-weight: 700; color: #c62828; font-variant-numeric: tabular-nums; margin: 10px 0 16px; }
      .sg-actions { display: flex; gap: 10px; }
      .sg-btn {
        flex: 1; height: 40px; border-radius: 6px; cursor: pointer; font-size: 14px;
        border: 1px solid #d6dee9; background: #fff; color: #47566b; font-family: inherit;
      }
      .sg-btn:hover { background: #f4f7fb; }
      .sg-primary { background: #0b5cab; border-color: #0b5cab; color: #fff; font-weight: 600; }
      .sg-primary:hover { background: #0a3f74; }
      .sg-btn:disabled { opacity: .6; cursor: progress; }
    `;
    document.head.appendChild(style);
  }

  function showWarning() {
    if (dialog) return;
    warning = true;
    injectStyles();
    const idleMinutes = Math.round((cfg.idleMs - cfg.warnMs) / 60000);

    dialog = document.createElement("div");
    dialog.className = "sg-backdrop";
    dialog.innerHTML = `
      <div class="sg-card" role="alertdialog" aria-modal="true" aria-labelledby="sg-title">
        <div class="sg-icon" aria-hidden="true">⏱</div>
        <h2 id="sg-title">是否要延長登入時間？</h2>
        <p>您已經 ${idleMinutes} 分鐘沒有操作。為保護病人資料，系統即將自動登出。</p>
        <div class="sg-count"><span id="sg-count">--</span> 秒後登出</div>
        <div class="sg-actions">
          <button type="button" class="sg-btn" id="sg-logout">立即登出</button>
          <button type="button" class="sg-btn sg-primary" id="sg-extend">延長登入時間</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector("#sg-extend").addEventListener("click", extend);
    dialog.querySelector("#sg-logout").addEventListener("click", () => expire("使用者選擇立即登出"));
    dialog.querySelector("#sg-extend").focus();
    updateCountdown();
  }

  function hideWarning() {
    warning = false;
    if (dialog) {
      dialog.remove();
      dialog = null;
    }
  }

  function updateCountdown() {
    if (!dialog) return;
    const left = Math.max(0, Math.ceil((deadline() - Date.now()) / 1000));
    const node = dialog.querySelector("#sg-count");
    if (node) node.textContent = left;
  }

  async function extend() {
    const button = dialog?.querySelector("#sg-extend");
    if (button) {
      button.disabled = true;
      button.textContent = "延長中…";
    }
    try {
      if (cfg.onExtend) await cfg.onExtend();
      hideWarning();
      touch(true);
    } catch (e) {
      // refresh token 也過期了（例如 Keycloak 端的 session 已結束），只能重新登入。
      expire(`延長失敗：${e.message}`);
    }
  }

  function expire(reason) {
    stop();
    hideWarning();
    if (cfg?.onExpire) cfg.onExpire(reason);
  }

  /* ---------------- 主迴圈 ---------------- */

  async function tick() {
    if (!hasSession()) return;
    const remaining = deadline() - Date.now();

    if (remaining <= 0) {
      expire("閒置逾時，已自動登出");
      return;
    }
    if (remaining <= cfg.warnMs) {
      showWarning();
      updateCountdown();
      return;
    }
    if (warning) hideWarning();   // 其他分頁延長了，這裡跟著收起來

    // 使用者還在操作時，先把快到期的 access token 換新，
    // 免得 kc_token cookie 過期害 Orthanc / Wazuh / FHIR 的閘道把人擋掉。
    const session = readSession();
    if (!refreshing && cfg.onExtend && session?.refresh_token
        && Date.now() > (session.expires_at || 0) - cfg.refreshLeadMs) {
      refreshing = true;
      try {
        await cfg.onExtend();
      } catch (_) {
        // 這裡失敗不強制登出，等真的閒置逾時或呼叫 API 時再處理。
      } finally {
        refreshing = false;
      }
    }
  }

  const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];

  function onActivity() {
    touch();
  }

  function onVisible() {
    if (document.visibilityState === "visible") tick();
  }

  function onStorage(event) {
    if (event.key === STORAGE_KEY) tick();
  }

  function start(options = {}) {
    cfg = { ...DEFAULTS, ...options };
    stop();
    if (!hasSession()) return;

    touch(true);
    ACTIVITY_EVENTS.forEach(name =>
      global.addEventListener(name, onActivity, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", onVisible);
    global.addEventListener("storage", onStorage);
    ticker = setInterval(tick, 1000);
    tick();
  }

  function stop() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    ACTIVITY_EVENTS.forEach(name => global.removeEventListener(name, onActivity, { capture: true }));
    document.removeEventListener("visibilitychange", onVisible);
    global.removeEventListener("storage", onStorage);
  }

  global.SessionGuard = { start, stop, touch: () => touch(true), remainingMs: () => deadline() - Date.now() };
})(window);
