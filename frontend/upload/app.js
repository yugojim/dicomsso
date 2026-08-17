const currentHost = window.location.hostname;
const appScheme = window.location.protocol;
const apiBase = window.location.origin;
// https 時 Keycloak 走 nginx 的 8443（TLS 終結），http 時才是舊的直連 8080
const keycloakBase = appScheme === "https:"
  ? `https://${currentHost}:8443`
  : `http://${currentHost}:8080`;
const ohifBase = `${appScheme}//${currentHost}:13000`;
const orthancAdminBase = `${appScheme}//${currentHost}:18042`;
const realm = "dicom";
const clientId = "dicom-portal";
const redirectUri = window.location.origin + window.location.pathname;

const authUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/auth`;
const registrationUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/registrations`;
const tokenUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/token`;
const logoutUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/logout`;
const idleTimeoutMs = 20 * 60 * 1000;   // 閒置多久自動登出
const idleWarnMs = 2 * 60 * 1000;      // 登出前多久跳出延長提示（第 18 分鐘）

let tokenSet = loadTokenSet();

function $(id) {
  return document.getElementById(id);
}

function pretty(x) {
  return JSON.stringify(x, null, 2);
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

function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  if (!crypto.subtle) return sha256Fallback(text);
  return crypto.subtle.digest("SHA-256", data);
}

function saveTokenSet(data) {
  const expiresAt = Date.now() + ((data.expires_in || 300) * 1000);
  // 閒置計時由 session-timeout.js 維護，換 token 不重算，只在沒有值時給預設。
  const authenticatedUntil = tokenSet?.authenticated_until && tokenSet.authenticated_until > Date.now()
    ? tokenSet.authenticated_until
    : Date.now() + idleTimeoutMs;
  tokenSet = { ...tokenSet, ...data, expires_at: expiresAt, authenticated_until: authenticatedUntil };
  localStorage.setItem("tokenSet", JSON.stringify(tokenSet));
  saveTokenCookie();
}

