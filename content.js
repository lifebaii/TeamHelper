(() => {
  const DEFAULT_TEAM_IDS = [
    "ff598c4d-ccaf-40c1-bfaa-cb94565764b1",
    "47336c9d-7607-4478-b37c-018049af1e46",
    "59208eb6-ec43-4d87-9289-dbd9e250bdd6",
    "2c82c020-e1bc-4363-9502-a6794405f793",
    "9901799e-e832-48b1-9278-9abe73168708",
    "cf8e512d-1f3b-4603-950c-3d9758a8b435",
    "444437a7-c08b-423e-a2c8-65c17383ba24",
    "c72dcdb4-63a0-40b7-b0bb-ccce3ca54984",
    "2b636e76-a87b-4222-b536-2dc4a545109f",
    "4779b1d7-3109-4ecb-957f-80262f4d7161",
    "ae67aa09-f3d3-4895-977d-9ca44ed1d996",
    "6daa08c1-59c8-4e06-9bc8-9d7246a63057",
    "521ffc8f-9612-4950-84ed-95773138eca6"
  ];

  const DB_NAME = "chatgpt-team-helper";
  const DB_VERSION = 1;
  const STORE_TEAMS = "teams";
  const STORE_META = "meta";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let dbPromise;
  let currentOwner = null;
  let rows = [];
  let panel;
  let tbody;
  let accountEl;
  let addInput;
  let joinAllBtn;
  let downloadAllBtn;
  let joinAllActive = false;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TEAMS)) {
          const store = db.createObjectStore(STORE_TEAMS, { keyPath: "key" });
          store.createIndex("ownerKey", "ownerKey", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function txStore(storeName, mode = "readonly") {
    const db = await openDb();
    const tx = db.transaction(storeName, mode);
    return [tx.objectStore(storeName), tx];
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function ownerKeyFromSession(session) {
    const user = session && session.user;
    if (!user) return "anonymous";
    return user.id || user.email || user.name || "anonymous";
  }

  function accountLabel(session) {
    const user = session && session.user;
    const account = session && session.account;
    const userPart = user ? `${user.email || user.name || user.id}` : "未登录";
    const accountPart = account ? `当前 account: ${account.id}` : "未检测到 account";
    return `${userPart} | ${accountPart}`;
  }

  async function getSession() {
    const res = await fetch("https://chatgpt.com/api/auth/session", {
      method: "GET",
      credentials: "include"
    });
    const json = await res.json();
    return { res, json };
  }

  async function loadRows(ownerKey) {
    const [store] = await txStore(STORE_TEAMS);
    const index = store.index("ownerKey");
    const req = index.getAll(ownerKey);
    const records = await promisify(req);
    records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return records;
  }

  async function saveRow(row) {
    row.key = `${row.ownerKey}:${row.teamId}`;
    row.updatedAt = Date.now();
    const [store] = await txStore(STORE_TEAMS, "readwrite");
    await promisify(store.put(row));
  }

  async function deleteRow(row) {
    const [store] = await txStore(STORE_TEAMS, "readwrite");
    await promisify(store.delete(row.key));
  }

  async function getMeta(key) {
    const [store] = await txStore(STORE_META);
    return promisify(store.get(key));
  }

  async function setMeta(key, value) {
    const [store] = await txStore(STORE_META, "readwrite");
    await promisify(store.put({ key, value, updatedAt: Date.now() }));
  }

  function joinAllMetaKey(ownerKey = currentOwner) {
    return `pending-join-all:${ownerKey}`;
  }

  function isJoinedRow(row) {
    return Boolean(row && row.statusType === "ok" && row.lastSession);
  }

  function updateBulkButtons() {
    if (joinAllBtn) {
      joinAllBtn.disabled = joinAllActive || !rows.some((row) => !isJoinedRow(row));
      joinAllBtn.textContent = joinAllActive ? "加入中..." : "加入全部";
    }
    if (downloadAllBtn) {
      downloadAllBtn.disabled = !rows.some(isJoinedRow);
    }
  }

  async function seedDefaultRows(ownerKey) {
    const seededKey = `seeded:${ownerKey}`;
    const seeded = await getMeta(seededKey);
    if (seeded && seeded.value) return;

    const existing = await loadRows(ownerKey);
    const existingIds = new Set(existing.map((row) => row.teamId));
    for (const teamId of DEFAULT_TEAM_IDS) {
      if (existingIds.has(teamId)) continue;
      await saveRow({
        ownerKey,
        teamId,
        status: "未加入",
        statusType: "muted",
        lastMessage: "",
        lastSession: null,
        lastInviteResult: null
      });
    }
    await setMeta(seededKey, true);
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function buildPanel() {
    if (document.getElementById("cth-panel")) return;

    panel = createEl("div");
    panel.id = "cth-panel";

    const header = createEl("div", "cth-header");
    const title = createEl("div", "cth-title", "ChatGPT Team Helper");
    const headerActions = createEl("div", "cth-header-actions");
    const refreshBtn = createButton("刷新", "cth-button", () => initialize());
    const collapseBtn = createButton("收起", "cth-button", () => {
      panel.classList.toggle("cth-collapsed");
      collapseBtn.textContent = panel.classList.contains("cth-collapsed") ? "展开" : "收起";
    });
    headerActions.append(refreshBtn, collapseBtn);
    header.append(title, headerActions);

    const body = createEl("div", "cth-body");
    accountEl = createEl("div", "cth-account", "正在读取 session...");

    const addRow = createEl("div", "cth-add-row");
    addInput = document.createElement("input");
    addInput.placeholder = "Team ID / account id";
    addInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTeamFromInput();
    });
    addRow.append(addInput, createButton("添加", "cth-button cth-primary", addTeamFromInput));

    const bulkRow = createEl("div", "cth-bulk-row");
    joinAllBtn = createButton("加入全部", "cth-button cth-primary", startJoinAll);
    downloadAllBtn = createButton("下载全部 JSON", "cth-button", downloadAllSessionsZip);
    bulkRow.append(joinAllBtn, downloadAllBtn);

    const tableWrap = createEl("div", "cth-table-wrap");
    const table = createEl("table", "cth-table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const name of ["Team ID", "加入状态", "操作"]) {
      headerRow.append(createEl("th", "", name));
    }
    thead.append(headerRow);
    tbody = document.createElement("tbody");
    table.append(thead, tbody);
    tableWrap.append(table);

    const footer = createEl(
      "div",
      "cth-footer",
      "Session JSON 含敏感凭证；下载文件只在本机生成，不会上传。"
    );

    body.append(accountEl, addRow, bulkRow, tableWrap, footer);
    panel.append(header, body);
    document.documentElement.append(panel);
    makeDraggable(panel, header);
  }

  function createButton(text, className, onClick) {
    const btn = createEl("button", className || "cth-button", text);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderRows() {
    tbody.replaceChildren();
    updateBulkButtons();
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = createEl("td", "cth-muted", "暂无 Team ID");
      td.colSpan = 3;
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement("tr");
      const idTd = createEl("td", "cth-team-id", row.teamId);
      const statusTd = createEl("td", `cth-status cth-${row.statusType || "muted"}`);
      statusTd.append(document.createTextNode(row.status || "未加入"));
      if (row.lastMessage) {
        statusTd.append(createEl("small", "", row.lastMessage));
      }

      const actionTd = createEl("td");
      const actions = createEl("div", "cth-row-actions");
      const primaryActions = createEl("div", "cth-action-line");
      const downloadActions = createEl("div", "cth-action-line");
      const switchBtn = createButton("切换", "cth-button", () => switchTeam(row.teamId));
      switchBtn.disabled = !isJoinedRow(row);
      const joinBtn = createButton("加入", "cth-button cth-primary", () => joinTeam(row.teamId));
      const downloadBtn = createButton("下载 session", "cth-button", () => downloadSession(row));
      downloadBtn.disabled = !row.lastSession;
      const downloadCpaBtn = createButton("下载 CPA", "cth-button", () => downloadCpa(row));
      downloadCpaBtn.disabled = !row.lastSession;
      const removeBtn = createButton("删除", "cth-button cth-danger", async () => {
        await deleteRow(row);
        await refreshRows();
      });
      primaryActions.append(switchBtn, joinBtn, removeBtn);
      downloadActions.append(downloadBtn, downloadCpaBtn);
      actions.append(primaryActions, downloadActions);
      actionTd.append(actions);

      tr.append(idTd, statusTd, actionTd);
      tbody.append(tr);
    }
  }

  async function addTeamFromInput() {
    const teamId = addInput.value.trim();
    if (!UUID_RE.test(teamId)) {
      addInput.focus();
      addInput.select();
      return;
    }
    if (!currentOwner) await initialize();
    await saveRow({
      ownerKey: currentOwner,
      teamId,
      status: "未加入",
      statusType: "muted",
      lastMessage: "",
      lastSession: null,
      lastInviteResult: null
    });
    addInput.value = "";
    await refreshRows();
  }

  async function updateRow(teamId, patch) {
    const existing = rows.find((row) => row.teamId === teamId) || {
      ownerKey: currentOwner,
      teamId
    };
    const next = { ...existing, ...patch };
    await saveRow(next);
    rows = rows.map((row) => (row.teamId === teamId ? next : row));
    if (!rows.some((row) => row.teamId === teamId)) rows.unshift(next);
    renderRows();
  }

  async function joinTeam(teamId, options = {}) {
    try {
      await updateRow(teamId, {
        status: "读取 session...",
        statusType: "pending",
        lastMessage: ""
      });

      const { res: sessionRes, json: session } = await getSession();
      if (!sessionRes.ok || !session.accessToken) {
        throw new Error(`未获取 accessToken，session status=${sessionRes.status}`);
      }

      await updateRow(teamId, {
        status: "发送邀请请求...",
        statusType: "pending"
      });

      const inviteRes = await fetch(`https://chatgpt.com/backend-api/accounts/${teamId}/invites/request`, {
        method: "POST",
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9",
          authorization: `Bearer ${session.accessToken}`,
          "cache-control": "no-cache",
          "oai-language": "en-US",
          pragma: "no-cache"
        },
        referrer: "https://chatgpt.com/k12-verification",
        referrerPolicy: "strict-origin-when-cross-origin",
        credentials: "include",
        mode: "cors"
      });

      const inviteText = await inviteRes.text();
      const inviteBody = parseMaybeJson(inviteText);
      if (!inviteRes.ok) {
        throw new Error(`邀请请求失败 status=${inviteRes.status} ${stringifyShort(inviteBody)}`);
      }

      await updateRow(teamId, {
        status: "请求成功，正在切换...",
        statusType: "pending",
        lastMessage: stringifyShort(inviteBody),
        lastInviteResult: {
          status: inviteRes.status,
          body: inviteBody,
          updatedAt: Date.now()
        }
      });

      await setMeta(`pending-switch:${currentOwner}`, {
        teamId,
        mode: options.mode || "single",
        startedAt: Date.now()
      });

      document.cookie = `_account=${teamId}; Path=/; SameSite=Lax; Secure`;
      location.href = "https://chatgpt.com/?refresh_account=true";
    } catch (error) {
      await updateRow(teamId, {
        status: "失败",
        statusType: "error",
        lastMessage: error && error.message ? error.message : String(error)
      });
      if (options.mode === "join-all") {
        await continueJoinAll();
      }
    }
  }

  async function switchTeam(teamId) {
    await updateRow(teamId, {
      status: "正在切换...",
      statusType: "pending",
      lastMessage: ""
    });
    await setMeta(`pending-switch:${currentOwner}`, {
      teamId,
      mode: "switch",
      startedAt: Date.now()
    });
    document.cookie = `_account=${teamId}; Path=/; SameSite=Lax; Secure`;
    location.href = "https://chatgpt.com/?refresh_account=true";
  }

  async function recordJoinAllResult(ownerKey, teamId, switched) {
    const record = await getMeta(joinAllMetaKey(ownerKey));
    const state = record && record.value ? record.value : { active: true, startedAt: Date.now() };
    const completedTeamIds = new Set(state.completedTeamIds || []);
    const failedTeamIds = new Set(state.failedTeamIds || []);
    if (switched) {
      completedTeamIds.add(teamId);
      failedTeamIds.delete(teamId);
    } else {
      failedTeamIds.add(teamId);
    }

    const nextState = {
      ...state,
      active: true,
      currentTeamId: null,
      completedTeamIds: Array.from(completedTeamIds),
      failedTeamIds: Array.from(failedTeamIds),
      updatedAt: Date.now()
    };
    await setMeta(joinAllMetaKey(ownerKey), nextState);
    return nextState;
  }

  async function startJoinAll() {
    if (!currentOwner || joinAllActive) return;
    joinAllActive = true;
    updateBulkButtons();
    await setMeta(joinAllMetaKey(), {
      active: true,
      startedAt: Date.now(),
      processedTeamIds: [],
      completedTeamIds: [],
      failedTeamIds: []
    });
    await continueJoinAll();
  }

  async function continueJoinAll() {
    const record = await getMeta(joinAllMetaKey());
    const state = record && record.value;
    joinAllActive = Boolean(state && state.active);
    if (!joinAllActive) {
      updateBulkButtons();
      return;
    }

    rows = await loadRows(currentOwner);
    const processedTeamIds = new Set(state.processedTeamIds || []);
    const nextRow = rows.find((row) => !isJoinedRow(row) && !processedTeamIds.has(row.teamId));
    if (!nextRow) {
      await setMeta(joinAllMetaKey(), null);
      joinAllActive = false;
      renderRows();
      downloadAllSessionsZip();
      return;
    }

    processedTeamIds.add(nextRow.teamId);
    await setMeta(joinAllMetaKey(), {
      ...state,
      active: true,
      currentTeamId: nextRow.teamId,
      processedTeamIds: Array.from(processedTeamIds),
      updatedAt: Date.now()
    });
    renderRows();
    await joinTeam(nextRow.teamId, { mode: "join-all" });
  }

  async function finalizePendingSwitch(ownerKey, session) {
    const metaKey = `pending-switch:${ownerKey}`;
    const pending = await getMeta(metaKey);
    const value = pending && pending.value;
    if (!value || !value.teamId) return;

    const switched = session && session.account && session.account.id === value.teamId;
    const isSwitchOnly = value.mode === "switch";
    await updateRow(value.teamId, {
      status: switched ? (isSwitchOnly ? "已切换成功" : "已加入并切换成功") : (isSwitchOnly ? "切换失败" : "请求成功，未切换到该 Team"),
      statusType: switched ? "ok" : value.mode === "join-all" || isSwitchOnly ? "error" : "pending",
      lastMessage: switched ? "session account 已匹配" : `当前 account: ${session.account ? session.account.id : "unknown"}`,
      lastSession: session,
      completedAt: Date.now()
    });
    await setMeta(metaKey, null);

    if (value.mode === "join-all") {
      await recordJoinAllResult(ownerKey, value.teamId, switched);
      await continueJoinAll();
    }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < table.length; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  }

  const CRC_TABLE = makeCrcTable();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    return {
      date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    };
  }

  function setZipHeaderValue(view, offset, byteLength, value) {
    if (byteLength === 2) {
      view.setUint16(offset, value, true);
      return;
    }
    view.setUint32(offset, value >>> 0, true);
  }

  function makeZip(entries) {
    const encoder = new TextEncoder();
    const fileParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const contentBytes = encoder.encode(entry.content);
      const checksum = crc32(contentBytes);
      const { date, time } = dosDateTime(new Date());

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      setZipHeaderValue(localView, 0, 4, 0x04034b50);
      setZipHeaderValue(localView, 4, 2, 20);
      setZipHeaderValue(localView, 6, 2, 0x0800);
      setZipHeaderValue(localView, 8, 2, 0);
      setZipHeaderValue(localView, 10, 2, time);
      setZipHeaderValue(localView, 12, 2, date);
      setZipHeaderValue(localView, 14, 4, checksum);
      setZipHeaderValue(localView, 18, 4, contentBytes.length);
      setZipHeaderValue(localView, 22, 4, contentBytes.length);
      setZipHeaderValue(localView, 26, 2, nameBytes.length);
      localHeader.set(nameBytes, 30);
      fileParts.push(localHeader, contentBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      setZipHeaderValue(centralView, 0, 4, 0x02014b50);
      setZipHeaderValue(centralView, 4, 2, 20);
      setZipHeaderValue(centralView, 6, 2, 20);
      setZipHeaderValue(centralView, 8, 2, 0x0800);
      setZipHeaderValue(centralView, 10, 2, 0);
      setZipHeaderValue(centralView, 12, 2, time);
      setZipHeaderValue(centralView, 14, 2, date);
      setZipHeaderValue(centralView, 16, 4, checksum);
      setZipHeaderValue(centralView, 20, 4, contentBytes.length);
      setZipHeaderValue(centralView, 24, 4, contentBytes.length);
      setZipHeaderValue(centralView, 28, 2, nameBytes.length);
      setZipHeaderValue(centralView, 42, 4, offset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + contentBytes.length;
    }

    const centralOffset = offset;
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const endHeader = new Uint8Array(22);
    const endView = new DataView(endHeader.buffer);
    setZipHeaderValue(endView, 0, 4, 0x06054b50);
    setZipHeaderValue(endView, 8, 2, entries.length);
    setZipHeaderValue(endView, 10, 2, entries.length);
    setZipHeaderValue(endView, 12, 4, centralSize);
    setZipHeaderValue(endView, 16, 4, centralOffset);

    return new Blob([...fileParts, ...centralParts, endHeader], { type: "application/zip" });
  }

  function parseMaybeJson(text) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  function stringifyShort(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  }

  function downloadSession(row) {
    if (!row.lastSession) return;
    downloadJson(row.lastSession, `chatgpt-session-${row.teamId}-${timestampToken()}.json`);
  }

  function downloadCpa(row) {
    if (!row.lastSession) return;
    try {
      const cpa = convertSessionToCpa(row.lastSession);
      downloadJson(cpa, `chatgpt-cpa-${row.teamId}-${timestampToken()}.json`);
    } catch (error) {
      updateRow(row.teamId, {
        status: "CPA 转换失败",
        statusType: "error",
        lastMessage: error && error.message ? error.message : String(error)
      });
    }
  }

  function downloadAllSessionsZip() {
    const joinedRows = rows.filter(isJoinedRow);
    if (!joinedRows.length) return;

    const entries = joinedRows.map((row) => ({
      name: `chatgpt-session-${row.teamId}.json`,
      content: JSON.stringify(row.lastSession, null, 2)
    }));
    const zip = makeZip(entries);
    downloadBlob(zip, `chatgpt-sessions-${timestampToken()}.zip`);
  }

  function downloadJson(value, fileName) {
    const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json"
    });
    downloadBlob(blob, fileName);
  }

  function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-");
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
    return undefined;
  }

  function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function encodeBase64UrlJson(value) {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  }

  function parseJwtPayload(token) {
    if (typeof token !== "string" || token.trim() === "") {
      return undefined;
    }
    const segments = token.split(".");
    if (segments.length < 2) {
      return undefined;
    }
    try {
      return JSON.parse(decodeBase64Url(segments[1]));
    } catch {
      return undefined;
    }
  }

  function getOpenAIAuthSection(payload) {
    if (!isPlainObject(payload)) return {};
    const auth = payload["https://api.openai.com/auth"];
    return isPlainObject(auth) ? auth : {};
  }

  function getOpenAIProfileSection(payload) {
    if (!isPlainObject(payload)) return {};
    const profile = payload["https://api.openai.com/profile"];
    return isPlainObject(profile) ? profile : {};
  }

  function normalizeTimestamp(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value > 1e11 ? value : value * 1000;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  function timestampFromUnixSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    const date = new Date(numeric * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  function epochSecondsFromValue(value) {
    if (value === undefined || value === null || value === "") {
      return 0;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
  }

  function buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt) {
    if (!accountId) {
      return undefined;
    }
    const now = Math.trunc(Date.now() / 1000);
    const authInfo = { chatgpt_account_id: accountId };
    const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;

    if (planType) {
      authInfo.chatgpt_plan_type = planType;
    }
    if (userId) {
      authInfo.chatgpt_user_id = userId;
      authInfo.user_id = userId;
    }

    const payload = {
      iat: now,
      exp: expires,
      "https://api.openai.com/auth": authInfo
    };
    if (email) {
      payload.email = email;
    }

    return `${encodeBase64UrlJson({ alg: "none", typ: "JWT", cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`;
  }

  function compactObject(value) {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
    );
  }

  function convertSessionToCpa(record) {
    if (!isPlainObject(record)) {
      throw new Error("session 不是 JSON 对象");
    }

    const accessToken = firstNonEmpty(
      record.accessToken,
      record.access_token,
      record.tokens && record.tokens.accessToken,
      record.tokens && record.tokens.access_token,
      record.token && record.token.accessToken,
      record.token && record.token.access_token,
      record.credentials && record.credentials.accessToken,
      record.credentials && record.credentials.access_token
    );
    if (!accessToken) {
      throw new Error("缺少 accessToken");
    }

    const sessionToken = firstNonEmpty(
      record.sessionToken,
      record.session_token,
      record.tokens && record.tokens.sessionToken,
      record.tokens && record.tokens.session_token,
      record.token && record.token.sessionToken,
      record.token && record.token.session_token,
      record.credentials && record.credentials.session_token
    );
    const refreshToken = firstNonEmpty(
      record.refreshToken,
      record.refresh_token,
      record.tokens && record.tokens.refreshToken,
      record.tokens && record.tokens.refresh_token,
      record.token && record.token.refreshToken,
      record.token && record.token.refresh_token,
      record.credentials && record.credentials.refresh_token
    );
    const inputIdToken = firstNonEmpty(
      record.idToken,
      record.id_token,
      record.tokens && record.tokens.idToken,
      record.tokens && record.tokens.id_token,
      record.token && record.token.idToken,
      record.token && record.token.id_token,
      record.credentials && record.credentials.id_token
    );

    const payload = parseJwtPayload(accessToken);
    const idPayload = parseJwtPayload(inputIdToken);
    const auth = getOpenAIAuthSection(payload);
    const idAuth = getOpenAIAuthSection(idPayload);
    const profile = getOpenAIProfileSection(payload);
    const expiresAt = refreshToken ? undefined : firstNonEmpty(
      payload ? timestampFromUnixSeconds(payload.exp) : undefined,
      normalizeTimestamp(record.expires),
      normalizeTimestamp(record.expiresAt),
      normalizeTimestamp(record.expired),
      normalizeTimestamp(record.expires_at)
    );
    const email = firstNonEmpty(
      record.user && record.user.email,
      record.email,
      record.meta && record.meta.label,
      record.label,
      record.credentials && record.credentials.email,
      record.providerSpecificData && record.providerSpecificData.email,
      profile.email,
      idPayload && idPayload.email,
      payload && payload.email
    );
    const accountId = firstNonEmpty(
      record.account && record.account.id,
      record.account_id,
      record.tokens && record.tokens.accountId,
      record.tokens && record.tokens.account_id,
      record.chatgptAccountId,
      record.chatgpt_account_id,
      record.meta && record.meta.chatgptAccountId,
      record.meta && record.meta.chatgpt_account_id,
      record.tokens && record.tokens.chatgptAccountId,
      record.tokens && record.tokens.chatgpt_account_id,
      record.providerSpecificData && record.providerSpecificData.chatgptAccountId,
      record.providerSpecificData && record.providerSpecificData.chatgpt_account_id,
      record.credentials && record.credentials.chatgpt_account_id,
      auth.chatgpt_account_id,
      idAuth.chatgpt_account_id,
      record.provider === "codex" ? record.id : undefined
    );
    const userId = firstNonEmpty(
      record.user && record.user.id,
      record.user_id,
      record.chatgptUserId,
      record.providerSpecificData && record.providerSpecificData.chatgptUserId,
      record.providerSpecificData && record.providerSpecificData.chatgpt_user_id,
      auth.chatgpt_user_id,
      auth.user_id,
      idAuth.chatgpt_user_id,
      idAuth.user_id
    );
    const planType = firstNonEmpty(
      record.account && record.account.planType,
      record.account && record.account.plan_type,
      record.planType,
      record.plan_type,
      record.providerSpecificData && record.providerSpecificData.chatgptPlanType,
      record.providerSpecificData && record.providerSpecificData.chatgpt_plan_type,
      record.credentials && record.credentials.plan_type,
      auth.chatgpt_plan_type,
      idAuth.chatgpt_plan_type
    );
    const exportedAt = normalizeTimestamp(new Date());
    const name = firstNonEmpty(email, "ChatGPT Account");
    const syntheticIdToken = !inputIdToken
      ? buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt)
      : undefined;
    const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

    return compactObject({
      type: "codex",
      account_id: accountId,
      chatgpt_account_id: accountId,
      email,
      name,
      plan_type: planType,
      chatgpt_plan_type: planType,
      id_token: idToken,
      id_token_synthetic: Boolean(syntheticIdToken) || undefined,
      access_token: accessToken,
      refresh_token: refreshToken || "",
      session_token: sessionToken,
      last_refresh: exportedAt,
      expired: expiresAt,
      disabled: Boolean(record.disabled) || undefined
    });
  }

  async function refreshRows() {
    rows = await loadRows(currentOwner);
    renderRows();
  }

  async function initialize() {
    buildPanel();
    try {
      const { res, json: session } = await getSession();
      if (!res.ok) throw new Error(`session status=${res.status}`);
      currentOwner = ownerKeyFromSession(session);
      accountEl.textContent = accountLabel(session);
      await seedDefaultRows(currentOwner);
      rows = await loadRows(currentOwner);
      const joinAllRecord = await getMeta(joinAllMetaKey(currentOwner));
      joinAllActive = Boolean(joinAllRecord && joinAllRecord.value && joinAllRecord.value.active);
      renderRows();
      await finalizePendingSwitch(currentOwner, session);
    } catch (error) {
      accountEl.textContent = `读取 session 失败：${error && error.message ? error.message : String(error)}`;
      accountEl.classList.add("cth-error");
    }
  }

  function makeDraggable(target, handle) {
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startTop = 0;
    let dragging = false;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target && event.target.closest("button")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = target.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const nextRight = Math.max(0, Math.min(window.innerWidth - 80, startRight - (event.clientX - startX)));
      const nextTop = Math.max(0, Math.min(window.innerHeight - 48, startTop + (event.clientY - startY)));
      target.style.right = `${nextRight}px`;
      target.style.top = `${nextTop}px`;
    });

    handle.addEventListener("pointerup", () => {
      dragging = false;
    });
  }

  initialize();
})();
