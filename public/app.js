import {
  lookupDomain,
  lookupDomains,
  clearLookupCache,
  normalizeDomainInput,
} from "./rdap.js";

const MAX_BATCH_SIZE = 100;
const THEME_STORAGE_KEY = "registrarlens-theme";

const elements = {
  root: document.documentElement,
  themeSelect: document.querySelector("#theme-select"),
  themeColor: document.querySelector('meta[name="theme-color"]'),
  lookupPanel: document.querySelector("#lookup-panel"),
  resultsSection: document.querySelector(".results-section"),
  tabButtons: [...document.querySelectorAll('[role="tab"]')],
  tabPanels: [...document.querySelectorAll('[role="tabpanel"]')],
  singleForm: document.querySelector("#single-form"),
  batchForm: document.querySelector("#batch-form"),
  singleInput: document.querySelector("#domain-input"),
  batchInput: document.querySelector("#domains-input"),
  singleError: document.querySelector("#domain-error"),
  batchError: document.querySelector("#domains-error"),
  batchCount: document.querySelector("#domains-count"),
  queryButtons: [...document.querySelectorAll(".query-button")],
  clearCacheButton: document.querySelector("#clear-cache-button"),
  queryProgress: document.querySelector("#query-progress"),
  progressBar: document.querySelector("#progress-bar"),
  progressText: document.querySelector("#progress-text"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  errorState: document.querySelector("#error-state"),
  errorTitle: document.querySelector("#error-title"),
  errorDetail: document.querySelector("#error-detail"),
  resultsSummary: document.querySelector("#results-summary"),
  resultsTableWrapper: document.querySelector("#results-table-wrapper"),
  resultsBody: document.querySelector("#results-body"),
  resultActions: document.querySelector("#result-actions"),
  exportButton: document.querySelector("#export-button"),
  clearResultsButton: document.querySelector("#clear-results-button"),
  notice: document.querySelector("#notice"),
};

const errorMessages = {
  INVALID_DOMAIN: "输入不是有效的域名或网址，也不能是 IP 地址。",
  NO_RDAP_SERVER: "IANA 暂未列出该域名后缀的 RDAP 服务。",
  NOT_FOUND: "权威 RDAP 服务中没有找到该域名记录。",
  TIMEOUT: "RDAP 服务响应超时，请稍后重试。",
  NETWORK_ERROR: "无法连接 RDAP 服务，请检查网络或稍后重试。",
  BOOTSTRAP_HTTP_ERROR: "无法获取 IANA RDAP 服务目录。",
  BOOTSTRAP_INVALID: "IANA RDAP 服务目录响应无效。",
  HTTP_ERROR: "权威 RDAP 服务返回了异常状态。",
  INVALID_RDAP_RESPONSE: "权威 RDAP 服务返回的数据无法解析。",
  FETCH_UNAVAILABLE: "当前浏览器不支持网络查询。",
  ABORTED: "查询已取消。",
};

let currentResults = [];
let isBusy = false;
let noticeTimer = null;
let runSequence = 0;

elements.queryButtons.forEach((button) => {
  button.dataset.idleLabel = button.textContent.trim();
});

function resolvedTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(preference, persist = false) {
  const safePreference = ["system", "light", "dark"].includes(preference)
    ? preference
    : "system";
  const theme = resolvedTheme(safePreference);

  elements.root.dataset.theme = theme;
  elements.root.dataset.themePreference = safePreference;
  elements.themeSelect.value = safePreference;
  elements.themeColor.setAttribute("content", theme === "dark" ? "#0d1517" : "#eef2f3");

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, safePreference);
    } catch (_) {
      showNotice("主题已切换，但浏览器没有开放本地存储权限。");
    }
  }
}

function initializeTheme() {
  const preference = elements.root.dataset.themePreference || "system";
  applyTheme(preference);

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemTheme = () => {
    if (elements.themeSelect.value === "system") applyTheme("system");
  };

  if (typeof colorScheme.addEventListener === "function") {
    colorScheme.addEventListener("change", handleSystemTheme);
  } else if (typeof colorScheme.addListener === "function") {
    colorScheme.addListener(handleSystemTheme);
  }
}