function loadTokenSet() {
  try {
    const stored = localStorage.getItem("tokenSet") || sessionStorage.getItem("tokenSet");
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && !parsed.authenticated_until) {
      parsed.authenticated_until = Date.now() + idleTimeoutMs;
      localStorage.setItem("tokenSet", JSON.stringify(parsed));
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function clearTokenSet() {
  tokenSet = null;
  localStorage.removeItem("tokenSet");
  sessionStorage.removeItem("tokenSet");
  document.cookie = "kc_token=; Max-Age=0; Path=/; SameSite=Lax";
}

function saveTokenCookie() {
  if (!tokenSet?.access_token) return;
  const validUntil = Math.min(tokenSet.expires_at || 0, tokenSet.authenticated_until || 0);
  const maxAge = Math.max(0, Math.floor((validUntil - Date.now()) / 1000));
  document.cookie = `kc_token=${encodeURIComponent(tokenSet.access_token)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

function isAuthenticated() {
  return !!tokenSet?.access_token && Date.now() < (tokenSet.authenticated_until || 0);
}

function tokenHeader() {
  return { Authorization: `Bearer ${tokenSet.access_token}` };
}

function decodeJwt(token) {
  const payload = token.split(".")[1];
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decodeURIComponent(escape(json)));
}

function hasRole(role) {
  if (!tokenSet?.access_token) return false;
  try {
    const claims = decodeJwt(tokenSet.access_token);
    const realmRoles = claims.realm_access?.roles || [];
    const clientRoles = Object.values(claims.resource_access || {}).flatMap(client => client.roles || []);
    return [...realmRoles, ...clientRoles].includes(role);
  } catch (_) {
    return false;
  }
}

function hasRealmRole(role) {
  if (!tokenSet?.access_token) return false;
  try {
    const claims = decodeJwt(tokenSet.access_token);
    return (claims.realm_access?.roles || []).includes(role);
  } catch (_) {
    return false;
  }
}

function hasAnyRealmRole(...roles) {
  return roles.some(role => hasRealmRole(role));
}

function hasAnyRole(...roles) {
  return roles.some(role => hasRole(role));
}

async function openOhif(url) {
  if (!isAuthenticated()) return alert("請先登入");
  await ensureToken();
  window.open(buildOhifUrl(url), "_blank", "noopener");
}

function buildOhifUrl(url) {
  const viewerUrl = new URL(url);
  viewerUrl.protocol = appScheme;
  viewerUrl.host = new URL(ohifBase).host;
  viewerUrl.searchParams.set("viewerConfigVersion", "20260618-active-server");
  viewerUrl.searchParams.set("token", tokenSet.access_token);
  return viewerUrl.toString();
}

async function startAuth(targetUrl = authUrl) {
  const codeVerifier = randomString(96);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const state = randomString(32);
  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  window.location.href = `${targetUrl}?${params.toString()}`;
}

async function login() {
  await startAuth();
}

async function registerAccount() {
  await startAuth(registrationUrl);
}

async function handleCallbackIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;

  const returnedState = params.get("state");
  const expectedState = sessionStorage.getItem("oauth_state");
  if (returnedState !== expectedState) {
    throw new Error("OAuth state 不一致，請重新登入");
  }

  const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
  if (!codeVerifier) {
    history.replaceState({}, document.title, redirectUri);
    throw new Error("登入流程已失效，請重新按 SSO 登入");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) {
    sessionStorage.removeItem("pkce_code_verifier");
    sessionStorage.removeItem("oauth_state");
    history.replaceState({}, document.title, redirectUri);
    throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  }

  saveTokenSet(await r.json());
  sessionStorage.removeItem("pkce_code_verifier");
  sessionStorage.removeItem("oauth_state");
  history.replaceState({}, document.title, redirectUri);
}

async function ensureToken(force = false) {
  if (!isAuthenticated()) {
    clearTokenSet();
    throw new Error("閒置超過 20 分鐘，請重新登入");
  }
  if (!tokenSet?.refresh_token) return;
  if (!force && Date.now() < (tokenSet.expires_at || 0) - 30000) return;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokenSet.refresh_token
  });
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) {
    clearTokenSet();
    throw new Error("登入已過期，請重新登入");
  }
  saveTokenSet(await r.json());
}

function showLoggedOut(message = "尚未登入") {
  clearTokenSet();
  updateButtons();
  $("me").textContent = message;
  $("studyRows").innerHTML = '<tr><td colspan="8">尚無資料</td></tr>';
}

async function logout() {
  const idToken = tokenSet?.id_token;
  clearTokenSet();
  const params = new URLSearchParams({
    client_id: clientId,
    post_logout_redirect_uri: redirectUri
  });
  if (idToken) params.set("id_token_hint", idToken);
  window.location.href = `${logoutUrl}?${params.toString()}`;
}

async function loadMe() {
  if (!isAuthenticated()) {
    $("me").textContent = "尚未登入";
    return;
  }
  await ensureToken();
  const r = await fetch(`${apiBase}/api/me`, { headers: tokenHeader() });
  if (!r.ok) throw new Error(`/api/me failed: ${r.status} ${await r.text()}`);
  $("me").textContent = pretty(await r.json());
}

async function loadStudies() {
  if (!isAuthenticated()) return;
  await ensureToken();
  const r = await fetch(`${apiBase}/api/studies`, { headers: tokenHeader() });
  if (!r.ok) throw new Error(`/api/studies failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  const tbody = $("studyRows");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8">尚無資料</td></tr>';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const viewLink = row.ohif_url ? `<a href="${buildOhifUrl(row.ohif_url)}" target="_blank" rel="noopener" data-ohif-url="${row.ohif_url}">OHIF</a>` : "-";
    tr.innerHTML = `
      <td>${row.uploaded_by || ""}</td>
      <td>${row.created_at || ""}</td>
      <td>${row.patient_id || ""}</td>
      <td>${row.patient_name || ""}</td>
      <td>${row.study_date || ""}</td>
      <td>${row.modality || ""}</td>
      <td>${row.description || ""}</td>
      <td>${viewLink}</td>
    `;
    const ohifLink = tr.querySelector("[data-ohif-url]");
    if (ohifLink) {
      ohifLink.onclick = async (event) => {
        event.preventDefault();
        await openOhif(ohifLink.dataset.ohifUrl);
      };
    }
    tbody.appendChild(tr);
  }
}

async function uploadFiles() {
  if (!isAuthenticated()) return alert("請先登入");
  const input = $("fileInput");
  if (!input.files.length) return alert("請選擇 DICOM 或 ZIP 檔案");

  await ensureToken();
  const form = new FormData();
  for (const file of input.files) form.append("files", file);

  const r = await fetch(`${apiBase}/api/upload`, {
    method: "POST",
    headers: tokenHeader(),
    body: form
  });
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text || `Upload failed with HTTP ${r.status}` };
  }
  $("uploadResult").textContent = formatUploadResult(body, r.ok);
  if (!r.ok) throw new Error(`/api/upload failed: ${r.status}`);
  await loadStudies();
}

