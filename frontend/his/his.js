/**
 * 電子病歷交換平台（FHIR Portal）
 *
 * 資料面依衛福部「電子病歷交換單張實作指引 EMR IG」與 TW Core：
 *   https://twcore.mohw.gov.tw/ig/emr/
 * 帳號與權限由 Keycloak 控管，FHIR 請求走同源 /fhir，
 * 由 Nginx auth_request → backend /api/auth/fhir 驗 role 後才轉給 HAPI FHIR。
 */

const FHIR_BASE = `${window.location.origin}/fhir`;
const OHIF_BASE = `${window.location.protocol}//${window.location.hostname}:13000`;
const FHIR_SERVER_BASE = `${window.location.protocol}//${window.location.hostname}:18090`;

const EMR_SD = "https://twcore.mohw.gov.tw/ig/emr/StructureDefinition";
const CS_ICD10 = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2021-tw";
const CS_FDA = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-fda-tw";
const CS_IMGID = "https://twcore.mohw.gov.tw/ig/emr/CodeSystem/ImageIdentifierType";
const CS_ICD10PCS = "https://twcore.mohw.gov.tw/ig/emr/CodeSystem/ICD-10-procedurecode";
const LOINC = "http://loinc.org";
const SCT = "http://snomed.info/sct";
const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const MOI = "http://www.moi.gov.tw";
const HOSP_SYS = "https://demo-hospital.example.tw";
const ORG_REF = "Organization/emr-org-1";

const DOC_KINDS = {
  "34117-2": { label: "門診病歷", short: "PMR", cls: "pill-info" },
  "11502-2": { label: "檢驗檢查報告", short: "IC", cls: "pill-ok" },
  "18842-5": { label: "出院病歷摘要", short: "DMS", cls: "pill-warn" },
  "57833-6": { label: "電子處方箋", short: "EP", cls: "pill-neutral" },
  "18748-4": { label: "醫療影像及報告", short: "IMG", cls: "pill-info" },
};

const state = {
  practitioners: [],
  practitionerMap: new Map(),
  lastPatients: [],
};

/* ============================ 基礎工具 ============================ */

