/**
 * Keycloak SSO（Authorization Code + PKCE）共用模組。
 *
 * 與 /app.js 共用同一個 localStorage key（tokenSet）與 kc_token cookie，
 * 所以在影像入口登入後進 FHIR Portal 不需要再登入一次，反之亦然。
 * app.js 是既有頁面的獨立實作，這裡不去動它，避免影響已上線的上傳入口。
 */
(function (global) {
  const currentHost = global.location.hostname;
  const scheme = global.location.protocol;
  const keycloakBase = `${scheme}//${currentHost}:8080`;
  const realm = "dicom";
  const clientId = "dicom-portal";
  const loginTtlMs = 20 * 60 * 1000;

  const authUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/auth`;
  const tokenUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/token`;
  const logoutUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/logout`;

  let tokenSet = load();

  function load() {
    try {
      const raw = localStorage.getItem("tokenSet") || sessionStorage.getItem("tokenSet");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && !parsed.authenticated_until) parsed.authenticated_until = Date.now() + loginTtlMs;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function save(data) {
    const expiresAt = Date.now() + ((data.expires_in || 300) * 1000);
    // 閒置計時由 session-timeout.js 維護，換 token 時沿用，不重新計算。
    const authenticatedUntil = tokenSet?.authenticated_until && tokenSet.authenticated_until > Date.now()
      ? tokenSet.authenticated_until
      : Date.now() + loginTtlMs;
    tokenSet = { ...tokenSet, ...data, expires_at: expiresAt, authenticated_until: authenticatedUntil };
    localStorage.setItem("tokenSet", JSON.stringify(tokenSet));
    saveCookie();
  }

  function saveCookie() {
    if (!tokenSet?.access_token) return;
    const validUntil = Math.min(tokenSet.expires_at || 0, tokenSet.authenticated_until || 0);
    const maxAge = Math.max(0, Math.floor((validUntil - Date.now()) / 1000));
    document.cookie = `kc_token=${encodeURIComponent(tokenSet.access_token)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  }

  function clear() {
    tokenSet = null;
    localStorage.removeItem("tokenSet");
    sessionStorage.removeItem("tokenSet");
    document.cookie = "kc_token=; Max-Age=0; Path=/; SameSite=Lax";
  }

  function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(length = 64) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join("");
  }

  function rotr(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  // 從區網 IP 以 http 連線時 crypto.subtle 不存在（非 secure context），
  // 但 Keycloak client 強制 S256，所以必須自己算 SHA-256。
  function sha256Fallback(text) {
    const bytes = new TextEncoder().encode(text);
    const words = [];
    const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    for (let i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
    words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | (0x80 << (24 - (bytes.length % 4) * 8));
    words[(((bytes.length + 8) >> 6) << 4) + 15] = bytes.length * 8;

    for (let i = 0; i < words.length; i += 16) {
      const w = new Array(64).fill(0);
      for (let t = 0; t < 16; t++) w[t] = words[i + t] || 0;
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let t = 0; t < 64; t++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + k[t] + w[t]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    hash.forEach((value, i) => {
      out[i * 4] = value >>> 24;
      out[i * 4 + 1] = value >>> 16;
      out[i * 4 + 2] = value >>> 8;
      out[i * 4 + 3] = value;
    });
    return out.buffer;
  }

  async function sha256(text) {
    if (!crypto.subtle) return sha256Fallback(text);
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  }

  function redirectUri() {
    return global.location.origin + global.location.pathname;
  }

  async function login() {
    const codeVerifier = randomString(96);
    const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
    const state = randomString(32);
    sessionStorage.setItem("pkce_verifier", codeVerifier);
    sessionStorage.setItem("pkce_state", state);
    sessionStorage.setItem("post_login_hash", global.location.hash || "");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid profile email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    global.location.assign(`${authUrl}?${params.toString()}`);
  }

  function logout() {
    const idToken = tokenSet?.id_token;
    clear();
    const params = new URLSearchParams({ post_logout_redirect_uri: redirectUri() });
    if (idToken) params.set("id_token_hint", idToken);
    else params.set("client_id", clientId);
    global.location.assign(`${logoutUrl}?${params.toString()}`);
  }

  async function handleCallback() {
    const url = new URL(global.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      cleanUrl(url);
      throw new Error(`Keycloak 回傳錯誤：${error} ${url.searchParams.get("error_description") || ""}`);
    }
    if (!code) return false;

    const expectedState = sessionStorage.getItem("pkce_state");
    const verifier = sessionStorage.getItem("pkce_verifier");
    sessionStorage.removeItem("pkce_state");
    sessionStorage.removeItem("pkce_verifier");
    if (!verifier || (expectedState && state !== expectedState)) {
      cleanUrl(url);
      throw new Error("登入流程 state 驗證失敗，請重新登入");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    });
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) {
      cleanUrl(url);
      throw new Error(`交換 token 失敗：HTTP ${r.status} ${await r.text()}`);
    }
    save(await r.json());
    const savedHash = sessionStorage.getItem("post_login_hash") || "";
    sessionStorage.removeItem("post_login_hash");
    cleanUrl(url, savedHash);
    return true;
  }

  function cleanUrl(url, hash) {
    const clean = url.origin + url.pathname + (hash || "");
    global.history.replaceState({}, document.title, clean);
  }

  function isAuthenticated() {
    return !!tokenSet?.access_token && Date.now() < (tokenSet.authenticated_until || 0);
  }

  // 用 refresh token 換一組新的 access token；延長登入與背景續期都走這裡。
  async function refresh() {
    tokenSet = load();
    if (!tokenSet?.refresh_token) throw new Error("沒有 refresh token，請重新登入");
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokenSet.refresh_token,
      }),
    });
    if (!r.ok) {
      clear();
      throw new Error(`登入憑證已失效（HTTP ${r.status}）`);
    }
    save(await r.json());
    return tokenSet;
  }

  function claims() {
    if (!tokenSet?.access_token) return {};
    try {
      const payload = tokenSet.access_token.split(".")[1];
      const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (_) {
      return {};
    }
  }

  function roles() {
    const c = claims();
    const realmRoles = c.realm_access?.roles || [];
    const clientRoles = Object.values(c.resource_access || {}).flatMap(x => x.roles || []);
    return [...new Set([...realmRoles, ...clientRoles])];
  }

  function hasRole(...wanted) {
    const mine = roles();
    return wanted.some(r => mine.includes(r));
  }

  function accessToken() {
    return tokenSet?.access_token || null;
  }

  global.KcAuth = {
    login, logout, handleCallback, isAuthenticated, claims, roles, hasRole,
    accessToken, saveCookie, clear, refresh, session: () => tokenSet,
    keycloakBase, realm, clientId,
  };
})(window);