// 重複上傳同一個 Study 時後端會沿用既有紀錄，影像清單不會多一列。
// 只印原始 JSON 的話看起來像「沒反應」，所以這裡先給一段人看得懂的結果說明。
function formatUploadResult(body, ok) {
  if (!ok || !body?.summary) return pretty(body);

  const lines = [`上傳完成：共 ${body.summary.files} 個檔案`, body.summary.message, ""];
  for (const item of body.uploaded || []) {
    const state = item.record === "new" ? "新增" : "已存在，未重複列出";
    lines.push(`· ${item.filename}：${state}`);
    lines.push(`    Study UID ${item.study_instance_uid || "—"}　Orthanc ${item.status || "—"}`);
  }
  lines.push("", "原始回應：", pretty(body));
  return lines.join("\n");
}

function updateButtons() {
  $("orthancAdminLink").href = `${orthancAdminBase}/app/explorer.html`;
  $("loginBtn").hidden = isAuthenticated();
  $("registerBtn").hidden = isAuthenticated();
  $("logoutBtn").hidden = !isAuthenticated();
  $("orthancAdminLink").hidden = !isAuthenticated() || !hasRealmRole("admin");
  $("hisLink").hidden = !isAuthenticated() || !hasAnyRealmRole("admin", "fhir-admin", "fhir-user");
}

async function init() {
  try {
    await handleCallbackIfNeeded();
    updateButtons();
    if (isAuthenticated()) {
      saveTokenCookie();
      startSessionGuard();
      const claims = decodeJwt(tokenSet.access_token);
      const roles = claims.realm_access?.roles || [];
      $("me").textContent = pretty({ login: claims.preferred_username, tenant_id: claims.tenant_id, roles });
      await loadMe();
      if (!hasAnyRole("viewer", "uploader", "admin", "wazuh-admin", "wazuh-readonly", "fhir-user", "fhir-admin")) {
        $("me").textContent = pretty({
          login: claims.preferred_username,
          tenant_id: claims.tenant_id || claims.preferred_username || claims.sub,
          roles,
          status: "待管理者審核，尚未開通影像功能"
        });
        $("studyRows").innerHTML = '<tr><td colspan="8">帳號待管理者審核，尚未開通影像功能</td></tr>';
        return;
      }
      await loadStudies();
    }
  } catch (e) {
    console.error(e);
    if (e.message.includes("登入已") || e.message.includes("閒置")) {
      showLoggedOut(`SSO 設定或登入流程錯誤：\n${e.message}`);
      return;
    }
    $("me").textContent = "SSO 設定或登入流程錯誤：\n" + e.message;
    updateButtons();
  }
}

function startSessionGuard() {
  if (!isAuthenticated()) return;
  SessionGuard.start({
    idleMs: idleTimeoutMs,
    warnMs: idleWarnMs,
    onTouch: until => {
      if (!tokenSet) return;
      tokenSet.authenticated_until = until;
      saveTokenCookie();
    },
    onExtend: () => ensureToken(true),
    onExpire: reason => {
      SessionGuard.stop();
      showLoggedOut(`${reason}\n請重新登入。`);
    },
  });
}

$("loginBtn").onclick = login;
$("registerBtn").onclick = registerAccount;
$("logoutBtn").onclick = logout;
$("uploadBtn").onclick = uploadFiles;
$("refreshBtn").onclick = loadStudies;

init();