const $ = id => document.getElementById(id);

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : ""}`;
  el.textContent = message;
  $("toastHost").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3800);
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function age(birthDate) {
  if (!birthDate) return "—";
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return "—";
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return `${a} 歲`;
}

const GENDER = { male: "男", female: "女", other: "其他", unknown: "不明" };

function codingText(cc) {
  if (!cc) return "—";
  if (cc.text) return cc.text;
  const c = (cc.coding || [])[0];
  return c ? (c.display || c.code || "—") : "—";
}

function codingCode(cc) {
  const c = ((cc || {}).coding || [])[0];
  return c ? c.code : "";
}

function refId(reference) {
  if (!reference) return "";
  const raw = typeof reference === "string" ? reference : reference.reference || "";
  const parts = raw.split("/");
  return parts.length >= 2 ? parts.slice(-2).join("/") : raw;
}

function patientName(p) {
  const n = (p.name || [])[0];
  if (!n) return "(未命名)";
  if (n.text) return n.text;
  return [(n.family || ""), (n.given || []).join("")].filter(Boolean).join("");
}

function identifierOf(resource, system) {
  return (resource.identifier || []).find(i => i.system === system)?.value || "";
}

function mrnOf(p) {
  const byType = (p.identifier || []).find(i => codingCode(i.type) === "MR");
  return byType?.value || identifierOf(p, HOSP_SYS) || "—";
}

function nationalIdOf(p) {
  return identifierOf(p, MOI) || "—";
}

function practitionerName(reference) {
  const id = refId(reference);
  return state.practitionerMap.get(id) || (id ? id.split("/")[1] : "—");
}

function profileShort(resource) {
  const p = (resource.meta?.profile || [])[0];
  return p ? p.split("/").pop() : "";
}

/* ============================ FHIR client ============================ */

async function fhir(path, options = {}) {
  const url = path.startsWith("http") ? path : `${FHIR_BASE}${path}`;
  const headers = {
    Accept: "application/fhir+json",
    Authorization: `Bearer ${KcAuth.accessToken()}`,
    // HAPI 預設會把搜尋結果快取 60 秒。臨床畫面剛建檔就重新查詢時，
    // 沒有這個 header 會讀到建檔前的舊結果（看起來像沒寫進去）。
    "Cache-Control": "no-cache",
  };
  if (options.body) headers["Content-Type"] = "application/fhir+json; charset=UTF-8";

  const r = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await r.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }

  if (!r.ok) {
    if (r.status === 401) {
      showGate("登入已逾時或憑證無效，請重新登入。", true);
      throw new Error("未授權");
    }
    const detail = payload?.issue?.map(i => i.diagnostics || i.details?.text).filter(Boolean).join("；")
      || payload?.detail || text || `HTTP ${r.status}`;
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return payload;
}

function bundleEntries(bundle) {
  return (bundle?.entry || []).map(e => e.resource).filter(Boolean);
}

function pickByType(resources, type) {
  return resources.filter(r => r.resourceType === type);
}

/* ============================ 版面元件 ============================ */

function cardShell(title, sub, bodyHtml, actionsHtml = "", tight = false) {
  return `
    <section class="card">
      <div class="card-head">
        <h2>${esc(title)}${sub ? ` <span class="sub">${esc(sub)}</span>` : ""}</h2>
        <div class="inline-actions">${actionsHtml}</div>
      </div>
      <div class="card-body${tight ? " tight" : ""}">${bodyHtml}</div>
    </section>`;
}

function tableShell(headers, rowsHtml, emptyText = "查無資料") {
  if (!rowsHtml) return `<div class="empty">${esc(emptyText)}</div>`;
  return `
    <div class="table-wrap">
      <table class="data">
        <thead><tr>${headers.map(h => `<th class="nowrap">${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

function loading(text = "載入中…") {
  return `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
}

function rawButton(resource, label = "原始 FHIR") {
  const key = `${resource.resourceType}/${resource.id}`;
  return `<button class="btn btn-ghost btn-sm" data-raw="${esc(key)}">${esc(label)}</button>`;
}

/* ============================ 抽屜（原始 JSON） ============================ */

const rawCache = new Map();

function cacheRaw(resource) {
  if (resource?.id) rawCache.set(`${resource.resourceType}/${resource.id}`, resource);
  return resource;
}

function openDrawer(title, data) {
  $("drawerTitle").textContent = title;
  $("drawerBody").textContent = JSON.stringify(data, null, 2);
  $("drawer").hidden = false;
}

document.addEventListener("click", async event => {
  const rawTarget = event.target.closest("[data-raw]");
  if (rawTarget) {
    const key = rawTarget.dataset.raw;
    let res = rawCache.get(key);
    if (!res) {
      try { res = await fhir(`/${key}`); } catch (e) { return toast(e.message, "error"); }
    }
    openDrawer(key, res);
    return;
  }
  const navTarget = event.target.closest("[data-nav]");
  if (navTarget) {
    event.preventDefault();
    location.hash = navTarget.dataset.nav;
  }
});

/* ============================ 模態 ============================ */

function closeModal() {
  $("modalHost").hidden = true;
  $("modalHost").innerHTML = "";
}

function openModal({ title, sub, bodyHtml, submitLabel = "儲存", onSubmit, onReady, wide = false }) {
  const host = $("modalHost");
  host.innerHTML = `
    <div class="modal${wide ? " modal-wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
        <button class="btn btn-ghost btn-sm" data-modal-close>關閉</button>
      </div>
      <form id="modalForm"><div class="modal-body">${bodyHtml}<div id="modalError" class="form-error" hidden></div></div>
      <div class="modal-foot">
        <button type="button" class="btn" data-modal-close>取消</button>
        <button type="submit" class="btn btn-primary" id="modalSubmit">${esc(submitLabel)}</button>
      </div></form>
    </div>`;
  host.hidden = false;
  host.querySelectorAll("[data-modal-close]").forEach(b => b.addEventListener("click", closeModal));
  host.querySelector("#modalForm").addEventListener("submit", async event => {
    event.preventDefault();
    const submit = $("modalSubmit");
    const errorBox = $("modalError");
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = "處理中…";
    try {
      await onSubmit(new FormData(event.target));
      closeModal();
    } catch (e) {
      errorBox.textContent = e.message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });
  if (onReady) onReady(host);
  const first = host.querySelector("input, select, textarea");
  if (first) first.focus();
}

function field(name, label, { type = "text", value = "", hint = "", required = false, wide = false, options, rows } = {}) {
  const attrs = `name="${esc(name)}" ${required ? "required" : ""}`;
  let control;
  if (options) {
    control = `<select ${attrs}>${options.map(o =>
      `<option value="${esc(o.value)}"${o.value === value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  } else if (type === "textarea") {
    control = `<textarea ${attrs} rows="${rows || 3}">${esc(value)}</textarea>`;
  } else {
    control = `<input type="${type}" ${attrs} value="${esc(value)}" />`;
  }
  return `
    <div class="field${wide ? " wide" : ""}">
      <label for="${esc(name)}">${esc(label)}${required ? " *" : ""}</label>
      ${control}
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
    </div>`;
}

function nowLocalInput() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toFhirDateTime(localValue) {
  const d = localValue ? new Date(localValue) : new Date();
  const pad = n => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

/* ============================ 路由 ============================ */

const routes = [
  { pattern: /^#\/patients$/, handler: () => viewPatients() },
  { pattern: /^#\/patient\/([^/]+)(?:\/([^/]+))?$/, handler: (id, tab) => viewPatient(id, tab || "overview") },
  { pattern: /^#\/documents$/, handler: () => viewDocuments() },
  { pattern: /^#\/document\/([^/]+)$/, handler: id => viewDocument(id) },
  { pattern: /^#\/imaging$/, handler: () => viewImaging() },
  { pattern: /^#\/link-imaging$/, handler: () => viewLinkImaging() },
  { pattern: /^#\/labs$/, handler: () => viewLabs() },
  { pattern: /^#\/server$/, handler: () => viewServer() },
];

function router() {
  const hash = location.hash || "#/patients";
  const rail = hash.startsWith("#/patient/") ? "#/patients"
    : hash.startsWith("#/document/") ? "#/documents" : hash;
  document.querySelectorAll(".rail-item").forEach(item => {
    item.classList.toggle("is-active", item.dataset.nav === rail);
  });
  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (match) {
      route.handler(...match.slice(1).map(x => x && decodeURIComponent(x)));
      return;
    }
  }
  location.hash = "#/patients";
}

function render(html) {
  $("view").innerHTML = html;
  $("view").scrollTop = 0;
}

/* ============================ 病人主檔 ============================ */

function patientRow(p) {
  cacheRaw(p);
  const female = p.gender === "female";
  return `
    <tr class="is-clickable" data-nav="#/patient/${esc(p.id)}">
      <td class="mono nowrap">${esc(mrnOf(p))}</td>
      <td class="nowrap"><strong>${esc(patientName(p))}</strong></td>
      <td class="nowrap">${esc(GENDER[p.gender] || "—")}</td>
      <td class="nowrap">${esc(fmtDate(p.birthDate))}</td>
      <td class="nowrap">${esc(age(p.birthDate))}</td>
      <td class="mono nowrap">${esc(nationalIdOf(p))}</td>
      <td class="nowrap">${esc((p.telecom || [])[0]?.value || "—")}</td>
      <td class="nowrap">${esc(p.address?.[0]?.city || "")}${esc(p.address?.[0]?.district || "")}</td>
      <td class="nowrap right">${rawButton(p, "FHIR")}</td>
    </tr>`;
}

async function viewPatients(query = "") {
  render(`
    <div class="page-head">
      <div><span class="kicker">Patient</span><h1>病人主檔</h1></div>
      <div class="page-actions">
        ${canWrite() ? `<button class="btn btn-primary" id="newPatientBtn">＋ 新增病人</button>` : ""}
        <button class="btn" id="reloadBtn">重新整理</button>
      </div>
    </div>
    <section class="card">
      <div class="card-head">
        <h2>病人查詢 <span class="sub">Patient?name= / identifier=</span></h2>
      </div>
      <div class="card-body">
        <form class="search-bar" id="patientSearch">
          ${field("q", "姓名 / 病歷號 / 身分證字號", { value: query, hint: "留白顯示全部" })}
          <button class="btn btn-primary" type="submit">查詢</button>
          <button class="btn" type="button" id="clearSearch">清除</button>
        </form>
      </div>
    </section>
    <section class="card"><div class="card-body tight" id="patientList">${loading()}</div></section>
  `);

  $("patientSearch").addEventListener("submit", e => {
    e.preventDefault();
    loadPatients(new FormData(e.target).get("q").trim());
  });
  $("clearSearch").addEventListener("click", () => { $("patientSearch").q.value = ""; loadPatients(""); });
  $("reloadBtn").addEventListener("click", () => loadPatients(query));
  if ($("newPatientBtn")) $("newPatientBtn").addEventListener("click", newPatientModal);

  loadPatients(query);
}

async function loadPatients(query = "") {
  const host = $("patientList");
  host.innerHTML = loading();
  try {
    let path = "/Patient?_count=100&_sort=-_lastUpdated";
    if (query) {
      const asId = /^[A-Za-z]\d{9}$|^\d+$/.test(query);
      path = asId
        ? `/Patient?identifier=${encodeURIComponent(query)}&_count=50`
        : `/Patient?name=${encodeURIComponent(query)}&_count=50`;
    }
    const bundle = await fhir(path);
    const patients = bundleEntries(bundle);
    state.lastPatients = patients;
    host.innerHTML = tableShell(
      ["病歷號", "姓名", "性別", "出生日期", "年齡", "身分證字號", "聯絡電話", "居住地", ""],
      patients.map(patientRow).join(""),
      query ? `找不到符合「${query}」的病人` : "尚無病人資料，請先執行 seed 或新增病人");
  } catch (e) {
    host.innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

function newPatientModal() {
  openModal({
    title: "新增病人",
    sub: "Patient（EMR IG：PMRPatient / TW Core）",
    submitLabel: "建立病歷",
    bodyHtml: `<div class="form-grid">
      ${field("name", "姓名", { required: true })}
      ${field("gender", "性別", { required: true, options: [
        { value: "male", label: "男" }, { value: "female", label: "女" },
        { value: "other", label: "其他" }, { value: "unknown", label: "不明" }] })}
      ${field("birthDate", "出生日期", { type: "date", required: true })}
      ${field("nid", "身分證字號", { required: true, hint: "system: http://www.moi.gov.tw" })}
      ${field("mrn", "病歷號", { required: true, hint: "identifier.type = MR" })}
      ${field("phone", "聯絡電話")}
      ${field("city", "縣市")}
      ${field("district", "鄉鎮市區")}
      ${field("line", "地址", { wide: true })}
    </div>`,
    onSubmit: async form => {
      const get = k => (form.get(k) || "").trim();
      const patient = {
        resourceType: "Patient",
        meta: { profile: [`${EMR_SD}/PMRPatient`] },
        identifier: [
          { type: { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }] },
            system: HOSP_SYS, value: get("mrn") },
          { use: "official",
            type: { coding: [{ system: V2_0203, code: "NNxxx" }] },
            system: MOI, value: get("nid") },
        ],
        active: true,
        name: [{ use: "official", text: get("name") }],
        gender: get("gender"),
        birthDate: get("birthDate"),
        managingOrganization: { reference: ORG_REF },
      };
      if (get("phone")) patient.telecom = [{ system: "phone", value: get("phone"), use: "mobile" }];
      if (get("city") || get("line")) {
        patient.address = [{
          use: "home",
          text: `${get("city")}${get("district")}${get("line")}`,
          line: get("line") ? [get("line")] : undefined,
          city: get("city") || undefined,
          district: get("district") || undefined,
          country: "TW",
        }];
      }
      const created = await fhir("/Patient", { method: "POST", body: patient });
      toast(`已建立病歷：${patientName(created)}（${created.id}）`);
      location.hash = `#/patient/${created.id}`;
    },
  });
}

/* ============================ 病人病歷 ============================ */

const PATIENT_TABS = [
  { key: "overview", label: "臨床總覽" },
  { key: "encounters", label: "就診紀錄" },
  { key: "labs", label: "檢驗檢查" },
  { key: "meds", label: "用藥處方" },
  { key: "imaging", label: "醫療影像" },
  { key: "documents", label: "交換單張" },
];

async function viewPatient(id, tab) {
  render(loading("讀取病歷中…"));
  let data;
  try {
    data = await loadPatientChart(id);
  } catch (e) {
    render(`<div class="card"><div class="card-body">讀取病歷失敗：${esc(e.message)}</div></div>`);
    return;
  }

  const p = data.patient;
  const female = p.gender === "female";
  const allergies = data.allergies;

  const counts = {
    encounters: data.encounters.length,
    labs: data.labs.length,
    meds: data.medications.length,
    imaging: data.imaging.length,
    documents: data.compositions.length,
  };

  render(`
    <div class="page-head">
      <div>
        <span class="kicker">Patient / ${esc(p.id)}</span>
        <h1>病歷檢視</h1>
      </div>
      <div class="page-actions">
        <button class="btn" data-nav="#/patients">← 回病人主檔</button>
        ${canWrite() ? `<button class="btn btn-accent" id="newVisitBtn">＋ 新增門診就診</button>` : ""}
        ${rawButton(p, "病人原始 FHIR")}
      </div>
    </div>

    <div class="patient-banner">
      <div class="patient-id-block">
        <span class="patient-avatar${female ? " female" : ""}">${esc(patientName(p).slice(0, 1))}</span>
        <span>
          <div class="patient-name">${esc(patientName(p))}</div>
          <div class="patient-sub">${esc(GENDER[p.gender] || "—")} · ${esc(age(p.birthDate))} · ${esc(fmtDate(p.birthDate))}</div>
        </span>
      </div>
      <div class="patient-facts">
        <div class="fact"><span class="fact-label">病歷號</span><span class="fact-value mono">${esc(mrnOf(p))}</span></div>
        <div class="fact"><span class="fact-label">身分證字號</span><span class="fact-value mono">${esc(nationalIdOf(p))}</span></div>
        <div class="fact"><span class="fact-label">聯絡電話</span><span class="fact-value">${esc((p.telecom || [])[0]?.value || "—")}</span></div>
        <div class="fact"><span class="fact-label">就醫身分</span><span class="fact-value">${esc(data.coverages.map(c => codingText(c.type)).join("、") || "—")}</span></div>
        <div class="fact"><span class="fact-label">最近就診</span><span class="fact-value">${esc(fmtDate(data.encounters[0]?.period?.start) || "—")}</span></div>
      </div>
    </div>

    ${allergies.length ? `<div class="alert-strip">
      <strong>過敏警示</strong>
      <span>${allergies.map(a => `${esc(codingText(a.code))}（${esc(a.criticality === "high" ? "高風險" : a.criticality || "—")}）`).join("、")}</span>
    </div>` : ""}

    <div class="tabs">
      ${PATIENT_TABS.map(t => `
        <button class="tab${t.key === tab ? " is-active" : ""}" data-nav="#/patient/${esc(p.id)}/${t.key}">
          ${esc(t.label)}${counts[t.key] !== undefined ? `<span class="count">${counts[t.key]}</span>` : ""}
        </button>`).join("")}
    </div>

    <div id="tabBody"></div>
  `);

  if ($("newVisitBtn")) $("newVisitBtn").addEventListener("click", () => newVisitModal(p));
  renderPatientTab(tab, data);
}

async function loadPatientChart(id) {
  const patient = cacheRaw(await fhir(`/Patient/${encodeURIComponent(id)}`));
  const subject = `Patient/${id}`;
  const [encB, conB, obsB, medB, imgB, drB, comB, algB, cliB, proB, covB, cpB] = await Promise.all([
    fhir(`/Encounter?subject=${subject}&_sort=-date&_count=50`),
    fhir(`/Condition?subject=${subject}&_count=100`),
    fhir(`/Observation?subject=${subject}&_sort=-date&_count=100`),
    fhir(`/MedicationRequest?subject=${subject}&_include=MedicationRequest:medication&_count=100`),
    fhir(`/ImagingStudy?subject=${subject}&_count=50`),
    fhir(`/DiagnosticReport?subject=${subject}&_count=50`),
    fhir(`/Composition?subject=${subject}&_sort=-date&_count=50`),
    fhir(`/AllergyIntolerance?patient=${subject}&_count=50`),
    fhir(`/ClinicalImpression?patient=${subject}&_count=100`),
    fhir(`/Procedure?subject=${subject}&_count=50`),
    fhir(`/Coverage?beneficiary=${subject}&_count=20`),
    fhir(`/CarePlan?subject=${subject}&_count=20`),
  ]);

  const medEntries = bundleEntries(medB);
  const data = {
    patient,
    encounters: bundleEntries(encB).map(cacheRaw),
    conditions: bundleEntries(conB).map(cacheRaw),
    observations: bundleEntries(obsB).map(cacheRaw),
    medications: pickByType(medEntries, "MedicationRequest").map(cacheRaw),
    medicationMap: new Map(pickByType(medEntries, "Medication").map(m => [`Medication/${m.id}`, cacheRaw(m)])),
    imaging: bundleEntries(imgB).map(cacheRaw),
    reports: bundleEntries(drB).map(cacheRaw),
    compositions: bundleEntries(comB).map(cacheRaw),
    allergies: bundleEntries(algB).map(cacheRaw),
    impressions: bundleEntries(cliB).map(cacheRaw),
    procedures: bundleEntries(proB).map(cacheRaw),
    coverages: bundleEntries(covB).map(cacheRaw),
    carePlans: bundleEntries(cpB).map(cacheRaw),
  };
  data.labs = data.observations.filter(o =>
    (o.category || []).some(c => codingCode(c) === "laboratory"));
  return data;
}

function renderPatientTab(tab, data) {
  const host = $("tabBody");
  const renderers = {
    overview: tabOverview,
    encounters: tabEncounters,
    labs: tabLabs,
    meds: tabMeds,
    imaging: tabImaging,
    documents: tabDocuments,
  };
  host.innerHTML = (renderers[tab] || tabOverview)(data);
  bindTabActions(tab, data);
}

function bindTabActions(tab, data) {
  const p = data.patient;
  if ($("newLabBtn")) $("newLabBtn").addEventListener("click", () =>
    newLabReportModal({ patientName: patientName(p) }));
  if ($("newRxBtn")) $("newRxBtn").addEventListener("click", () => newRxModal(p, data));
  document.querySelectorAll("[data-make-doc]").forEach(btn => {
    btn.addEventListener("click", () => buildCompositionModal(data, btn.dataset.makeDoc));
  });
}

function tabOverview(data) {
  const active = data.conditions.filter(c =>
    codingCode(c.clinicalStatus) === "active");
  const latestLabs = data.labs.slice(0, 3);

  const problems = active.length ? `<ul class="timeline">${active.map(c => `
      <li>
        <div class="t-when">${esc(fmtDate(c.recordedDate))} · ${esc(codingText(c.category?.[0]))}</div>
        <div class="t-title">${esc(codingText(c.code))} <code>${esc(codingCode(c.code))}</code></div>
      </li>`).join("")}</ul>` : `<div class="empty">無記錄中的診斷</div>`;

  const visits = data.encounters.slice(0, 5).length ? `<ul class="timeline">${data.encounters.slice(0, 5).map(e => `
      <li>
        <div class="t-when">${esc(fmtDateTime(e.period?.start))}</div>
        <div class="t-title">${esc(codingText(e.serviceType))} · ${esc(encounterClass(e))}</div>
        <div class="t-body">主治：${esc(practitionerName(e.participant?.[0]?.individual))}</div>
      </li>`).join("")}</ul>` : `<div class="empty">無就診紀錄</div>`;

  const impressions = data.impressions.length ? data.impressions
    .sort((a, b) => (a.code?.coding?.[0]?.code || "").localeCompare(b.code?.coding?.[0]?.code || ""))
    .slice(0, 3)
    .map(ci => {
      const code = codingCode(ci.code);
      const kind = code === "61150-9" ? ["S", "主觀描述 Subjective", ""]
        : code === "61149-1" ? ["O", "客觀描述 Objective", "o"]
        : ["A", "評估 Assessment", "a"];
      return `<div class="soap-block">
        <span class="soap-tag ${kind[2]}">${kind[0]}</span><strong>${esc(kind[1])}</strong>
        <div class="t-body" style="margin-left:30px">${esc(ci.description || ci.summary || "—")}</div>
      </div>`;
    }).join("") : `<div class="empty">無 SOAP 病程紀錄</div>`;

  const meds = data.medications.slice(0, 5).map(m => {
    const med = data.medicationMap.get(refId(m.medicationReference));
    return `<tr>
      <td>${esc(med ? codingText(med.code) : codingText(m.medicationCodeableConcept))}</td>
      <td class="nowrap">${esc(m.dosageInstruction?.[0]?.timing?.code?.text || "—")}</td>
      <td class="nowrap">${esc(m.dispenseRequest?.expectedSupplyDuration?.value || "—")} 天</td>
      <td class="nowrap">${esc(fmtDate(m.authoredOn))}</td>
    </tr>`;
  }).join("");

  return `
    <div class="grid-3">
      <div class="stat"><div class="stat-label">就診次數</div><div class="stat-value">${data.encounters.length}</div><div class="stat-foot">Encounter</div></div>
      <div class="stat"><div class="stat-label">診斷</div><div class="stat-value">${data.conditions.length}</div><div class="stat-foot">Condition</div></div>
      <div class="stat"><div class="stat-label">檢驗項目</div><div class="stat-value">${data.labs.length}</div><div class="stat-foot">Observation</div></div>
      <div class="stat"><div class="stat-label">交換單張</div><div class="stat-value">${data.compositions.length}</div><div class="stat-foot">Composition</div></div>
    </div>
    <div class="grid-2">
      ${cardShell("問題清單 Problem List", "Condition", problems)}
      ${cardShell("近期就診", "Encounter", visits)}
    </div>
    <div class="grid-2">
      ${cardShell("最近一次 SOAP 病程", "ClinicalImpression", impressions)}
      ${cardShell("用藥中處方", "MedicationRequest",
        meds ? tableShell(["藥品", "頻次", "天數", "開立日"], meds) : `<div class="empty">無處方紀錄</div>`, "", !!meds)}
    </div>
    ${cardShell("最近檢驗結果", "Observation (laboratory)",
      latestLabs.length ? latestLabs.map(labCard).join("") : `<div class="empty">無檢驗資料</div>`)}
  `;
}

function encounterClass(e) {
  const map = { AMB: "門診", IMP: "住院", EMER: "急診", OBSENC: "檢查/觀察" };
  return map[e.class?.code] || e.class?.code || "—";
}

function tabEncounters(data) {
  const rows = data.encounters.map(e => {
    const dx = data.conditions.filter(c => refId(c.encounter) === `Encounter/${e.id}`);
    const docs = data.compositions.filter(c => refId(c.encounter) === `Encounter/${e.id}`);
    return `<tr>
      <td class="nowrap">${esc(fmtDateTime(e.period?.start))}</td>
      <td class="nowrap">${esc(encounterClass(e))}</td>
      <td class="nowrap">${esc(codingText(e.serviceType))}</td>
      <td class="nowrap">${esc(practitionerName(e.participant?.[0]?.individual))}</td>
      <td>${dx.length ? dx.map(c => `${esc(codingText(c.code))} <code>${esc(codingCode(c.code))}</code>`).join("<br>") : "—"}</td>
      <td class="nowrap">${docs.map(d => `<a href="#/document/${esc(d.id)}" data-nav="#/document/${esc(d.id)}" class="pill pill-info">${esc(DOC_KINDS[codingCode(d.type)]?.short || "DOC")}</a>`).join(" ") || "—"}</td>
      <td class="nowrap right">
        ${canWrite() ? `<button class="btn btn-ghost btn-sm" data-make-doc="${esc(e.id)}">產生單張</button>` : ""}
        ${rawButton(e, "FHIR")}
      </td>
    </tr>`;
  }).join("");

  const procedures = data.procedures.map(p => `<tr>
      <td class="nowrap">${esc(fmtDateTime(p.performedDateTime || p.performedPeriod?.start))}</td>
      <td>${esc(codingText(p.code))}</td>
      <td class="nowrap">${esc(codingCode(p.code))}</td>
      <td class="nowrap">${esc(practitionerName(p.performer?.[0]?.actor))}</td>
      <td class="nowrap right">${rawButton(p, "FHIR")}</td>
    </tr>`).join("");

  const plans = data.carePlans.map(cp => `
    <div class="soap-block">
      <strong>${esc(cp.title || "照護計畫")}</strong> <span class="muted small">${esc(fmtDate(cp.period?.start))}</span>
      <div class="t-body">${esc(cp.description || "—")}</div>
    </div>`).join("");

  return `
    ${cardShell("就診紀錄", "Encounter · EMR IG PMREncounter / EncounterDMS",
      tableShell(["就診時間", "類別", "科別", "主治醫師", "診斷", "單張", ""], rows, "無就診紀錄"), "", true)}
    ${cardShell("處置 / 手術", "Procedure",
      tableShell(["時間", "項目", "代碼", "執行者", ""], procedures, "無處置紀錄"), "", true)}
    ${plans ? cardShell("出院指示 / 照護計畫", "CarePlan", plans) : ""}
  `;
}

function labCard(o) {
  const rows = (o.component || []).map(c => {
    const q = c.valueQuantity || {};
    const range = c.referenceRange?.[0]?.text || "";
    const flag = quantityFlag(q.value, range);
    return `<tr>
      <td>${esc(codingText(c.code))}</td>
      <td class="num ${flag.cls}">${esc(q.value ?? "—")}</td>
      <td class="nowrap muted">${esc(q.unit || "")}</td>
      <td class="nowrap ref-flag">${esc(range || "—")}</td>
      <td class="nowrap">${flag.badge}</td>
    </tr>`;
  }).join("");

  const interp = o.interpretation?.[0];
  const pill = interp
    ? `<span class="pill ${codingCode(interp) === "N" || codingCode(interp) === "RR" ? "pill-ok" : "pill-warn"}">${esc(codingText(interp))}</span>`
    : "";

  return cardShell(
    `${codingText(o.code)}`,
    `${fmtDateTime(o.effectiveDateTime || o.effectivePeriod?.start)} · LOINC ${codingCode(o.code)}`,
    rows ? tableShell(["檢驗項目", "結果", "單位", "參考值", "判讀"], rows)
      : `<div class="empty">${esc(o.valueString || o.valueQuantity?.value || "無明細")}</div>`,
    `${pill} ${rawButton(o, "FHIR")}`,
    true);
}

function quantityFlag(value, range) {
  if (value === undefined || value === null || !range) return { cls: "", badge: "" };
  const m = String(range).match(/(-?\d+(?:\.\d+)?)\s*[-~]\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const low = parseFloat(m[1]);
    const high = parseFloat(m[2]);
    if (value < low) return { cls: "value-low", badge: `<span class="pill pill-info">L 偏低</span>` };
    if (value > high) return { cls: "value-abnormal", badge: `<span class="pill pill-danger">H 偏高</span>` };
    return { cls: "", badge: `<span class="pill pill-ok">正常</span>` };
  }
  const lt = String(range).match(/^<\s*(-?\d+(?:\.\d+)?)/);
  if (lt && value > parseFloat(lt[1])) {
    return { cls: "value-abnormal", badge: `<span class="pill pill-danger">H 偏高</span>` };
  }
  return { cls: "", badge: "" };
}

function tabLabs(data) {
  const head = `
    <div class="page-actions" style="margin-bottom:12px">
      ${canWrite() ? `<button class="btn btn-accent" id="newLabBtn">＋ 登錄檢驗結果</button>` : ""}
    </div>`;
  if (!data.labs.length) return head + `<div class="card"><div class="empty">無檢驗檢查資料</div></div>`;
  return head + data.labs.map(labCard).join("");
}

function tabMeds(data) {
  const rows = data.medications.map(m => {
    const med = data.medicationMap.get(refId(m.medicationReference));
    const dose = m.dosageInstruction?.[0];
    return `<tr>
      <td><strong>${esc(med ? codingText(med.code) : codingText(m.medicationCodeableConcept))}</strong>
        ${med ? `<div class="muted small mono">${esc(codingCode(med.code))}</div>` : ""}</td>
      <td class="nowrap">${esc(dose?.doseAndRate?.[0]?.doseQuantity?.value ?? "—")} ${esc(dose?.doseAndRate?.[0]?.doseQuantity?.unit || "")}</td>
      <td class="nowrap">${esc(dose?.timing?.code?.text || codingCode(dose?.timing?.code) || "—")}</td>
      <td class="nowrap">${esc(codingText(dose?.route))}</td>
      <td class="nowrap">${esc(m.dispenseRequest?.expectedSupplyDuration?.value ?? "—")} 天</td>
      <td>${esc(dose?.text || "—")}</td>
      <td class="nowrap">${esc(fmtDate(m.authoredOn))}</td>
      <td class="nowrap"><span class="pill ${m.status === "completed" ? "pill-ok" : "pill-neutral"}">${esc(m.status)}</span></td>
      <td class="nowrap right">${rawButton(m, "FHIR")}</td>
    </tr>`;
  }).join("");

  return `
    <div class="page-actions" style="margin-bottom:12px">
      ${canWrite() ? `<button class="btn btn-accent" id="newRxBtn">＋ 開立處方</button>` : ""}
    </div>
    ${cardShell("處方明細", "MedicationRequest + Medication · EMR IG PMRMedicationRequest",
      tableShell(["藥品", "劑量", "頻次", "途徑", "天數", "用法說明", "開立日", "狀態", ""], rows, "無處方紀錄"),
      "", true)}`;
}

function tabImaging(data) {
  if (!data.imaging.length && !data.reports.length) {
    return `<div class="card"><div class="empty">無醫療影像資料</div></div>`;
  }

  const studies = data.imaging.map(s => {
    const uid = (s.identifier || []).find(i => i.system === "urn:dicom:uid")?.value || "";
    const studyUid = uid.replace(/^urn:oid:/, "");
    const report = data.reports.find(r => (r.imagingStudy || []).some(x => refId(x) === `ImagingStudy/${s.id}`));
    const result = report && data.observations.find(o => (report.result || []).some(x => refId(x) === `Observation/${o.id}`));
    return `
      <section class="card">
        <div class="card-head">
          <h2>${esc(s.description || codingText(s.procedureCode?.[0]))}
            <span class="sub">${esc(fmtDateTime(s.started))} · ${esc((s.modality || []).map(m => m.code).join("/") || "—")}</span></h2>
          <div class="inline-actions">
            ${studyUid ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${esc(OHIF_BASE)}/viewer/${encodeURIComponent(studyUid)}">在 OHIF 開啟</a>` : ""}
            ${rawButton(s, "FHIR")}
          </div>
        </div>
        <div class="card-body">
          <dl class="kv">
            <dt>Study Instance UID</dt><dd class="mono">${esc(studyUid || "—")}</dd>
            <dt>Accession No.</dt><dd class="mono">${esc((s.identifier || []).find(i => i.system === HOSP_SYS)?.value || "—")}</dd>
            <dt>系列 / 影像數</dt><dd>${esc(s.numberOfSeries ?? "—")} 系列 · ${esc(s.numberOfInstances ?? "—")} 張</dd>
            <dt>檢查部位</dt><dd>${esc(s.series?.[0]?.bodySite?.display || "—")}</dd>
            <dt>影像位址</dt><dd class="mono">${esc(refId(s.endpoint?.[0]) || "—")}</dd>
          </dl>
          ${report ? `
            <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                <strong>影像診斷報告</strong>
                <span class="muted small">${esc(fmtDateTime(report.issued))} · 判讀：${esc(practitionerName(report.resultsInterpreter?.[0]))}</span>
              </div>
              ${result ? `<p style="white-space:pre-wrap;margin:8px 0">${esc(result.valueString || "")}</p>` : ""}
              <div style="margin-top:8px"><span class="pill pill-info">結論</span> ${esc(report.conclusion || "—")}</div>
            </div>` : ""}
        </div>
      </section>`;
  }).join("");

  return studies;
}

function tabDocuments(data) {
  const rows = data.compositions.map(c => {
    const kind = DOC_KINDS[codingCode(c.type)] || { label: codingText(c.type), short: "DOC", cls: "pill-neutral" };
    return `<tr class="is-clickable" data-nav="#/document/${esc(c.id)}">
      <td class="nowrap"><span class="pill ${kind.cls}">${esc(kind.short)}</span> ${esc(kind.label)}</td>
      <td class="nowrap">${esc(fmtDateTime(c.date))}</td>
      <td class="nowrap">${esc(c.section?.length || 0)} 章節</td>
      <td class="nowrap">${esc(practitionerName((c.author || []).find(a => refId(a).startsWith("Practitioner"))))}</td>
      <td class="mono nowrap small">${esc(profileShort(c))}</td>
      <td class="nowrap"><span class="pill ${c.status === "final" ? "pill-ok" : "pill-warn"}">${esc(c.status)}</span></td>
      <td class="nowrap right">${rawButton(c, "FHIR")}</td>
    </tr>`;
  }).join("");

  return cardShell("電子病歷交換單張", "Composition · $document 產生交換 Bundle",
    tableShell(["單張類型", "文件日期", "章節", "撰寫醫師", "Profile", "狀態", ""], rows, "尚未產生任何交換單張"),
    "", true);
}

/* ============================ 建檔（fhir-admin） ============================ */

function canWrite() {
  return KcAuth.hasRole("fhir-admin", "admin");
}

async function ensurePractitioners() {
  if (state.practitioners.length) return state.practitioners;
  const bundle = await fhir("/Practitioner?_count=50");
  state.practitioners = bundleEntries(bundle).map(cacheRaw);
  state.practitionerMap = new Map(state.practitioners.map(p =>
    [`Practitioner/${p.id}`, p.name?.[0]?.text || p.id]));
  return state.practitioners;
}

function practitionerOptions() {
  return state.practitioners.map(p => ({
    value: `Practitioner/${p.id}`,
    label: `${p.name?.[0]?.text || p.id}（${p.qualification?.[0]?.code?.text || "—"}）`,
  }));
}

function newVisitModal(patient) {
  openModal({
    title: "新增門診就診",
    sub: "一次以 FHIR transaction 建立 Encounter + Condition + ClinicalImpression(S/O/A)",
    submitLabel: "建立就診紀錄",
    bodyHtml: `<div class="form-grid">
      ${field("start", "就診時間", { type: "datetime-local", value: nowLocalInput(), required: true })}
      ${field("dept", "科別", { value: "心臟內科", required: true })}
      ${field("klass", "就診類別", { options: [
        { value: "AMB", label: "門診" }, { value: "IMP", label: "住院" },
        { value: "EMER", label: "急診" }], value: "AMB" })}
      ${field("practitioner", "主治醫師", { options: practitionerOptions(), required: true })}
      ${field("dxCode", "診斷代碼 ICD-10-CM", { required: true, hint: CS_ICD10.split("/").pop() })}
      ${field("dxText", "診斷名稱", { required: true })}
      ${field("subjective", "主觀描述 S", { type: "textarea", wide: true })}
      ${field("objective", "客觀描述 O", { type: "textarea", wide: true })}
      ${field("assessment", "評估 A", { type: "textarea", wide: true })}
    </div>`,
    onSubmit: async form => {
      const get = k => (form.get(k) || "").trim();
      const when = toFhirDateTime(get("start"));
      const subject = { reference: `Patient/${patient.id}` };
      const encUrn = "urn:uuid:enc-1";
      const entries = [];

      entries.push({
        fullUrl: encUrn,
        resource: {
          resourceType: "Encounter",
          meta: { profile: [`${EMR_SD}/PMREncounter`] },
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: get("klass") },
          serviceType: { coding: [{ system: SCT, code: "394609007" }], text: get("dept") },
          subject,
          participant: [{ individual: { reference: get("practitioner") } }],
          period: { start: when },
          serviceProvider: { reference: ORG_REF },
        },
        request: { method: "POST", url: "Encounter" },
      });

      entries.push({
        fullUrl: "urn:uuid:con-1",
        resource: {
          resourceType: "Condition",
          meta: { profile: [`${EMR_SD}/PMRConditionDiagnosis`] },
          clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
          verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
          category: [{ coding: [{ system: LOINC, code: "29548-5" }], text: "診斷" }],
          code: { coding: [{ system: CS_ICD10, code: get("dxCode"), display: get("dxText") }], text: get("dxText") },
          subject,
          encounter: { reference: encUrn },
          recordedDate: when.slice(0, 10),
        },
        request: { method: "POST", url: "Condition" },
      });

      const soap = [
        ["subjective", "61150-9", `${EMR_SD}/PMRClinicalImpressionSubjective`, "主觀描述 Subjective"],
        ["objective", "61149-1", `${EMR_SD}/PMRClinicalImpressionObjective`, "客觀描述 Objective"],
        ["assessment", "11494-2", `${EMR_SD}/PMRClinicalImpressionAssessment`, "評估 Assessment"],
      ];
      soap.forEach(([key, loinc, prof, title], idx) => {
        const text = get(key);
        if (!text) return;
        entries.push({
          fullUrl: `urn:uuid:cli-${idx}`,
          resource: {
            resourceType: "ClinicalImpression",
            meta: { profile: [prof] },
            identifier: [{ system: LOINC, value: loinc }],
            status: "completed",
            code: { coding: [{ system: LOINC, code: loinc }], text: title },
            description: text,
            summary: text,
            subject,
            encounter: { reference: encUrn },
            date: when,
          },
          request: { method: "POST", url: "ClinicalImpression" },
        });
      });

      await fhir("", { method: "POST", body: { resourceType: "Bundle", type: "transaction", entry: entries } });
      toast(`已建立就診紀錄（${entries.length} 筆資源）`);
      viewPatient(patient.id, "encounters");
    },
  });
}

function newRxModal(patient, data) {
  const encOptions = [{ value: "", label: "（不指定）" }].concat(data.encounters.map(e => ({
    value: `Encounter/${e.id}`,
    label: `${fmtDateTime(e.period?.start)} ${codingText(e.serviceType)}`,
  })));
  openModal({
    title: "開立處方",
    sub: "Medication + MedicationRequest（EMR IG：PMRMedicationRequest）",
    submitLabel: "開立",
    bodyHtml: `<div class="form-grid">
      ${field("drug", "藥品名稱", { required: true, value: "Amlodipine 5mg 錠" })}
      ${field("fda", "衛福部許可證字號", { required: true, value: "衛署藥製字第045678號", hint: CS_FDA.split("/").pop() })}
      ${field("form", "劑型", { options: [
        { value: "TAB|錠劑", label: "錠劑 TAB" }, { value: "CAP|膠囊", label: "膠囊 CAP" },
        { value: "POWD|粉劑", label: "粉劑 POWD" }, { value: "SOL|液劑", label: "液劑 SOL" }] })}
      ${field("freq", "用藥頻次", { options: [
        { value: "QD|每日一次", label: "QD 每日一次" }, { value: "BID|每日二次", label: "BID 每日二次" },
        { value: "TID|每日三次", label: "TID 每日三次" }, { value: "QID|每日四次", label: "QID 每日四次" },
        { value: "HS|睡前", label: "HS 睡前" }, { value: "PRN|需要時", label: "PRN 需要時" }] })}
      ${field("dose", "單次劑量", { type: "number", value: "1", required: true })}
      ${field("doseUnit", "劑量單位", { value: "TAB" })}
      ${field("days", "給藥天數", { type: "number", value: "28", required: true })}
      ${field("prescriber", "開立醫師", { options: practitionerOptions(), required: true })}
      ${field("encounter", "關聯就診", { options: encOptions })}
      ${field("note", "用法說明", { wide: true, value: "早餐後服用" })}
    </div>`,
    onSubmit: async form => {
      const get = k => (form.get(k) || "").trim();
      const [formCode, formText] = get("form").split("|");
      const [freqCode, freqText] = get("freq").split("|");
      const medUrn = "urn:uuid:med-1";
      const request = {
        resourceType: "MedicationRequest",
        meta: { profile: [`${EMR_SD}/PMRMedicationRequest`] },
        status: "active",
        intent: "order",
        category: [{ coding: [{ system: LOINC, code: "29551-9", display: "Medication prescribed Narrative" }] }],
        medicationReference: { reference: medUrn },
        subject: { reference: `Patient/${patient.id}` },
        authoredOn: toFhirDateTime(),
        requester: { reference: get("prescriber") },
        dosageInstruction: [{
          sequence: 1,
          text: get("note"),
          timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: freqCode }], text: freqText } },
          route: { coding: [{ system: SCT, code: "26643006", display: "Oral route" }], text: "口服" },
          doseAndRate: [{ doseQuantity: { value: Number(get("dose")), unit: get("doseUnit") } }],
        }],
        dispenseRequest: {
          quantity: { value: Number(get("dose")) * Number(get("days")), unit: get("doseUnit") },
          expectedSupplyDuration: { value: Number(get("days")), unit: "days", system: "http://unitsofmeasure.org", code: "d" },
        },
      };
      if (get("encounter")) request.encounter = { reference: get("encounter") };

      await fhir("", {
        method: "POST",
        body: {
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              fullUrl: medUrn,
              resource: {
                resourceType: "Medication",
                meta: { profile: [`${EMR_SD}/PMRMedication`] },
                code: { coding: [{ system: CS_FDA, code: get("fda"), display: get("drug") }], text: get("drug") },
                form: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm", code: formCode }], text: formText },
              },
              request: { method: "POST", url: "Medication" },
            },
            { fullUrl: "urn:uuid:rx-1", resource: request, request: { method: "POST", url: "MedicationRequest" } },
          ],
        },
      });
      toast(`已開立處方：${get("drug")}`);
      viewPatient(patient.id, "meds");
    },
  });
}

function buildCompositionModal(data, encounterId) {
  const enc = data.encounters.find(e => e.id === encounterId);
  const encRef = `Encounter/${encounterId}`;
  const related = {
    conditions: data.conditions.filter(c => refId(c.encounter) === encRef),
    impressions: data.impressions.filter(c => refId(c.encounter) === encRef),
    medications: data.medications.filter(m => refId(m.encounter) === encRef),
    labs: data.labs.filter(o => refId(o.encounter) === encRef),
    procedures: data.procedures.filter(p => refId(p.encounter) === encRef),
    coverages: data.coverages,
    allergies: data.allergies,
  };
  const summary = [
    ["診斷 Condition", related.conditions.length],
    ["SOAP ClinicalImpression", related.impressions.length],
    ["處方 MedicationRequest", related.medications.length],
    ["檢驗 Observation", related.labs.length],
    ["處置 Procedure", related.procedures.length],
    ["過敏 AllergyIntolerance", related.allergies.length],
    ["就醫身分 Coverage", related.coverages.length],
  ];

  openModal({
    title: "產生電子病歷交換單張",
    sub: `${fmtDateTime(enc?.period?.start)} · ${codingText(enc?.serviceType)}`,
    submitLabel: "產生單張",
    bodyHtml: `
      <div class="form-grid">
        ${field("kind", "單張類型", { options: [
          { value: "PMR", label: "門診病歷（LOINC 34117-2）" },
          { value: "EP", label: "電子處方箋（LOINC 57833-6）" },
          { value: "IC", label: "檢驗檢查報告（LOINC 11502-2）" },
          { value: "DMS", label: "出院病歷摘要（LOINC 18842-5）" },
        ] })}
        ${field("author", "撰寫醫師", { options: practitionerOptions(), required: true })}
      </div>
      <p class="muted small" style="margin:14px 0 6px">本次就診可納入單張的資源：</p>
      ${tableShell(["章節內容", "筆數"], summary.map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join(""))}
      <p class="muted small" style="margin-top:10px">
        產生後可用 <code>Composition/{id}/$document</code> 匯出符合 EMR IG 的交換 Bundle。</p>`,
    onSubmit: async form => {
      const kind = form.get("kind");
      const author = form.get("author");
      const sections = [];
      const push = (title, loinc, refs) => {
        if (refs.length) sections.push({ title, code: { coding: [{ system: LOINC, code: loinc }] }, entry: refs.map(r => ({ reference: r })) });
      };
      const ref = (type, list) => list.map(r => `${type}/${r.id}`);

      if (kind === "PMR") {
        push("門診病歷中的病人基本資料_過敏史", "10155-0", ref("AllergyIntolerance", related.allergies));
        push("門診病歷中的病人基本資料_就醫身分別", "63513-6", ref("Coverage", related.coverages));
        push("門診病歷中的診斷", "29548-5", ref("Condition", related.conditions));
        push("門診病歷中的診斷病情摘要_主、客觀描述與評估", "19824-2", ref("ClinicalImpression", related.impressions));
        push("門診病歷中的處置項目", "29554-3", ref("Procedure", related.procedures));
        push("門診病歷中的處方內容", "29549-3", ref("MedicationRequest", related.medications));
        push("門診病歷中的實驗室檢查紀錄", "19146-0", ref("Observation", related.labs));
      } else if (kind === "EP") {
        push("電子處方箋中的診斷", "29548-5", ref("Condition", related.conditions));
        push("電子處方箋中的處方內容", "29549-3", ref("MedicationRequest", related.medications));
        push("電子處方箋中的就醫身分別", "63513-6", ref("Coverage", related.coverages));
      } else if (kind === "IC") {
        push("檢驗檢查中的檢驗資料", "26436-6", ref("Observation", related.labs));
      } else {
        push("出院病摘中的出院診斷", "11535-2", ref("Condition", related.conditions));
        push("出院病摘中的手術日期及方法", "10223-6", ref("Procedure", related.procedures));
        push("出院病摘中的檢驗", "26436-6", ref("Observation", related.labs));
      }
      if (!sections.length) throw new Error("這次就診沒有可納入的資料，請先建立診斷、處方或檢驗結果。");

      const meta = {
        PMR: [`${EMR_SD}/PMRComposition`, "34117-2", "門診病歷"],
        EP: [`${EMR_SD}/Composition-EP`, "57833-6", "電子處方箋"],
        IC: [`${EMR_SD}/InspectionCheckComposition`, "11502-2", "檢驗檢查報告"],
        DMS: [`${EMR_SD}/CompositionDMS`, "18842-5", "出院病歷摘要"],
      }[kind];

      const created = await fhir("/Composition", {
        method: "POST",
        body: {
          resourceType: "Composition",
          meta: { profile: [meta[0]] },
          status: "final",
          type: { coding: [{ system: LOINC, code: meta[1] }], text: meta[2] },
          subject: { reference: `Patient/${data.patient.id}` },
          encounter: { reference: encRef },
          date: toFhirDateTime(),
          author: [{ reference: ORG_REF }, { reference: author }],
          title: meta[2],
          custodian: { reference: ORG_REF },
          section: sections,
        },
      });
      toast(`已產生${meta[2]}（${sections.length} 個章節）`);
      location.hash = `#/document/${created.id}`;
    },
  });
}

/* ============================ 共用：病人選擇器 ============================ */

function patientPickerHtml({ label = "對應病人", withEncounter = true } = {}) {
  return `
    <div class="form-grid">
      ${field("patientQuery", "搜尋病人", { hint: "輸入姓名 / 病歷號 / 身分證字號後自動查詢" })}
      <div class="field">
        <label for="patientRef">${esc(label)} *</label>
        <select name="patientRef" id="patientRef"><option value="">（請先搜尋）</option></select>
        <span class="hint" id="patientHint">　</span>
      </div>
      ${withEncounter ? `
      <div class="field wide">
        <label for="encounterRef">關聯就診（選填）</label>
        <select name="encounterRef" id="encounterRef"><option value="">（不指定）</option></select>
      </div>` : ""}
    </div>`;
}

/** 綁定病人搜尋 / 就診連動。回傳 { reload } 供外部再次觸發。 */
function bindPatientPicker(host, { initialTerm = "", withEncounter = true, onChange } = {}) {
  const query = host.querySelector('input[name=patientQuery]');
  const select = host.querySelector("#patientRef");
  const hint = host.querySelector("#patientHint");
  const encSelect = withEncounter ? host.querySelector("#encounterRef") : null;

  async function loadEncounters() {
    if (!encSelect) return;
    encSelect.innerHTML = `<option value="">（不指定）</option>`;
    if (!select.value) return;
    try {
      const encounters = bundleEntries(await fhir(`/Encounter?subject=${select.value}&_sort=-date&_count=20`));
      encounters.forEach(e => {
        const opt = document.createElement("option");
        opt.value = `Encounter/${e.id}`;
        opt.textContent = `${fmtDateTime(e.period?.start)}　${codingText(e.serviceType)}　${encounterClass(e)}`;
        encSelect.appendChild(opt);
      });
    } catch (_) { /* 就診是選填，讀不到不影響主要流程 */ }
  }

  async function search(term) {
    const isId = /^[A-Za-z]?\d{4,}$/.test(term);
    const path = term
      ? (isId ? `/Patient?identifier=${encodeURIComponent(term)}&_count=20`
              : `/Patient?name=${encodeURIComponent(term)}&_count=20`)
      : "/Patient?_count=20&_sort=-_lastUpdated";
    let patients = bundleEntries(await fhir(path));
    let fallback = false;
    if (!patients.length && term) {
      // DICOM 或外部系統的姓名常與院內病歷不同，查無結果時改列最近建檔的病人。
      patients = bundleEntries(await fhir("/Patient?_count=20&_sort=-_lastUpdated"));
      fallback = true;
    }
    select.innerHTML = patients.length
      ? patients.map(p => `<option value="Patient/${esc(p.id)}">${esc(patientName(p))}　${esc(mrnOf(p))}　${esc(GENDER[p.gender] || "")} ${esc(fmtDate(p.birthDate))}</option>`).join("")
      : `<option value="">查無病人</option>`;
    hint.textContent = fallback
      ? `查無「${term}」，改列出最近 ${patients.length} 位病人`
      : `找到 ${patients.length} 位`;
    await loadEncounters();
    if (onChange) await onChange(select.value, encSelect?.value || "");
  }

  let timer = null;
  query.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(query.value.trim()), 350);
  });
  select.addEventListener("change", async () => {
    await loadEncounters();
    if (onChange) await onChange(select.value, encSelect?.value || "");
  });
  if (encSelect && onChange) {
    encSelect.addEventListener("change", () => onChange(select.value, encSelect.value));
  }
  search(initialTerm);
  return { search };
}

/* ============================ 檢驗檢查輸入 ============================ */

const LAB_PRESETS = {
  cbc: {
    name: "全套血液檢查 CBC", loinc: "58410-2",
    items: [
      ["6690-2", "白血球 WBC", "", "10^3/uL", "3.8 - 10.0"],
      ["789-8", "紅血球 RBC", "", "10^6/uL", "4.2 - 6.2"],
      ["718-7", "血紅素 Hgb", "", "g/dL", "13.0 - 17.0"],
      ["4544-3", "血球容積比 Hct", "", "%", "40 - 52"],
      ["777-3", "血小板 Platelet", "", "10^3/uL", "150 - 400"],
    ],
  },
  biochem: {
    name: "生化學檢查 Biochemistry", loinc: "24323-8",
    items: [
      ["2345-7", "飯前血糖 Glucose AC", "", "mg/dL", "70 - 100"],
      ["4548-4", "糖化血色素 HbA1c", "", "%", "4.0 - 6.0"],
      ["2160-0", "肌酸酐 Creatinine", "", "mg/dL", "0.7 - 1.3"],
      ["3094-0", "尿素氮 BUN", "", "mg/dL", "8 - 20"],
      ["2093-3", "總膽固醇 Cholesterol", "", "mg/dL", "< 200"],
      ["2571-8", "三酸甘油酯 Triglyceride", "", "mg/dL", "< 150"],
    ],
  },
  liver: {
    name: "肝功能檢查 Liver Function", loinc: "24325-3",
    items: [
      ["1742-6", "GOT (AST)", "", "U/L", "10 - 40"],
      ["1920-8", "GPT (ALT)", "", "U/L", "5 - 40"],
      ["1975-2", "總膽紅素 Total Bilirubin", "", "mg/dL", "0.2 - 1.2"],
      ["1751-7", "白蛋白 Albumin", "", "g/dL", "3.5 - 5.0"],
    ],
  },
  urine: {
    name: "尿液常規檢查 Urinalysis", loinc: "24357-6",
    items: [
      ["5811-5", "尿比重 Specific Gravity", "", "", "1.003 - 1.030"],
      ["5803-2", "尿酸鹼值 pH", "", "", "5.0 - 8.0"],
      ["2350-7", "尿糖 Glucose", "", "", "陰性"],
      ["2888-6", "尿蛋白 Protein", "", "", "陰性"],
    ],
  },
};

const SPECIMEN_TYPES = [
  { value: "", label: "（不建立檢體資料）" },
  { value: "119297000|靜脈全血", label: "靜脈全血" },
  { value: "119364003|血清", label: "血清" },
  { value: "119361006|血漿", label: "血漿" },
  { value: "122575003|尿液", label: "尿液" },
  { value: "119334006|痰液", label: "痰液" },
  { value: "119376003|組織檢體", label: "組織檢體" },
];

function labRowHtml(item = ["", "", "", "", ""]) {
  const [loinc, name, value, unit, ref] = item;
  return `<tr>
    <td><input name="itemLoinc" value="${esc(loinc)}" placeholder="6690-2" style="width:100%"></td>
    <td><input name="itemName" value="${esc(name)}" placeholder="白血球 WBC" style="width:100%"></td>
    <td><input name="itemValue" value="${esc(value)}" placeholder="7.33" style="width:100%"></td>
    <td><input name="itemUnit" value="${esc(unit)}" placeholder="10^3/uL" style="width:100%"></td>
    <td><input name="itemRef" value="${esc(ref)}" placeholder="3.8 - 10.0" style="width:100%"></td>
    <td class="right"><button type="button" class="btn btn-ghost btn-sm" data-remove-row>刪除</button></td>
  </tr>`;
}

function newLabReportModal(preset = {}) {
  openModal({
    title: "新增檢驗報告",
    sub: "Observation + Specimen（EMR IG：InspectionCheckObservation / InspectionCheckSpecimen）",
    submitLabel: "寫入 FHIR",
    wide: true,
    bodyHtml: `
      <div class="form-section">
        <h3>一、病人與開單 <span class="note">Patient / Encounter</span></h3>
        ${patientPickerHtml({ label: "受檢病人" })}
        <div class="form-grid" style="margin-top:12px">
          ${field("when", "檢驗時間", { type: "datetime-local", value: nowLocalInput(), required: true })}
          ${field("performer", "檢驗人員", { options: practitionerOptions(), required: true })}
        </div>
      </div>

      <div class="form-section">
        <h3>二、檢體 <span class="note">Specimen，可留白</span></h3>
        <div class="form-grid">
          ${field("specimenType", "檢體種類", { options: SPECIMEN_TYPES })}
          ${field("collectedAt", "採檢時間", { type: "datetime-local", value: nowLocalInput() })}
          ${field("collectionSite", "採檢部位", { hint: "例：左上肢肘前靜脈" })}
        </div>
      </div>

      <div class="form-section">
        <h3>三、檢驗項目 <span class="note">Observation.component</span></h3>
        <div class="form-grid">
          ${field("presetKey", "常用套組", { options: [
            { value: "", label: "（自行輸入）" },
            { value: "cbc", label: "全套血液檢查 CBC" },
            { value: "biochem", label: "生化學檢查" },
            { value: "liver", label: "肝功能檢查" },
            { value: "urine", label: "尿液常規檢查" },
          ] })}
          ${field("panel", "檢驗套組名稱", { required: true, value: "" })}
          ${field("panelLoinc", "套組 LOINC", { required: true, value: "" })}
        </div>
        <div class="table-wrap" style="margin-top:10px">
          <table class="data" id="labItems">
            <thead><tr>
              <th style="width:120px">LOINC</th><th>項目名稱</th>
              <th style="width:110px">結果</th><th style="width:110px">單位</th>
              <th style="width:140px">參考值</th><th style="width:70px"></th>
            </tr></thead>
            <tbody>${labRowHtml()}${labRowHtml()}${labRowHtml()}</tbody>
          </table>
        </div>
        <button type="button" class="btn btn-sm" id="addLabRow" style="margin-top:8px">＋ 新增一列</button>
        <span class="muted small" style="margin-left:8px">結果留白的項目不會寫入</span>
      </div>

      <div class="form-section">
        <h3>四、判讀與交換單張</h3>
        <div class="form-grid">
          ${field("interp", "整體判讀", { options: [
            { value: "N", label: "正常" }, { value: "H", label: "偏高" },
            { value: "L", label: "偏低" }, { value: "A", label: "異常" }] })}
          ${field("note", "備註", { wide: true })}
        </div>
        <label class="check-row" style="margin-top:10px">
          <input type="checkbox" name="makeComposition" value="1" checked>
          同時產生「檢驗檢查」電子病歷交換單張
        </label>
      </div>`,
    onReady: host => {
      bindPatientPicker(host, { initialTerm: preset.patientName || "" });

      const tbody = host.querySelector("#labItems tbody");
      host.querySelector("#addLabRow").addEventListener("click", () => {
        tbody.insertAdjacentHTML("beforeend", labRowHtml());
      });
      tbody.addEventListener("click", event => {
        if (!event.target.closest("[data-remove-row]")) return;
        if (tbody.rows.length > 1) event.target.closest("tr").remove();
      });

      host.querySelector('select[name=presetKey]').addEventListener("change", event => {
        const p = LAB_PRESETS[event.target.value];
        if (!p) return;
        host.querySelector('input[name=panel]').value = p.name;
        host.querySelector('input[name=panelLoinc]').value = p.loinc;
        tbody.innerHTML = p.items.map(labRowHtml).join("");
      });
    },
    onSubmit: async form => {
      const get = k => (form.get(k) || "").trim();
      const patientRef = get("patientRef");
      if (!patientRef) throw new Error("請先選擇受檢病人");

      const loincs = form.getAll("itemLoinc");
      const names = form.getAll("itemName");
      const values = form.getAll("itemValue");
      const units = form.getAll("itemUnit");
      const refs = form.getAll("itemRef");
      const components = [];
      loincs.forEach((loinc, i) => {
        const name = (names[i] || "").trim();
        const value = (values[i] || "").trim();
        if (!value) return;                       // 沒有結果的列直接略過
        if (!name) throw new Error(`第 ${i + 1} 列有結果但沒有項目名稱`);
        const c = { code: { coding: loinc.trim() ? [{ system: LOINC, code: loinc.trim() }] : undefined, text: name } };
        if (!Number.isNaN(Number(value))) {
          c.valueQuantity = { value: Number(value), unit: (units[i] || "").trim() || undefined,
                              system: "http://unitsofmeasure.org" };
        } else {
          c.valueString = value;
        }
        if ((refs[i] || "").trim()) c.referenceRange = [{ text: refs[i].trim() }];
        components.push(c);
      });
      if (!components.length) throw new Error("請至少填寫一項檢驗結果");

      const when = toFhirDateTime(get("when"));
      const encounterRef = get("encounterRef");
      const entries = [];
      let specimenRef = "";

      if (get("specimenType")) {
        const [code, text] = get("specimenType").split("|");
        specimenRef = "urn:uuid:specimen";
        entries.push({
          fullUrl: specimenRef,
          resource: {
            resourceType: "Specimen",
            meta: { profile: [`${EMR_SD}/InspectionCheckSpecimen`] },
            status: "available",
            type: { coding: [{ system: SCT, code }], text },
            subject: { reference: patientRef },
            collection: {
              collectedDateTime: get("collectedAt") ? toFhirDateTime(get("collectedAt")) : undefined,
              bodySite: get("collectionSite") ? { text: get("collectionSite") } : undefined,
            },
          },
          request: { method: "POST", url: "Specimen" },
        });
      }

      const interpText = { N: "正常", H: "偏高", L: "偏低", A: "異常" }[get("interp")] || "";
      const obsRef = "urn:uuid:observation";
      entries.push({
        fullUrl: obsRef,
        resource: {
          resourceType: "Observation",
          meta: { profile: [`${EMR_SD}/InspectionCheckObservation`] },
          status: "final",
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory", display: "Laboratory" }], text: "Laboratory" }],
          code: { coding: [{ system: LOINC, code: get("panelLoinc") }], text: get("panel") },
          subject: { reference: patientRef },
          encounter: encounterRef ? { reference: encounterRef } : undefined,
          effectiveDateTime: when,
          performer: [{ reference: get("performer") }],
          interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
            code: get("interp") }], text: interpText }],
          specimen: specimenRef ? { reference: specimenRef } : undefined,
          note: get("note") ? [{ text: get("note") }] : undefined,
          component: components,
        },
        request: { method: "POST", url: "Observation" },
      });

      if (get("makeComposition")) {
        const section = [{
          title: "檢驗檢查中的檢驗資料",
          code: { coding: [{ system: LOINC, code: "26436-6" }] },
          entry: [{ reference: obsRef }],
        }];
        if (specimenRef) {
          section.push({
            title: "檢驗檢查中的檢體來源",
            code: { coding: [{ system: LOINC, code: "31208-2" }] },
            entry: [{ reference: specimenRef }],
          });
        }
        entries.push({
          fullUrl: "urn:uuid:composition",
          resource: {
            resourceType: "Composition",
            meta: { profile: [`${EMR_SD}/InspectionCheckComposition`] },
            status: "final",
            type: { coding: [{ system: LOINC, code: "11502-2", display: "Laboratory report" }], text: "檢驗檢查報告" },
            subject: { reference: patientRef },
            encounter: encounterRef ? { reference: encounterRef } : undefined,
            date: toFhirDateTime(),
            author: [{ reference: ORG_REF }, { reference: get("performer") }],
            title: "檢驗檢查報告",
            custodian: { reference: ORG_REF },
            section,
          },
          request: { method: "POST", url: "Composition" },
        });
      }

      const result = await fhir("", { method: "POST", body: { resourceType: "Bundle", type: "transaction", entry: entries } });
      const created = (result.entry || []).map(e => e.response?.location || "");
      const compositionId = (created.find(l => l.startsWith("Composition/")) || "").split("/")[1];
      toast(`已寫入 ${entries.length} 筆 FHIR 資源`);
      location.hash = compositionId
        ? `#/document/${compositionId}`
        : `#/patient/${patientRef.split("/")[1]}/labs`;
    },
  });
}

/* ============================ 交換單張輸入 ============================ */

// 每種單張可納入的章節：LOINC 章節碼、對應資源、預設是否勾選。
const DOC_SPECS = {
  PMR: {
    profile: "PMRComposition", loinc: "34117-2", title: "門診病歷",
    sections: [
      { title: "門診病歷中的病人基本資料_重大傷病", loinc: "11338-1", from: "conditions",
        filter: r => codingCode(r.category?.[0]) === "11338-1" },
      { title: "門診病歷中的病人基本資料_過敏史", loinc: "10155-0", from: "allergies" },
      { title: "門診病歷中的病人基本資料_就醫身分別", loinc: "63513-6", from: "coverages" },
      { title: "門診病歷中的診斷", loinc: "29548-5", from: "conditions",
        filter: r => codingCode(r.category?.[0]) === "29548-5" },
      { title: "門診病歷中的診斷病情摘要_主、客觀描述與評估", loinc: "19824-2", from: "impressions" },
      { title: "門診病歷中的處置項目", loinc: "29554-3", from: "procedures" },
      { title: "門診病歷中的處方內容", loinc: "29549-3", from: "medications" },
      { title: "門診病歷中的實驗室檢查紀錄", loinc: "19146-0", from: "labs" },
    ],
  },
  IC: {
    profile: "InspectionCheckComposition", loinc: "11502-2", title: "檢驗檢查報告",
    sections: [
      { title: "檢驗檢查中的檢驗資料", loinc: "26436-6", from: "labs" },
      { title: "檢驗檢查中的檢體來源", loinc: "31208-2", from: "specimens" },
    ],
  },
  EP: {
    profile: "Composition-EP", loinc: "57833-6", title: "電子處方箋",
    sections: [
      { title: "電子處方箋中的診斷", loinc: "29548-5", from: "conditions" },
      { title: "電子處方箋中的處方內容", loinc: "29549-3", from: "medications" },
      { title: "電子處方箋中的就醫身分別", loinc: "63513-6", from: "coverages" },
    ],
  },
  DMS: {
    profile: "CompositionDMS", loinc: "18842-5", title: "出院病歷摘要",
    sections: [
      { title: "出院病摘中的主訴", loinc: "10154-3", from: "conditions",
        filter: r => codingCode(r.category?.[0]) === "10154-3" },
      { title: "出院病摘中的出院診斷", loinc: "11535-2", from: "conditions",
        filter: r => codingCode(r.category?.[0]) !== "10154-3" },
      { title: "出院病摘中的手術日期及方法", loinc: "10223-6", from: "procedures" },
      { title: "出院病摘中的檢驗", loinc: "26436-6", from: "labs" },
      { title: "出院病摘中的出院指示", loinc: "8653-8", from: "carePlans" },
    ],
  },
  IMG: {
    profile: "ImageComposition", loinc: "18748-4", title: "醫療影像及報告",
    sections: [
      { title: "醫療影像及報告中的病史", loinc: "11329-0", from: "conditions" },
      { title: "醫療影像及報告中的醫學影像內容", loinc: "18748-4", from: "imaging" },
      { title: "醫療影像及報告中的影像診斷結果", loinc: "18782-3", from: "reports" },
    ],
  },
};

function resourceLabel(r, data) {
  switch (r.resourceType) {
    case "Condition":
      return `${codingText(r.code)}　${codingCode(r.code)}　${fmtDate(r.recordedDate)}`;
    case "ClinicalImpression": {
      const code = codingCode(r.code);
      const tag = code === "61150-9" ? "S" : code === "61149-1" ? "O" : "A";
      return `[${tag}] ${(r.description || r.summary || "").slice(0, 46)}`;
    }
    case "MedicationRequest": {
      const med = data.medicationMap.get(refId(r.medicationReference));
      return `${med ? codingText(med.code) : codingText(r.medicationCodeableConcept)}　${r.dosageInstruction?.[0]?.timing?.code?.text || ""}`;
    }
    case "Observation":
      return `${codingText(r.code)}　${fmtDateTime(r.effectiveDateTime || r.effectivePeriod?.start)}　${(r.component || []).length} 項`;
    case "Procedure":
      return `${codingText(r.code)}　${fmtDate(r.performedDateTime)}`;
    case "AllergyIntolerance":
      return `${codingText(r.code)}　${r.criticality === "high" ? "高風險" : r.criticality || ""}`;
    case "Coverage":
      return `就醫身分別：${codingText(r.type)}`;
    case "CarePlan":
      return `${r.title || "照護計畫"}　${fmtDate(r.period?.start)}`;
    case "ImagingStudy":
      return `${r.description || codingText(r.procedureCode?.[0])}　${fmtDate(r.started)}　${r.numberOfInstances ?? "?"} 張`;
    case "DiagnosticReport":
      return `${codingText(r.code)}　${fmtDate(r.issued)}　${r.conclusion ? r.conclusion.slice(0, 30) : ""}`;
    case "Specimen":
      return `${codingText(r.type)}　${fmtDate(r.collection?.collectedDateTime)}`;
    default:
      return `${r.resourceType}/${r.id}`;
  }
}

function newCompositionModal(preset = {}) {
  let chart = null;

  openModal({
    title: "新增電子病歷交換單張",
    sub: "挑選要納入的資料，產生符合 EMR IG 的 Composition，再以 $document 匯出交換 Bundle",
    submitLabel: "產生單張",
    wide: true,
    bodyHtml: `
      <div class="form-section">
        <h3>一、病人與就診 <span class="note">選擇就診後只會列出該次就診的資料</span></h3>
        ${patientPickerHtml({ label: "病人" })}
      </div>

      <div class="form-section">
        <h3>二、單張類型</h3>
        <div class="form-grid">
          ${field("kind", "單張類型", { value: preset.kind || "PMR", options: Object.entries(DOC_SPECS)
            .map(([key, spec]) => ({ value: key, label: `${spec.title}（LOINC ${spec.loinc}）` })) })}
          ${field("author", "撰寫醫師", { options: practitionerOptions(), required: true })}
        </div>
      </div>

      <div class="form-section">
        <h3>三、納入內容 <span class="note">預設全選，可自行勾選</span></h3>
        <div id="sectionPicker">${loading("請先選擇病人…")}</div>
      </div>`,
    onReady: host => {
      const picker = host.querySelector("#sectionPicker");

      function renderSections() {
        if (!chart) {
          picker.innerHTML = `<div class="empty">請先選擇病人</div>`;
          return;
        }
        const kind = host.querySelector('select[name=kind]').value;
        const encounterRef = host.querySelector("#encounterRef")?.value || "";
        const spec = DOC_SPECS[kind];

        const pools = {
          conditions: chart.conditions, impressions: chart.impressions, medications: chart.medications,
          labs: chart.labs, procedures: chart.procedures, allergies: chart.allergies,
          coverages: chart.coverages, carePlans: chart.carePlans, imaging: chart.imaging,
          reports: chart.reports, specimens: chart.specimens,
        };

        const blocks = spec.sections.map((section, index) => {
          let items = pools[section.from] || [];
          if (section.filter) items = items.filter(section.filter);
          // 過敏、就醫身分別這類病人層級的資料不綁就診，其餘依所選就診過濾。
          const patientLevel = ["allergies", "coverages", "specimens"].includes(section.from);
          if (encounterRef && !patientLevel) {
            items = items.filter(r => refId(r.encounter) === encounterRef);
          }
          if (!items.length) {
            return `<div class="form-section" style="border:none;padding:0;margin:0 0 10px">
              <h3 style="font-size:12.5px">${esc(section.title)}
                <span class="note">LOINC ${esc(section.loinc)}</span></h3>
              <div class="muted small" style="padding-left:11px">（無可納入的資料）</div>
            </div>`;
          }
          return `<div class="form-section" style="border:none;padding:0;margin:0 0 12px">
            <h3 style="font-size:12.5px">${esc(section.title)}
              <span class="note">LOINC ${esc(section.loinc)}　${items.length} 筆</span></h3>
            <div style="padding-left:11px">
              ${items.map(r => `
                <label class="check-row" style="padding:2px 0">
                  <input type="checkbox" name="pick" value="${esc(index)}|${esc(r.resourceType)}/${esc(r.id)}" checked>
                  <span>${esc(resourceLabel(r, chart))}</span>
                </label>`).join("")}
            </div>
          </div>`;
        }).join("");

        picker.innerHTML = blocks || `<div class="empty">這位病人沒有可納入的資料</div>`;
      }

      host.querySelector('select[name=kind]').addEventListener("change", renderSections);

      bindPatientPicker(host, {
        initialTerm: preset.patientName || "",
        onChange: async patientRef => {
          if (!patientRef) { chart = null; renderSections(); return; }
          picker.innerHTML = loading("讀取病人資料…");
          try {
            chart = await loadPatientChart(patientRef.split("/")[1]);
            chart.specimens = bundleEntries(await fhir(`/Specimen?subject=${patientRef}&_count=50`)).map(cacheRaw);
          } catch (e) {
            picker.innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
            return;
          }
          renderSections();
        },
      });
    },
    onSubmit: async form => {
      const patientRef = (form.get("patientRef") || "").trim();
      if (!patientRef) throw new Error("請先選擇病人");
      const kind = form.get("kind");
      const spec = DOC_SPECS[kind];
      const encounterRef = (form.get("encounterRef") || "").trim();

      const picked = form.getAll("pick");
      if (!picked.length) throw new Error("請至少勾選一筆要納入單張的資料");

      const grouped = new Map();
      picked.forEach(value => {
        const [index, ref] = value.split("|");
        if (!grouped.has(index)) grouped.set(index, []);
        grouped.get(index).push(ref);
      });

      const section = [...grouped.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([index, refs]) => ({
          title: spec.sections[Number(index)].title,
          code: { coding: [{ system: LOINC, code: spec.sections[Number(index)].loinc }] },
          entry: refs.map(r => ({ reference: r })),
        }));

      const created = await fhir("/Composition", {
        method: "POST",
        body: {
          resourceType: "Composition",
          meta: { profile: [`${EMR_SD}/${spec.profile}`] },
          status: "final",
          type: { coding: [{ system: LOINC, code: spec.loinc }], text: spec.title },
          subject: { reference: patientRef },
          encounter: encounterRef ? { reference: encounterRef } : undefined,
          date: toFhirDateTime(),
          author: [{ reference: ORG_REF }, { reference: form.get("author") }],
          title: spec.title,
          custodian: { reference: ORG_REF },
          section,
        },
      });
      toast(`已產生${spec.title}（${section.length} 個章節、${picked.length} 筆資料）`);
      location.hash = `#/document/${created.id}`;
    },
  });
}

/* ============================ 影像歸戶（Orthanc → FHIR） ============================ */

// 後端 API（同源 /api/），用同一個 Keycloak token。
async function api(path) {
  const r = await fetch(`${window.location.origin}${path}`, {
    headers: { Authorization: `Bearer ${KcAuth.accessToken()}` },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!r.ok) throw new Error(body?.detail || text || `HTTP ${r.status}`);
  return body;
}

function dicomName(raw) {
  // DICOM PN 用 ^ 分隔（姓^名^中間名），中文姓名多半直接放 text。
  return (raw || "").split("=")[0].split("^").filter(Boolean).join("").trim();
}

function dicomDate(raw) {
  if (!raw || raw.length < 8) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

const DICOM_SEX = { M: "male", F: "female", O: "other" };

async function loadLinkedStudyUids() {
  // 一次把已建立的 ImagingStudy 的 Study Instance UID 撈回來，用來標示狀態。
  const bundle = await fhir("/ImagingStudy?_count=500&_elements=identifier,subject");
  const map = new Map();
  for (const s of bundleEntries(bundle)) {
    const uid = (s.identifier || []).find(i => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, "");
    if (uid) map.set(uid, s);
  }
  return map;
}

async function viewLinkImaging() {
  render(`
    <div class="page-head">
      <div><span class="kicker">Orthanc → FHIR</span><h1>影像歸戶</h1></div>
      <div class="page-actions">
        <button class="btn" id="reloadLink">重新整理</button>
        <button class="btn" data-nav="#/imaging">已建立的影像紀錄</button>
      </div>
    </div>
    <section class="card">
      <div class="card-head">
        <h2>PACS 檢查清單 <span class="sub">Orthanc 內的 DICOM 檢查，建立對應的 FHIR ImagingStudy 與影像報告</span></h2>
      </div>
      <div class="card-body tight" id="linkList">${loading()}</div>
    </section>`);
  $("reloadLink").addEventListener("click", loadLinkCandidates);
  loadLinkCandidates();
}

async function loadLinkCandidates() {
  const host = $("linkList");
  host.innerHTML = loading("讀取 Orthanc 檢查清單…");
  try {
    const [data, linked] = await Promise.all([api("/api/imaging/dicom-studies"), loadLinkedStudyUids()]);
    state.dicomStudies = data.studies;
    state.linkedStudies = linked;

    const rows = data.studies.map(s => {
      const existing = linked.get(s.study_instance_uid);
      const patientRef = existing ? refId(existing.subject) : "";
      return `<tr>
        <td class="nowrap">${esc(fmtDate(dicomDate(s.study_date)))}</td>
        <td class="nowrap"><strong>${esc(dicomName(s.dicom_patient.name) || "—")}</strong>
          <div class="muted mono small">${esc(s.dicom_patient.id || "—")}</div></td>
        <td>${esc(s.study_description || "（無檢查描述）")}</td>
        <td class="nowrap">${esc(s.modality || "—")}</td>
        <td class="nowrap">${esc(s.uploaded_by)}</td>
        <td class="mono small">${esc(s.study_instance_uid || "—")}</td>
        <td class="nowrap">${existing
          ? `<span class="pill pill-ok">已建立</span>`
          : `<span class="pill pill-warn">未歸戶</span>`}</td>
        <td class="nowrap right">
          ${existing
            ? `<button class="btn btn-ghost btn-sm" data-nav="#/patient/${esc(patientRef.split("/")[1] || "")}/imaging">病歷</button>`
            : (canWrite()
              ? `<button class="btn btn-primary btn-sm" data-link-study="${esc(s.orthanc_study_id)}">建立 FHIR 影像紀錄</button>`
              : `<span class="muted small">需 fhir-admin</span>`)}
          ${s.ohif_url ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener"
             href="${esc(OHIF_BASE)}/viewer/${encodeURIComponent(s.study_instance_uid)}">OHIF</a>` : ""}
        </td>
      </tr>`;
    }).join("");

    const pending = data.studies.filter(s => !linked.has(s.study_instance_uid)).length;
    host.innerHTML = `
      <div style="padding:10px 14px;border-bottom:1px solid var(--line-soft);font-size:13px">
        共 ${data.studies.length} 筆 DICOM 檢查，其中
        <strong style="color:${pending ? "var(--warn)" : "var(--ok)"}">${pending}</strong> 筆尚未建立 FHIR 影像紀錄。
      </div>
      ${tableShell(["檢查日期", "DICOM 病人", "檢查描述", "Modality", "上傳者", "Study Instance UID", "FHIR 狀態", ""],
        rows, "Orthanc 內沒有檢查")}`;

    host.querySelectorAll("[data-link-study]").forEach(btn =>
      btn.addEventListener("click", () => linkImagingModal(btn.dataset.linkStudy)));
  } catch (e) {
    host.innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

async function linkImagingModal(orthancStudyId) {
  let detail;
  try {
    detail = await api(`/api/imaging/dicom-studies/${encodeURIComponent(orthancStudyId)}`);
  } catch (e) {
    return toast(`讀取檢查明細失敗：${e.message}`, "error");
  }

  const dp = detail.dicom_patient;
  const suggestedName = dicomName(dp.name);
  const suggestedBirth = dicomDate(dp.birth_date);
  const modality = detail.modalities[0] || "OT";

  openModal({
    title: "建立 FHIR 影像紀錄",
    sub: `${detail.study_description || "（無檢查描述）"}　${detail.number_of_series} 系列 / ${detail.number_of_instances} 張影像`,
    submitLabel: "寫入 FHIR",
    wide: true,
    bodyHtml: `
      <div class="dicom-facts">
        <div><b>Study Instance UID</b><span>${esc(detail.study_instance_uid)}</span></div>
        <div><b>檢查時間</b><span>${esc(detail.started || "—")}</span></div>
        <div><b>DICOM 病人</b><span>${esc(suggestedName)} / ${esc(dp.id || "—")}</span></div>
        <div><b>來源機構</b><span>${esc(detail.institution_name || "—")}</span></div>
        <div><b>DICOMweb</b><span>${esc(detail.dicomweb_endpoint)}</span></div>
        <div><b>上傳者</b><span>${esc(detail.uploaded_by)}</span></div>
      </div>

      <div class="form-section">
        <h3>一、對應病人 <span class="note">FHIR Patient</span></h3>
        <div class="radio-row">
          <label><input type="radio" name="patientMode" value="existing" checked> 對應到既有病人</label>
          <label><input type="radio" name="patientMode" value="new"> 依 DICOM 資料建立新病人</label>
        </div>
        <div id="existingPatientBlock" class="form-grid">
          ${field("patientQuery", "搜尋病人", { hint: "輸入姓名 / 病歷號 / 身分證字號後自動查詢" })}
          <div class="field">
            <label for="patientRef">對應病人 *</label>
            <select name="patientRef" id="patientRef"><option value="">（請先搜尋）</option></select>
            <span class="hint" id="patientHint">　</span>
          </div>
          <div class="field wide">
            <label for="encounterRef">關聯就診（選填）</label>
            <select name="encounterRef" id="encounterRef"><option value="">（不指定）</option></select>
          </div>
        </div>
        <div id="newPatientBlock" class="form-grid" hidden>
          ${field("newName", "姓名", { value: suggestedName })}
          ${field("newGender", "性別", { value: DICOM_SEX[dp.sex] || "unknown", options: [
            { value: "male", label: "男" }, { value: "female", label: "女" },
            { value: "other", label: "其他" }, { value: "unknown", label: "不明" }] })}
          ${field("newBirth", "出生日期", { type: "date", value: suggestedBirth })}
          ${field("newMrn", "病歷號", { value: dp.id || "", hint: "預設帶入 DICOM PatientID" })}
          ${field("newNid", "身分證字號", { hint: "選填" })}
        </div>
      </div>

      <div class="form-section">
        <h3>二、檢查資訊 <span class="note">ImagingStudy（EMR IG：ImagingStudyBase）</span></h3>
        <div class="form-grid">
          ${field("procedureName", "檢查項目名稱", { required: true, value: detail.study_description || "" })}
          ${field("procedureCode", "檢查代碼 ICD-10-PCS", { hint: "選填，例：BW03ZZZ" })}
          ${field("bodySite", "檢查部位", { value: detail.series[0]?.body_part || "" })}
          ${field("modality", "Modality", { value: modality, hint: "DICOM 帶入" })}
          ${field("accession", "Accession No.", { value: detail.accession_number || "" })}
          ${field("started", "檢查時間", { type: "datetime-local",
            value: (detail.started || "").slice(0, 16) || nowLocalInput(), required: true })}
        </div>
      </div>

      <div class="form-section">
        <h3>三、影像報告 <span class="note">DiagnosticReport + Observation（可留白，之後再補判讀）</span></h3>
        <div class="form-grid">
          ${field("performer", "報告醫師", { options: [{ value: "", label: "（不指定）" }, ...practitionerOptions()] })}
          ${field("reportStatus", "報告狀態", { options: [
            { value: "final", label: "final 正式報告" },
            { value: "preliminary", label: "preliminary 初步報告" },
            { value: "registered", label: "registered 已登錄未判讀" }] })}
          ${field("findings", "影像所見 Findings", { type: "textarea", wide: true, rows: 4 })}
          ${field("conclusion", "結論 Impression", { type: "textarea", wide: true, rows: 2 })}
        </div>
      </div>

      <div class="form-section">
        <h3>四、交換單張 <span class="note">Composition（醫療影像及報告）</span></h3>
        <label class="check-row">
          <input type="checkbox" name="makeComposition" value="1" checked>
          同時產生「醫療影像及報告」電子病歷交換單張
        </label>
      </div>`,
    onReady: host => {
      const modeInputs = host.querySelectorAll('input[name=patientMode]');
      const existingBlock = host.querySelector("#existingPatientBlock");
      const newBlock = host.querySelector("#newPatientBlock");
      modeInputs.forEach(input => input.addEventListener("change", () => {
        const isNew = host.querySelector('input[name=patientMode]:checked').value === "new";
        existingBlock.hidden = isNew;
        newBlock.hidden = !isNew;
      }));
      // 先用 DICOM 上的病人姓名試著找出對應病人
      bindPatientPicker(host, { initialTerm: suggestedName || "" });
    },
    onSubmit: async form => {
      const get = k => (form.get(k) || "").trim();
      const entries = [];
      let patientRef = get("patientRef");

      if (get("patientMode") === "new") {
        if (!get("newName")) throw new Error("請輸入新病人的姓名");
        patientRef = "urn:uuid:new-patient";
        const identifier = [];
        if (get("newMrn")) {
          identifier.push({
            type: { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }] },
            system: HOSP_SYS, value: get("newMrn"),
          });
        }
        if (get("newNid")) {
          identifier.push({ use: "official", type: { coding: [{ system: V2_0203, code: "NNxxx" }] },
            system: MOI, value: get("newNid") });
        }
        entries.push({
          fullUrl: patientRef,
          resource: {
            resourceType: "Patient",
            meta: { profile: [`${EMR_SD}/PMRPatient`] },
            identifier,
            active: true,
            name: [{ use: "official", text: get("newName") }],
            gender: get("newGender"),
            birthDate: get("newBirth") || undefined,
            managingOrganization: { reference: ORG_REF },
          },
          request: { method: "POST", url: "Patient" },
        });
      } else if (!patientRef) {
        throw new Error("請先選擇要對應的病人");
      }

      // DICOMweb 位址：沿用既有的 Endpoint，沒有就一起建立。
      let endpointRef = state.dicomEndpointRef;
      if (!endpointRef) {
        const found = bundleEntries(await fhir("/Endpoint?_count=10"))
          .find(e => e.address === detail.dicomweb_endpoint);
        if (found) {
          endpointRef = `Endpoint/${found.id}`;
        } else {
          endpointRef = "urn:uuid:new-endpoint";
          entries.push({
            fullUrl: endpointRef,
            resource: {
              resourceType: "Endpoint",
              meta: { profile: [`${EMR_SD}/MitwEndpoint`] },
              status: "active",
              connectionType: {
                system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
                code: "dicom-wado-rs",
              },
              name: "示範醫學中心 DICOMweb",
              managingOrganization: { reference: ORG_REF },
              payloadType: [{ text: "DICOM" }],
              payloadMimeType: ["application/dicom"],
              address: detail.dicomweb_endpoint,
            },
            request: { method: "POST", url: "Endpoint" },
          });
        }
        state.dicomEndpointRef = endpointRef.startsWith("Endpoint/") ? endpointRef : null;
      }

      const started = toFhirDateTime(get("started"));
      const encounterRef = get("encounterRef");
      const procedureCode = get("procedureCode")
        ? [{ coding: [{ system: CS_ICD10PCS, code: get("procedureCode"), display: get("procedureName") }],
             text: get("procedureName") }]
        : [{ text: get("procedureName") }];

      const identifiers = [{
        use: "official",
        type: { coding: [{ system: CS_IMGID, code: "SIUID", display: "Study instance UID" }] },
        system: "urn:dicom:uid",
        value: `urn:oid:${detail.study_instance_uid}`,
      }];
      if (get("accession")) {
        identifiers.push({
          use: "official",
          type: { coding: [{ system: CS_IMGID, code: "ACSN", display: "Accession ID" }] },
          system: HOSP_SYS,
          value: get("accession"),
        });
      }

      const imagingRef = "urn:uuid:imaging-study";
      entries.push({
        fullUrl: imagingRef,
        resource: {
          resourceType: "ImagingStudy",
          meta: { profile: [`${EMR_SD}/ImagingStudyBase`] },
          identifier: identifiers,
          status: "available",
          modality: detail.modalities.map(m => ({
            system: "http://dicom.nema.org/resources/ontology/DCM", code: m,
          })),
          subject: { reference: patientRef },
          encounter: encounterRef ? { reference: encounterRef } : undefined,
          started,
          endpoint: [{ reference: endpointRef }],
          numberOfSeries: detail.number_of_series,
          numberOfInstances: detail.number_of_instances,
          procedureCode,
          description: get("procedureName"),
          series: detail.series.map(s => ({
            uid: s.uid,
            number: s.number || undefined,
            modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: s.modality || "OT" },
            description: s.description || undefined,
            numberOfInstances: s.number_of_instances,
            bodySite: get("bodySite") ? { display: get("bodySite") } : undefined,
            instance: s.instances.filter(i => i.uid).map(i => ({
              uid: i.uid,
              number: i.number || undefined,
              sopClass: { system: "urn:ietf:rfc:3986", code: "urn:oid:1.2.840.10008.5.1.4.1.1.1" },
            })),
          })),
        },
        request: { method: "POST", url: "ImagingStudy" },
      });

      const performer = get("performer") ? [{ reference: get("performer") }] : undefined;
      const reportRefs = [];
      if (get("findings")) {
        const obsRef = "urn:uuid:imaging-observation";
        reportRefs.push(obsRef);
        entries.push({
          fullUrl: obsRef,
          resource: {
            resourceType: "Observation",
            meta: { profile: [`${EMR_SD}/Observation-Imaging-Result`] },
            status: get("reportStatus") === "final" ? "final" : "preliminary",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "imaging", display: "Imaging" }] }],
            code: procedureCode[0],
            subject: { reference: patientRef },
            effectiveDateTime: started,
            performer,
            valueString: get("findings"),
          },
          request: { method: "POST", url: "Observation" },
        });
      }

      const reportRef = "urn:uuid:imaging-report";
      entries.push({
        fullUrl: reportRef,
        resource: {
          resourceType: "DiagnosticReport",
          meta: { profile: [`${EMR_SD}/DiagnosticReport-Image`] },
          identifier: get("accession") ? [{ system: HOSP_SYS, value: get("accession") }] : undefined,
          status: get("reportStatus"),
          category: [{ coding: [{ system: LOINC, code: "LP29684-5", display: "RAD" }] }],
          code: procedureCode[0],
          subject: { reference: patientRef },
          encounter: encounterRef ? { reference: encounterRef } : undefined,
          effectiveDateTime: started,
          issued: toFhirDateTime(),
          performer,
          resultsInterpreter: performer,
          result: reportRefs.map(r => ({ reference: r })),
          imagingStudy: [{ reference: imagingRef }],
          conclusion: get("conclusion") || undefined,
        },
        request: { method: "POST", url: "DiagnosticReport" },
      });

      if (get("makeComposition")) {
        entries.push({
          fullUrl: "urn:uuid:imaging-composition",
          resource: {
            resourceType: "Composition",
            meta: { profile: [`${EMR_SD}/ImageComposition`] },
            status: "final",
            type: { coding: [{ system: LOINC, code: "18748-4", display: "Diagnostic imaging study" }],
                    text: "醫療影像及報告" },
            subject: { reference: patientRef },
            encounter: encounterRef ? { reference: encounterRef } : undefined,
            date: toFhirDateTime(),
            author: [{ reference: ORG_REF }, ...(get("performer") ? [{ reference: get("performer") }] : [])],
            title: "醫療影像及報告",
            custodian: { reference: ORG_REF },
            section: [
              { title: "醫療影像及報告中的醫學影像內容", code: { coding: [{ system: LOINC, code: "18748-4" }] },
                entry: [{ reference: imagingRef }] },
              { title: "醫療影像及報告中的影像診斷結果", code: { coding: [{ system: LOINC, code: "18782-3" }] },
                entry: [{ reference: reportRef }] },
            ],
          },
          request: { method: "POST", url: "Composition" },
        });
      }

      const result = await fhir("", { method: "POST", body: { resourceType: "Bundle", type: "transaction", entry: entries } });
      const created = (result.entry || []).map(e => e.response?.location || "").filter(Boolean);
      const patientId = (created.find(l => l.startsWith("Patient/")) || patientRef).split("/")[1];
      const compositionId = (created.find(l => l.startsWith("Composition/")) || "").split("/")[1];
      toast(`已建立 ${entries.length} 筆 FHIR 資源`);
      location.hash = compositionId ? `#/document/${compositionId}` : `#/patient/${patientId}/imaging`;
    },
  });
}

/* ============================ 交換單張 ============================ */

async function viewDocuments() {
  render(`
    <div class="page-head">
      <div><span class="kicker">Composition</span><h1>電子病歷交換單張</h1></div>
      <div class="page-actions">
        ${canWrite() ? `<button class="btn btn-primary" id="newDocBtn">＋ 新增交換單張</button>` : ""}
        <button class="btn" id="reloadDocs">重新整理</button>
      </div>
    </div>
    <section class="card"><div class="card-body tight" id="docList">${loading()}</div></section>`);
  $("reloadDocs").addEventListener("click", loadDocuments);
  if ($("newDocBtn")) $("newDocBtn").addEventListener("click", () => newCompositionModal());
  loadDocuments();
}

async function loadDocuments() {
  const host = $("docList");
  host.innerHTML = loading();
  try {
    const bundle = await fhir("/Composition?_sort=-date&_count=100&_include=Composition:subject");
    const all = bundleEntries(bundle);
    const patients = new Map(pickByType(all, "Patient").map(p => [`Patient/${p.id}`, cacheRaw(p)]));
    const comps = pickByType(all, "Composition").map(cacheRaw);
    const rows = comps.map(c => {
      const kind = DOC_KINDS[codingCode(c.type)] || { label: codingText(c.type), short: "DOC", cls: "pill-neutral" };
      const p = patients.get(refId(c.subject));
      return `<tr class="is-clickable" data-nav="#/document/${esc(c.id)}">
        <td class="nowrap"><span class="pill ${kind.cls}">${esc(kind.short)}</span> ${esc(kind.label)}</td>
        <td class="nowrap">${esc(fmtDateTime(c.date))}</td>
        <td class="nowrap">${p ? `<strong>${esc(patientName(p))}</strong> <span class="muted mono">${esc(mrnOf(p))}</span>` : esc(refId(c.subject))}</td>
        <td class="nowrap">${esc(c.section?.length || 0)} 章節</td>
        <td class="mono small nowrap">${esc(profileShort(c))}</td>
        <td class="nowrap"><span class="pill ${c.status === "final" ? "pill-ok" : "pill-warn"}">${esc(c.status)}</span></td>
        <td class="nowrap right">${rawButton(c, "FHIR")}</td>
      </tr>`;
    }).join("");
    host.innerHTML = tableShell(
      ["單張類型", "文件日期", "病人", "章節", "Profile", "狀態", ""], rows, "尚無交換單張");
  } catch (e) {
    host.innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

async function viewDocument(id) {
  render(loading("組裝交換文件中…"));
  let bundle;
  try {
    bundle = await fhir(`/Composition/${encodeURIComponent(id)}/$document`);
  } catch (e) {
    render(`<div class="card"><div class="card-body">產生交換文件失敗：${esc(e.message)}</div></div>`);
    return;
  }

  const resources = bundleEntries(bundle);
  const byRef = new Map();
  resources.forEach(r => {
    byRef.set(`${r.resourceType}/${r.id}`, r);
    cacheRaw(r);
  });
  const comp = pickByType(resources, "Composition")[0];
  const patient = pickByType(resources, "Patient")[0];
  const org = pickByType(resources, "Organization")[0];
  pickByType(resources, "Practitioner").forEach(p =>
    state.practitionerMap.set(`Practitioner/${p.id}`, p.name?.[0]?.text || p.id));
  // 文件裡可能有多筆 Encounter（例如檢驗開單），必須抓 Composition 指定的那一筆。
  const enc = byRef.get(refId(comp.encounter)) || pickByType(resources, "Encounter")[0];
  const kind = DOC_KINDS[codingCode(comp.type)] || { label: codingText(comp.type), short: "DOC" };

  const sections = (comp.section || []).map(s => {
    const items = (s.entry || []).map(e => byRef.get(refId(e))).filter(Boolean);
    return `
      <div class="doc-section">
        <h3>${esc(s.title || codingText(s.code))}<span class="loinc">LOINC ${esc(codingCode(s.code))}</span></h3>
        ${items.length ? items.map(r => renderDocResource(r, byRef)).join("") : `<div class="muted small">（無資料）</div>`}
      </div>`;
  }).join("");

  render(`
    <div class="page-head">
      <div><span class="kicker">Bundle · document</span><h1>${esc(kind.label)}</h1></div>
      <div class="page-actions">
        <button class="btn" data-nav="#/documents">← 單張清單</button>
        ${patient ? `<button class="btn" data-nav="#/patient/${esc(patient.id)}/documents">病人病歷</button>` : ""}
        <button class="btn" id="printDoc">列印</button>
        <button class="btn" id="downloadDoc">下載交換 Bundle</button>
        <button class="btn btn-ghost" id="showBundle">檢視 Bundle JSON</button>
      </div>
    </div>

    <article class="doc-sheet">
      <div class="doc-head">
        <div class="org">${esc(org?.name || "示範醫學中心")}</div>
        <h2>${esc(comp.title || kind.label)}</h2>
        <div class="muted small">${esc((comp.meta?.profile || [])[0] || "")}</div>
      </div>

      <div class="doc-meta">
        <div><span class="m-label">病人姓名</span><strong>${esc(patient ? patientName(patient) : "—")}</strong></div>
        <div><span class="m-label">病歷號</span><span class="mono">${esc(patient ? mrnOf(patient) : "—")}</span></div>
        <div><span class="m-label">身分證字號</span><span class="mono">${esc(patient ? nationalIdOf(patient) : "—")}</span></div>
        <div><span class="m-label">性別 / 生日</span>${esc(GENDER[patient?.gender] || "—")} / ${esc(fmtDate(patient?.birthDate))}</div>
        <div><span class="m-label">就診時間</span>${esc(fmtDateTime(enc?.period?.start))}</div>
        <div><span class="m-label">就診科別</span>${esc(codingText(enc?.serviceType))}</div>
        <div><span class="m-label">文件日期</span>${esc(fmtDateTime(comp.date))}</div>
        <div><span class="m-label">文件狀態</span>${esc(comp.status)}</div>
      </div>

      ${sections}

      <div class="doc-foot">
        <span>撰寫：${esc((comp.author || []).map(a => refId(a).startsWith("Practitioner") ? practitionerName(a) : (org?.name || "")).filter(Boolean).join(" · "))}</span>
        <span>Bundle ${esc(bundle.id || "")} · ${resources.length} 筆資源</span>
      </div>
    </article>`);

  $("printDoc").addEventListener("click", () => window.print());
  $("showBundle").addEventListener("click", () => openDrawer(`Bundle/${bundle.id || id}`, bundle));
  $("downloadDoc").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${kind.short}-${comp.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function renderDocResource(r, byRef) {
  const raw = rawButton(r, "FHIR");
  switch (r.resourceType) {
    case "Condition":
      return `<div class="soap-block">
        <strong>${esc(codingText(r.code))}</strong> <code>${esc(codingCode(r.code))}</code>
        <span class="muted small">${esc(fmtDate(r.recordedDate))}</span> ${raw}
        ${r.note?.length ? `<div class="t-body">${esc(r.note.map(n => n.text).join("；"))}</div>` : ""}
      </div>`;
    case "ClinicalImpression": {
      const code = codingCode(r.code);
      const tag = code === "61150-9" ? ["S", ""] : code === "61149-1" ? ["O", "o"] : ["A", "a"];
      return `<div class="soap-block">
        <span class="soap-tag ${tag[1]}">${tag[0]}</span>
        <span style="white-space:pre-wrap">${esc(r.description || r.summary || "—")}</span> ${raw}
      </div>`;
    }
    case "MedicationRequest": {
      const med = byRef.get(refId(r.medicationReference));
      const d = r.dosageInstruction?.[0];
      return `<div class="soap-block">
        <strong>${esc(med ? codingText(med.code) : codingText(r.medicationCodeableConcept))}</strong>
        <span class="muted small mono">${esc(med ? codingCode(med.code) : "")}</span> ${raw}
        <div class="t-body">${esc(d?.timing?.code?.text || "")} · ${esc(codingText(d?.route))} ·
          ${esc(d?.doseAndRate?.[0]?.doseQuantity?.value ?? "")} ${esc(d?.doseAndRate?.[0]?.doseQuantity?.unit || "")}
          · ${esc(r.dispenseRequest?.expectedSupplyDuration?.value ?? "")} 天　${esc(d?.text || "")}</div>
      </div>`;
    }
    case "Observation": {
      if (r.component?.length) {
        const rows = r.component.map(c => {
          const q = c.valueQuantity || {};
          const range = c.referenceRange?.[0]?.text || "";
          const flag = quantityFlag(q.value, range);
          return `<tr><td>${esc(codingText(c.code))}</td>
            <td class="num ${flag.cls}">${esc(q.value ?? c.valueString ?? "—")}</td>
            <td class="muted nowrap">${esc(q.unit || "")}</td>
            <td class="ref-flag nowrap">${esc(range)}</td>
            <td class="nowrap">${flag.badge}</td></tr>`;
        }).join("");
        return `<div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${esc(codingText(r.code))}</strong>
            <span class="muted small">${esc(fmtDateTime(r.effectiveDateTime || r.effectivePeriod?.start))} ${raw}</span>
          </div>
          ${tableShell(["項目", "結果", "單位", "參考值", "判讀"], rows)}
        </div>`;
      }
      return `<div class="soap-block"><strong>${esc(codingText(r.code))}</strong> ${raw}
        <div class="t-body" style="white-space:pre-wrap">${esc(r.valueString || r.valueQuantity?.value || "—")}</div></div>`;
    }
    case "Procedure":
      return `<div class="soap-block"><strong>${esc(codingText(r.code))}</strong>
        <span class="muted small">${esc(fmtDateTime(r.performedDateTime))} · ${esc(practitionerName(r.performer?.[0]?.actor))}</span> ${raw}</div>`;
    case "AllergyIntolerance":
      return `<div class="soap-block"><span class="pill pill-danger">過敏</span>
        <strong>${esc(codingText(r.code))}</strong>
        <span class="muted small">${esc(r.criticality === "high" ? "高風險" : r.criticality || "")}
        ${esc((r.reaction?.[0]?.manifestation || []).map(codingText).join("、"))}</span> ${raw}</div>`;
    case "Coverage":
      return `<div class="soap-block">就醫身分別：<strong>${esc(codingText(r.type))}</strong> ${raw}</div>`;
    case "CarePlan":
      return `<div class="soap-block"><strong>${esc(r.title || "照護計畫")}</strong> ${raw}
        <div class="t-body" style="white-space:pre-wrap">${esc(r.description || "")}</div></div>`;
    case "ImagingStudy": {
      const uid = (r.identifier || []).find(i => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, "") || "";
      return `<div class="soap-block"><strong>${esc(r.description || codingText(r.procedureCode?.[0]))}</strong> ${raw}
        <div class="t-body mono small">Study UID ${esc(uid)} · ${esc(r.numberOfSeries ?? "?")} 系列 / ${esc(r.numberOfInstances ?? "?")} 張
        ${uid ? ` · <a href="${esc(OHIF_BASE)}/viewer/${encodeURIComponent(uid)}" target="_blank" rel="noopener">OHIF 檢視</a>` : ""}</div></div>`;
    }
    case "DiagnosticReport": {
      const results = (r.result || []).map(x => byRef.get(refId(x))).filter(Boolean);
      return `<div class="soap-block"><strong>${esc(codingText(r.code))}</strong>
        <span class="muted small">判讀：${esc(practitionerName(r.resultsInterpreter?.[0]))} · ${esc(fmtDateTime(r.issued))}</span> ${raw}
        ${results.map(o => `<div class="t-body" style="white-space:pre-wrap">${esc(o.valueString || "")}</div>`).join("")}
        ${r.conclusion ? `<div class="t-body"><strong>結論：</strong>${esc(r.conclusion)}</div>` : ""}</div>`;
    }
    case "Specimen":
      return `<div class="soap-block">檢體：<strong>${esc(codingText(r.type))}</strong>
        <span class="muted small">採檢時間 ${esc(fmtDateTime(r.collection?.collectedDateTime))} ·
        部位 ${esc(codingText(r.collection?.bodySite))}</span> ${raw}</div>`;
    default:
      return `<div class="soap-block"><span class="profile-tag">${esc(r.resourceType)}/${esc(r.id)}</span> ${raw}</div>`;
  }
}

/* ============================ 影像 / 檢驗總覽 ============================ */

async function viewImaging() {
  render(`
    <div class="page-head">
      <div><span class="kicker">ImagingStudy · DiagnosticReport</span><h1>醫療影像及報告</h1></div>
      <div class="page-actions">
        <button class="btn btn-primary" data-nav="#/link-imaging">影像歸戶（Orthanc → FHIR）</button>
        <a class="btn" href="${esc(OHIF_BASE)}" target="_blank" rel="noopener">開啟 OHIF Viewer</a>
      </div>
    </div>
    <section class="card"><div class="card-body tight" id="imgList">${loading()}</div></section>`);
  try {
    const bundle = await fhir("/ImagingStudy?_count=100&_include=ImagingStudy:subject&_include=ImagingStudy:endpoint");
    const all = bundleEntries(bundle);
    const patients = new Map(pickByType(all, "Patient").map(p => [`Patient/${p.id}`, cacheRaw(p)]));
    const studies = pickByType(all, "ImagingStudy").map(cacheRaw);
    const rows = studies.map(s => {
      const p = patients.get(refId(s.subject));
      const uid = (s.identifier || []).find(i => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, "") || "";
      return `<tr>
        <td class="nowrap">${esc(fmtDateTime(s.started))}</td>
        <td class="nowrap">${p ? `<strong>${esc(patientName(p))}</strong> <span class="muted mono">${esc(mrnOf(p))}</span>` : esc(refId(s.subject))}</td>
        <td>${esc(s.description || codingText(s.procedureCode?.[0]))}</td>
        <td class="nowrap">${esc((s.modality || []).map(m => m.code).join("/") || "—")}</td>
        <td class="num">${esc(s.numberOfInstances ?? "—")}</td>
        <td class="mono small">${esc(uid || "—")}</td>
        <td class="nowrap right">
          ${uid ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(OHIF_BASE)}/viewer/${encodeURIComponent(uid)}">OHIF</a>` : ""}
          ${p ? `<button class="btn btn-ghost btn-sm" data-nav="#/patient/${esc(p.id)}/imaging">病歷</button>` : ""}
          ${rawButton(s, "FHIR")}
        </td>
      </tr>`;
    }).join("");
    $("imgList").innerHTML = tableShell(
      ["檢查時間", "病人", "檢查項目", "Modality", "影像數", "Study Instance UID", ""], rows, "尚無影像檢查");
  } catch (e) {
    $("imgList").innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

async function viewLabs() {
  render(`
    <div class="page-head">
      <div><span class="kicker">Observation · laboratory</span><h1>檢驗檢查</h1></div>
      <div class="page-actions">
        ${canWrite() ? `<button class="btn btn-primary" id="newLabReportBtn">＋ 新增檢驗報告</button>` : ""}
        <button class="btn" id="reloadLabs">重新整理</button>
      </div>
    </div>
    <section class="card"><div class="card-body tight" id="labList">${loading()}</div></section>`);
  if ($("newLabReportBtn")) $("newLabReportBtn").addEventListener("click", () => newLabReportModal());
  $("reloadLabs").addEventListener("click", viewLabs);
  try {
    const bundle = await fhir("/Observation?category=laboratory&_sort=-date&_count=100&_include=Observation:subject");
    const all = bundleEntries(bundle);
    const patients = new Map(pickByType(all, "Patient").map(p => [`Patient/${p.id}`, cacheRaw(p)]));
    const obs = pickByType(all, "Observation").map(cacheRaw);
    const rows = obs.map(o => {
      const p = patients.get(refId(o.subject));
      const abnormal = (o.component || []).some(c =>
        quantityFlag(c.valueQuantity?.value, c.referenceRange?.[0]?.text).cls);
      return `<tr>
        <td class="nowrap">${esc(fmtDateTime(o.effectiveDateTime || o.effectivePeriod?.start))}</td>
        <td class="nowrap">${p ? `<strong>${esc(patientName(p))}</strong> <span class="muted mono">${esc(mrnOf(p))}</span>` : esc(refId(o.subject))}</td>
        <td>${esc(codingText(o.code))} <code>${esc(codingCode(o.code))}</code></td>
        <td class="num">${esc((o.component || []).length)}</td>
        <td class="nowrap">${abnormal ? `<span class="pill pill-danger">含異常值</span>` : `<span class="pill pill-ok">正常</span>`}</td>
        <td class="nowrap right">
          ${p ? `<button class="btn btn-ghost btn-sm" data-nav="#/patient/${esc(p.id)}/labs">病歷</button>` : ""}
          ${rawButton(o, "FHIR")}
        </td>
      </tr>`;
    }).join("");
    $("labList").innerHTML = tableShell(
      ["檢驗時間", "病人", "檢驗套組", "項目數", "判讀", ""], rows, "尚無檢驗資料");
  } catch (e) {
    $("labList").innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

/* ============================ 伺服器資訊 ============================ */

async function viewServer() {
  render(`
    <div class="page-head">
      <div><span class="kicker">CapabilityStatement</span><h1>伺服器資訊</h1></div>
    </div>
    <div id="serverBody">${loading()}</div>`);

  try {
    const [meta, ...counts] = await Promise.all([
      fhir("/metadata?_summary=true"),
      ...["Patient", "Encounter", "Condition", "Observation", "MedicationRequest",
        "ImagingStudy", "DiagnosticReport", "Composition", "Practitioner"]
        .map(t => fhir(`/${t}?_summary=count`).then(b => [t, b.total]).catch(() => [t, "—"])),
    ]);

    const claims = KcAuth.claims();
    $("serverBody").innerHTML = `
      <div class="grid-2">
        ${cardShell("FHIR 伺服器", "HAPI FHIR JPA Server", `
          <dl class="kv">
            <dt>FHIR 版本</dt><dd>${esc(meta.fhirVersion || "—")}</dd>
            <dt>軟體</dt><dd>${esc(meta.software?.name || "—")} ${esc(meta.software?.version || "")}</dd>
            <dt>同源 FHIR base</dt><dd class="mono">${esc(FHIR_BASE)}</dd>
            <dt>外部 FHIR base</dt><dd class="mono">${esc(window.location.protocol)}//${esc(window.location.hostname)}:18090/fhir</dd>
            <dt>授權方式</dt><dd>Keycloak OIDC Bearer token（Nginx auth_request 閘道）</dd>
          </dl>`)}
        ${cardShell("目前使用者", "Keycloak access token", `
          <dl class="kv">
            <dt>帳號</dt><dd>${esc(claims.preferred_username || "—")}</dd>
            <dt>姓名</dt><dd>${esc(claims.name || "—")}</dd>
            <dt>Realm roles</dt><dd>${KcAuth.roles().map(r => `<span class="pill pill-neutral">${esc(r)}</span>`).join(" ")}</dd>
            <dt>FHIR 權限</dt><dd>${canWrite()
              ? `<span class="pill pill-ok">可讀寫（fhir-admin）</span>`
              : `<span class="pill pill-info">唯讀（fhir-user）</span>`}</dd>
            <dt>Token 到期</dt><dd>${esc(claims.exp ? fmtDateTime(claims.exp * 1000) : "—")}</dd>
          </dl>`)}
      </div>
      ${cardShell("資源統計", "_summary=count",
        tableShell(["資源類型", "筆數"], counts.map(([t, n]) =>
          `<tr><td class="mono">${esc(t)}</td><td class="num">${esc(n)}</td></tr>`).join("")), "", true)}
      ${cardShell("採用規範", "衛生福利部電子病歷交換單張實作指引",
        `<ul style="margin:0;padding-left:20px;line-height:1.9">
          <li>EMR IG：<code>https://twcore.mohw.gov.tw/ig/emr/</code></li>
          <li>門診病歷 PMR · 檢驗檢查 IC · 電子處方箋 EP · 出院病摘 DMS · 醫療影像及報告 Image</li>
          <li>資源皆標註 <code>meta.profile</code>，交換文件以 <code>Composition/$document</code> 產生 document Bundle</li>
        </ul>`)}`;
  } catch (e) {
    $("serverBody").innerHTML = `<div class="card"><div class="empty">讀取失敗：${esc(e.message)}</div></div>`;
  }
}

/* ============================ 啟動 ============================ */

function showGate(message, isError = false) {
  $("app").hidden = true;
  $("gate").hidden = false;
  const box = $("gateMessage");
  box.textContent = message;
  box.classList.toggle("is-error", isError);
}

function showApp() {
  $("gate").hidden = true;
  $("app").hidden = false;
  const claims = KcAuth.claims();
  const name = claims.name || claims.preferred_username || "使用者";
  $("userName").textContent = name;
  $("userAvatar").textContent = name.slice(0, 1).toUpperCase();
  $("userRoles").textContent = KcAuth.roles().filter(r => r.startsWith("fhir") || r === "admin").join(" · ") || "無 FHIR 權限";
  // 管理捷徑：Keycloak 只給 admin，FHIR Server 測試頁只給 fhir-admin（與閘道規則一致）
  const kcLink = $("keycloakAdminLink");
  kcLink.href = `${KcAuth.keycloakBase}/admin/master/console/#/${KcAuth.realm}`;
  kcLink.hidden = !KcAuth.hasRole("admin");
  const fhirLink = $("fhirServerLink");
  fhirLink.href = `${FHIR_SERVER_BASE}/`;
  fhirLink.hidden = !KcAuth.hasRole("admin", "fhir-admin");

  const badge = $("writeBadge");
  badge.textContent = canWrite() ? "可建檔" : "唯讀";
  badge.className = `pill ${canWrite() ? "pill-ok" : "pill-quiet"}`;
}

async function init() {
  $("loginBtn").addEventListener("click", () => KcAuth.login());
  $("logoutBtn").addEventListener("click", () => KcAuth.logout());
  $("drawerClose").addEventListener("click", () => { $("drawer").hidden = true; });
  $("drawerCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("drawerBody").textContent);
      toast("已複製 JSON");
    } catch (_) {
      toast("瀏覽器不允許複製，請手動選取", "warn");
    }
  });
  $("globalSearch").addEventListener("submit", event => {
    event.preventDefault();
    const q = $("globalSearchInput").value.trim();
    location.hash = "#/patients";
    setTimeout(() => {
      const input = document.querySelector("#patientSearch input[name=q]");
      if (input) input.value = q;
      loadPatients(q);
    }, 60);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      $("drawer").hidden = true;
      closeModal();
    }
  });

  try {
    await KcAuth.handleCallback();
  } catch (e) {
    showGate(e.message, true);
    return;
  }

  if (!KcAuth.isAuthenticated()) {
    showGate("請以院內 SSO 帳號登入。");
    return;
  }

  KcAuth.saveCookie();
  if (!KcAuth.hasRole("fhir-user", "fhir-admin", "admin")) {
    showGate(`帳號 ${KcAuth.claims().preferred_username || ""} 沒有電子病歷交換平台的存取權限。\n` +
      "請管理者在 Keycloak 指派 fhir-user（查詢）或 fhir-admin（建檔）角色。", true);
    return;
  }

  showApp();
  SessionGuard.start({
    idleMs: 20 * 60 * 1000,
    warnMs: 2 * 60 * 1000,
    onTouch: () => KcAuth.saveCookie(),
    onExtend: () => KcAuth.refresh(),
    onExpire: reason => {
      SessionGuard.stop();
      KcAuth.clear();
      showGate(`${reason}\n請重新登入。`, true);
    },
  });
  try {
    await ensurePractitioners();
  } catch (e) {
    toast(`讀取醫事人員清單失敗：${e.message}`, "warn");
  }
  window.addEventListener("hashchange", router);
  router();
}

init();