function activateTab(name, moveFocus = false) {
  if (isBusy) return;

  elements.tabButtons.forEach((button) => {
    const selected = button.dataset.tab === name;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) button.focus();
  });

  elements.tabPanels.forEach((panel) => {
    panel.hidden = panel.id !== `${name}-panel`;
  });

  clearFieldError(elements.singleInput, elements.singleError);
  clearFieldError(elements.batchInput, elements.batchError);
}

function handleTabKeydown(event) {
  const supportedKeys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!supportedKeys.includes(event.key)) return;

  event.preventDefault();
  const currentIndex = elements.tabButtons.indexOf(event.currentTarget);
  let nextIndex = currentIndex;

  if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + elements.tabButtons.length) % elements.tabButtons.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % elements.tabButtons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = elements.tabButtons.length - 1;
  }

  activateTab(elements.tabButtons[nextIndex].dataset.tab, true);
}

function batchValues() {
  return elements.batchInput.value
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueDomainInputs(values) {
  const seen = new Set();
  const unique = [];

  values.forEach((value) => {
    let key;
    try {
      key = `domain:${normalizeDomainInput(value)}`;
    } catch (_) {
      key = `invalid:${value.toLocaleLowerCase()}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  });

  return unique;
}

function updateBatchCount() {
  const count = batchValues().length;
  elements.batchCount.textContent = `${count} / ${MAX_BATCH_SIZE}`;
  elements.batchCount.classList.toggle("is-over-limit", count > MAX_BATCH_SIZE);
  elements.batchInput.setAttribute("aria-invalid", String(count > MAX_BATCH_SIZE));

  if (count <= MAX_BATCH_SIZE && !elements.batchError.hidden) {
    clearFieldError(elements.batchInput, elements.batchError);
  }
}

function showFieldError(input, errorElement, message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
  input.setAttribute("aria-invalid", "true");
}

function clearFieldError(input, errorElement) {
  errorElement.textContent = "";
  errorElement.hidden = true;
  input.removeAttribute("aria-invalid");
}

function setProgress(completed, total) {
  const safeTotal = Math.max(1, Number.isFinite(total) ? total : 1);
  const safeCompleted = Math.max(
    0,
    Math.min(safeTotal, Number.isFinite(completed) ? completed : 0),
  );

  elements.progressBar.max = safeTotal;
  elements.progressBar.value = safeCompleted;
  elements.progressBar.textContent = `${Math.round((safeCompleted / safeTotal) * 100)}%`;
  elements.progressText.textContent = `已完成 ${safeCompleted} / ${safeTotal}`;
}

function setBusy(busy, activeButton = null, total = 1) {
  isBusy = busy;
  elements.lookupPanel.setAttribute("aria-busy", String(busy));
  elements.resultsSection.setAttribute("aria-busy", String(busy));
  elements.singleInput.readOnly = busy;
  elements.batchInput.readOnly = busy;
  elements.clearCacheButton.disabled = busy;
  elements.exportButton.disabled = busy;
  elements.clearResultsButton.disabled = busy;

  elements.tabButtons.forEach((button) => {
    button.disabled = busy;
  });

  elements.queryButtons.forEach((button) => {
    button.disabled = busy;
    button.textContent = busy && button === activeButton ? "查询中" : button.dataset.idleLabel;
  });

  elements.queryProgress.hidden = !busy;
  if (busy) setProgress(0, total);
}

function hideResultStates() {
  elements.emptyState.hidden = true;
  elements.loadingState.hidden = true;
  elements.errorState.hidden = true;
  elements.resultsTableWrapper.hidden = true;
}

function showLoadingState(total) {
  hideResultStates();
  elements.loadingState.hidden = false;
  elements.resultActions.hidden = true;
  elements.resultsSummary.textContent = `正在查询 ${total} 个域名`;
}

function showGlobalError(title, detail) {
  currentResults = [];
  hideResultStates();
  elements.errorTitle.textContent = title;
  elements.errorDetail.textContent = detail;
  elements.errorState.hidden = false;
  elements.resultActions.hidden = true;
  elements.resultsSummary.textContent = "查询未完成";
}

function showInitialState() {
  currentResults = [];
  hideResultStates();
  elements.emptyState.hidden = false;
  elements.resultActions.hidden = true;
  elements.resultsSummary.textContent = "还没有查询记录";
  elements.resultsBody.replaceChildren();
}

function showNotice(message) {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    elements.notice.hidden = true;
    elements.notice.textContent = "";
  }, 3600);
}

function stringValue(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function statusesOf(result) {
  if (Array.isArray(result?.statuses)) {
    return result.statuses.map(stringValue).filter(Boolean);
  }
  if (result?.statuses) return [stringValue(result.statuses)];
  return [];
}

function friendlyResultError(result) {
  const code = stringValue(result?.errorCode);
  return errorMessages[code] || stringValue(result?.error) || "查询时发生未知错误。";
}

function displayDate(value) {
  const raw = stringValue(value);
  if (!raw) return "未提供";

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
}

function safeHttpUrl(value) {
  const raw = stringValue(value);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch (_) {
    return null;
  }

  return null;
}

function createCell(label, className = "") {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  if (className) cell.className = className;
  return cell;
}

function appendTextBlock(parent, text, className) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function domainCell(result) {
  const cell = createCell("域名");
  const primary =
    stringValue(result?.domain) ||
    stringValue(result?.queriedDomain) ||
    stringValue(result?.input) ||
    "未提供";
  appendTextBlock(cell, primary, "cell-primary mono");

  const original = stringValue(result?.input);
  if (original && original.toLocaleLowerCase() !== primary.toLocaleLowerCase()) {
    appendTextBlock(cell, `输入: ${original}`, "cell-secondary mono");
  }

  if (result?.cached) {
    const badges = document.createElement("span");
    badges.className = "badges cell-secondary";
    const cached = document.createElement("span");
    cached.className = "badge is-muted";
    cached.textContent = "缓存命中";
    badges.append(cached);
    cell.append(badges);
  }

  return cell;
}

function registrarCell(result) {
  const cell = createCell("注册商");
  if (result?.errorCode) {
    appendTextBlock(cell, "查询失败", "cell-primary");
    appendTextBlock(cell, friendlyResultError(result), "cell-secondary");
    return cell;
  }

  appendTextBlock(cell, stringValue(result?.registrarName) || "未提供", "cell-primary");
  return cell;
}

function ianaCell(result) {
  const cell = createCell("IANA ID", "mono");
  cell.textContent = stringValue(result?.ianaId) || "未提供";
  return cell;
}

function statusCell(result) {
  const cell = createCell("状态");
  const badges = document.createElement("div");
  badges.className = "badges";

  if (result?.errorCode) {
    const errorBadge = document.createElement("span");
    errorBadge.className = "badge is-error";
    errorBadge.textContent = stringValue(result.errorCode) || "ERROR";
    badges.append(errorBadge);
  } else {
    const statuses = statusesOf(result);
    const values = statuses.length > 0 ? statuses : ["未提供"];
    values.forEach((status) => {
      const badge = document.createElement("span");
      badge.className = statuses.length > 0 ? "badge" : "badge is-muted";
      badge.textContent = status;
      badges.append(badge);
    });
  }

  cell.append(badges);
  return cell;
}

function datesCell(result) {
  const cell = createCell("关键日期");
  const list = document.createElement("dl");
  list.className = "date-list";
  const dates = [
    ["注册", result?.registeredAt],
    ["到期", result?.expiresAt],
    ["更新", result?.updatedAt],
  ];

  dates.forEach(([label, value]) => {
    const wrapper = document.createElement("div");
    wrapper.className = "date-item";
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = displayDate(value);
    wrapper.append(term, description);
    list.append(wrapper);
  });

  cell.append(list);
  return cell;
}

function sourceCell(result) {
  const cell = createCell("数据来源");
  const sourceUrl = safeHttpUrl(result?.sourceUrl);

  if (sourceUrl) {
    const link = document.createElement("a");
    link.className = "source-link";
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.textContent = "查看 RDAP 响应";
    cell.append(link);
  } else {
    appendTextBlock(cell, "未提供", "cell-primary");
  }

  const server = stringValue(result?.rdapServer);
  if (server) appendTextBlock(cell, server, "cell-secondary mono");
  return cell;
}

function resultRow(result) {
  const safeResult = result && typeof result === "object" ? result : {
    errorCode: "UNKNOWN_ERROR",
    error: "查询结果格式无效。",
  };
  const row = document.createElement("tr");
  if (safeResult.errorCode) row.classList.add("has-error");
  row.append(
    domainCell(safeResult),
    registrarCell(safeResult),
    ianaCell(safeResult),
    statusCell(safeResult),
    datesCell(safeResult),
    sourceCell(safeResult),
  );
  return row;
}

function renderResults(results, skippedDuplicates = 0) {
  currentResults = Array.isArray(results) ? [...results] : [];
  hideResultStates();
  elements.resultsBody.replaceChildren();

  if (currentResults.length === 0) {
    elements.emptyState.querySelector(".state-label").textContent = "没有结果";
    elements.emptyState.querySelector("h3").textContent = "服务没有返回查询记录";
    elements.emptyState.querySelector("p:last-child").textContent = "请检查输入后重新查询。";
    elements.emptyState.hidden = false;
    elements.resultActions.hidden = true;
    elements.resultsSummary.textContent = "没有可显示的结果";
    return;
  }

  const fragment = document.createDocumentFragment();
  currentResults.forEach((result) => fragment.append(resultRow(result)));
  elements.resultsBody.append(fragment);

  const failed = currentResults.filter((result) => result?.errorCode).length;
  const succeeded = currentResults.length - failed;
  const cached = currentResults.filter((result) => result?.cached).length;
  const parts = [`${currentResults.length} 个查询`, `${succeeded} 个成功`, `${failed} 个失败`];
  if (cached > 0) parts.push(`${cached} 个来自缓存`);
  if (skippedDuplicates > 0) parts.push(`跳过 ${skippedDuplicates} 个重复输入`);

  elements.resultsSummary.textContent = parts.join("，");
  elements.resultsTableWrapper.hidden = false;
  elements.resultActions.hidden = false;
  elements.exportButton.disabled = false;
  elements.clearResultsButton.disabled = false;
}

function csvCell(value) {
  let text = Array.isArray(value) ? value.map(stringValue).join(" | ") : stringValue(value);
  text = text.replace(/\u0000/g, "");

  const trimmed = text.trimStart();
  if (/^[=+\-@]/.test(trimmed) || /^[\t\r\n]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (currentResults.length === 0) {
    showNotice("没有可导出的查询结果。");
    return;
  }

  const headers = [
    "输入",
    "查询域名",
    "返回域名",
    "注册商",
    "IANA ID",
    "状态",
    "注册时间",
    "到期时间",
    "更新时间",
    "RDAP 服务",
    "来源 URL",
    "缓存命中",
    "错误代码",
    "错误说明",
  ];
  const rows = currentResults.map((result) => [
    result?.input,
    result?.queriedDomain,
    result?.domain,
    result?.registrarName,
    result?.ianaId,
    statusesOf(result),
    result?.registeredAt,
    result?.expiresAt,
    result?.updatedAt,
    result?.rdapServer,
    result?.sourceUrl,
    result?.cached ? "是" : "否",
    result?.errorCode,
    result?.error,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);

  link.href = objectUrl;
  link.download = `registrarlens-${date}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  showNotice("CSV 已生成并开始下载。");
}

async function runSingleLookup(event) {
  event.preventDefault();
  if (isBusy) return;

  const input = elements.singleInput.value.trim();
  clearFieldError(elements.singleInput, elements.singleError);

  if (!input) {
    showFieldError(elements.singleInput, elements.singleError, "请输入要查询的域名或网址。");
    elements.singleInput.focus();
    return;
  }

  try {
    normalizeDomainInput(input);
  } catch (_) {
    showFieldError(
      elements.singleInput,
      elements.singleError,
      "请输入有效的域名或网址，不支持 IP 地址。",
    );
    elements.singleInput.focus();
    return;
  }

  const runId = ++runSequence;
  const submitButton = event.submitter || elements.singleForm.querySelector('[type="submit"]');
  currentResults = [];
  setBusy(true, submitButton, 1);
  showLoadingState(1);

  try {
    const result = await lookupDomain(input);
    if (runId !== runSequence) return;
    setProgress(1, 1);
    renderResults([result]);
  } catch (error) {
    if (runId !== runSequence) return;
    showGlobalError("无法完成查询", stringValue(error?.message) || "请稍后重试。");
  } finally {
    if (runId === runSequence) setBusy(false);
  }
}

async function runBatchLookup(event) {
  event.preventDefault();
  if (isBusy) return;

  const values = batchValues();
  clearFieldError(elements.batchInput, elements.batchError);

  if (values.length === 0) {
    showFieldError(elements.batchInput, elements.batchError, "请至少输入一个域名。");
    elements.batchInput.focus();
    return;
  }

  if (values.length > MAX_BATCH_SIZE) {
    showFieldError(
      elements.batchInput,
      elements.batchError,
      `一次最多查询 ${MAX_BATCH_SIZE} 个域名，当前有 ${values.length} 个。`,
    );
    elements.batchInput.focus();
    return;
  }

  const uniqueValues = uniqueDomainInputs(values);
  const skippedDuplicates = values.length - uniqueValues.length;
  const runId = ++runSequence;
  const submitButton = event.submitter || elements.batchForm.querySelector('[type="submit"]');
  currentResults = [];
  setBusy(true, submitButton, uniqueValues.length);
  showLoadingState(uniqueValues.length);

  try {
    const results = await lookupDomains(uniqueValues, {
      concurrency: 3,
      onProgress: ({ completed, total }) => {
        if (runId === runSequence) setProgress(completed, total);
      },
    });
    if (runId !== runSequence) return;
    renderResults(results, skippedDuplicates);
  } catch (error) {
    if (runId !== runSequence) return;
    showGlobalError("无法完成批量查询", stringValue(error?.message) || "请稍后重试。");
  } finally {
    if (runId === runSequence) setBusy(false);
  }
}

elements.themeSelect.addEventListener("change", (event) => {
  applyTheme(event.currentTarget.value, true);
});

elements.tabButtons.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
  button.addEventListener("keydown", handleTabKeydown);
});

elements.singleInput.addEventListener("input", () => {
  clearFieldError(elements.singleInput, elements.singleError);
});

elements.batchInput.addEventListener("input", updateBatchCount);
elements.singleForm.addEventListener("submit", runSingleLookup);
elements.batchForm.addEventListener("submit", runBatchLookup);

elements.clearCacheButton.addEventListener("click", async () => {
  if (isBusy) return;
  elements.clearCacheButton.disabled = true;
  try {
    await Promise.resolve(clearLookupCache());
    showNotice("本地查询缓存已清除。");
  } catch (_) {
    showNotice("无法清除本地查询缓存，请刷新页面后重试。");
  } finally {
    elements.clearCacheButton.disabled = false;
  }
});

elements.exportButton.addEventListener("click", exportCsv);
elements.clearResultsButton.addEventListener("click", showInitialState);

initializeTheme();
updateBatchCount();
activateTab("single");
