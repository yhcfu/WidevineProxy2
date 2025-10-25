import "../protobuf.min.js";
import "../license_protocol.js";
import {AsyncLocalStorage, base64toUint8Array, stringToUint8Array, DeviceManager, RemoteCDMManager, SettingsManager} from "../util.js";

const key_container = document.getElementById('key-container');
const host_status_indicator = document.getElementById('host-status-indicator');
const host_status_message = document.getElementById('host-status-message');
const host_retry_button = document.getElementById('host-retry');
if (host_retry_button) {
    host_retry_button.hidden = true;
}
let hostStatusErrorLocked = false;
let lastHostErrorMessage = "";
const HOST_JOB_STORAGE_KEY = "native_jobs";
const jobListContainer = document.getElementById('native-jobs-list');
const jobState = new Map();
const JOB_RENDER_DEBOUNCE_MS = 200;
const JOB_CARD_DISPLAY_LIMIT = 40;
const JOB_HISTORY_WINDOW_DAYS = 2;
const JOB_HISTORY_WINDOW_MS = JOB_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PANEL_CONCURRENCY_LIMIT = 5;
let jobRenderTimer = null;
const toastContainer = document.getElementById('toast-container');
const completedToastJobs = new Set();
const TOAST_DISMISS_DURATION = 6000;
const commandPreviewExpansion = new Map();
const JOB_STAGE_LABELS = {
    queued: "待機中",
    pending: "待機中",
    preparing: "初期化中",
    downloading: "DL中",
    decrypting: "復号中",
    muxing: "結合中",
    completed: "完了",
    failed: "失敗",
    waiting: "枠待ち",
    cancelling: "停止処理中",
    cancelled: "キャンセル済"
};
const RETRYABLE_STATUSES = new Set(["failed", "error"]);
const REMOVABLE_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CANCELLABLE_STATUSES = new Set([
    "queued",
    "pending",
    "preparing",
    "downloading",
    "decrypting",
    "muxing",
    "waiting",
    "cancelling"
]);
const jobFilterButtons = document.querySelectorAll('[data-job-filter]');
const jobHistoryToggle = document.getElementById('job-history-toggle');
const jobHistoryHint = document.getElementById('job-history-hint');
let jobDateFilter = 'today';
let showExtendedHistory = false;

jobFilterButtons.forEach((button) => {
    button.addEventListener('click', () => {
        jobFilterButtons.forEach((entry) => {
            entry.classList.toggle('job-filter__button--active', entry === button);
        });
        jobDateFilter = button.dataset.jobFilter || 'today';
        scheduleJobRender();
    });
});

if (jobHistoryToggle) {
    jobHistoryToggle.addEventListener('click', () => {
        showExtendedHistory = !showExtendedHistory;
        jobHistoryToggle.textContent = showExtendedHistory ? '最近のみ表示' : '過去分も表示';
        scheduleJobRender();
    });
}


function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response?.error) {
                reject(new Error(response.error));
                return;
            }
            resolve(response);
        });
    });
}

function fireAndForgetMessage(payload) {
    try {
        const maybePromise = chrome.runtime.sendMessage(payload);
        if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch((error) => {
                console.debug("fireAndForgetMessage rejected", error);
            });
        }
    } catch (error) {
        console.debug("fireAndForgetMessage failed", error);
    }
}


// ================ Main ================
const enabled = document.getElementById('enabled');
enabled.addEventListener('change', async function (){
    await SettingsManager.setEnabled(enabled.checked);
});

const toggle = document.getElementById('darkModeToggle');
toggle.addEventListener('change', async () => {
    await SettingsManager.setDarkMode(toggle.checked);
    await SettingsManager.saveDarkMode(toggle.checked);
});

const wvd_select = document.getElementById('wvd_select');
wvd_select.addEventListener('change', async function (){
    if (wvd_select.checked) {
        await SettingsManager.saveSelectedDeviceType("WVD");
    }
});

const remote_select = document.getElementById('remote_select');
remote_select.addEventListener('change', async function (){
    if (remote_select.checked) {
        await SettingsManager.saveSelectedDeviceType("REMOTE");
    }
});

const export_button = document.getElementById('export');
export_button.addEventListener('click', async function() {
    const logs = await AsyncLocalStorage.getStorage(null);
    SettingsManager.downloadFile(stringToUint8Array(JSON.stringify(logs)), "logs.json");
});
// ======================================

// ================ Widevine Device ================
document.getElementById('fileInput').addEventListener('click', () => {
    fireAndForgetMessage({ type: "OPEN_PICKER_WVD" });
    window.close();
});

const remove = document.getElementById('remove');
remove.addEventListener('click', async function() {
    await DeviceManager.removeSelectedWidevineDevice();
    wvd_combobox.innerHTML = '';
    await DeviceManager.loadSetAllWidevineDevices();
    const selected_option = wvd_combobox.options[wvd_combobox.selectedIndex];
    if (selected_option) {
        await DeviceManager.saveSelectedWidevineDevice(selected_option.text);
    } else {
        await DeviceManager.removeSelectedWidevineDeviceKey();
    }
});

const download = document.getElementById('download');
download.addEventListener('click', async function() {
    const widevine_device = await DeviceManager.getSelectedWidevineDevice();
    SettingsManager.downloadFile(
        base64toUint8Array(await DeviceManager.loadWidevineDevice(widevine_device)),
        widevine_device + ".wvd"
    )
});

const wvd_combobox = document.getElementById('wvd-combobox');
wvd_combobox.addEventListener('change', async function() {
    await DeviceManager.saveSelectedWidevineDevice(wvd_combobox.options[wvd_combobox.selectedIndex].text);
});
// =================================================

// ================ Remote CDM ================
document.getElementById('remoteInput').addEventListener('click', () => {
    fireAndForgetMessage({ type: "OPEN_PICKER_REMOTE" });
    window.close();
});

const remote_remove = document.getElementById('remoteRemove');
remote_remove.addEventListener('click', async function() {
    await RemoteCDMManager.removeSelectedRemoteCDM();
    remote_combobox.innerHTML = '';
    await RemoteCDMManager.loadSetAllRemoteCDMs();
    const selected_option = remote_combobox.options[remote_combobox.selectedIndex];
    if (selected_option) {
        await RemoteCDMManager.saveSelectedRemoteCDM(selected_option.text);
    } else {
        await RemoteCDMManager.removeSelectedRemoteCDMKey();
    }
});

const remote_download = document.getElementById('remoteDownload');
remote_download.addEventListener('click', async function() {
    const remote_cdm = await RemoteCDMManager.getSelectedRemoteCDM();
    SettingsManager.downloadFile(
        await RemoteCDMManager.loadRemoteCDM(remote_cdm),
        remote_cdm + ".json"
    )
});

const remote_combobox = document.getElementById('remote-combobox');
remote_combobox.addEventListener('change', async function() {
    await RemoteCDMManager.saveSelectedRemoteCDM(remote_combobox.options[remote_combobox.selectedIndex].text);
});
// ============================================

// ================ Command Options ================
const use_shaka = document.getElementById('use-shaka');
use_shaka.addEventListener('change', async function (){
    await SettingsManager.saveUseShakaPackager(use_shaka.checked);
});

const downloader_name = document.getElementById('downloader-name');
downloader_name.addEventListener('input', async function (event){
    console.log("input change", event);
    await SettingsManager.saveExecutableName(downloader_name.value);
});

const overlayPreviewToggle = document.getElementById('overlay-preview-toggle');
overlayPreviewToggle.addEventListener('change', async function () {
    await SettingsManager.saveOverlayPreviewEnabled(overlayPreviewToggle.checked);
});

const cookieStrategySelect = document.getElementById('cookie-strategy');
cookieStrategySelect.addEventListener('change', async function () {
    await SettingsManager.saveCookieStrategy(cookieStrategySelect.value);
});

const cookieProfileInput = document.getElementById('cookie-profile');
cookieProfileInput.addEventListener('change', async function () {
    await SettingsManager.saveCookieProfile(cookieProfileInput.value);
});

const outputDirInput = document.getElementById('output-dir');
const outputDirPreset = document.getElementById('output-dir-preset');
const OUTPUT_DIR_PRESET_VALUES = {
    "preset:movies": "~/Movies",
    "preset:downloads": "~/Downloads",
    "preset:desktop": "~/Desktop"
};

outputDirInput.addEventListener('change', async function () {
    await SettingsManager.saveOutputDirectory(outputDirInput.value);
    syncOutputDirPreset(outputDirInput.value);
});

outputDirPreset.addEventListener('change', async () => {
    const value = outputDirPreset.value;
    if (value === 'custom') {
        outputDirInput.disabled = false;
        outputDirInput.focus();
        return;
    }
    const resolved = OUTPUT_DIR_PRESET_VALUES[value];
    if (resolved) {
        outputDirInput.value = resolved;
        outputDirInput.disabled = true;
        await SettingsManager.saveOutputDirectory(resolved);
    }
});
// =================================================

host_retry_button.addEventListener('click', async () => {
    hostStatusErrorLocked = false;
    lastHostErrorMessage = "";
    host_status_message.textContent = "";
    renderHostStatus({ status: "pending", lastError: null });
    try {
        const response = await sendRuntimeMessage({ type: "HOST_RECONNECT" });
        handleHostStatusResponse(response);
    } catch (error) {
        renderHostStatus({ status: "error", lastError: error.message });
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "HOST_STATUS_UPDATE") {
        renderHostStatus(message.payload);
    }
    if (message?.type === "HOST_NATIVE_EVENT") {
        handleNativeEvent(message.payload);
    }
});

// ================ Keys ================
const clear = document.getElementById('clear');
clear.addEventListener('click', async function() {
    fireAndForgetMessage({ type: "CLEAR" });
    key_container.innerHTML = "";
});

async function createCommand(json, key_string) {
    const metadata = JSON.parse(json);
    const header_string = Object.entries(metadata.headers).map(([key, value]) => `-H "${key}: ${value.replace(/"/g, "'")}"`).join(' ');
    return `${await SettingsManager.getExecutableName()} "${metadata.url}" ${header_string} ${key_string} ${await SettingsManager.getUseShakaPackager() ? "--use-shaka-packager " : ""}-M format=mkv`;
}

async function appendLog(result) {
    const key_string = result.keys.map(key => `--key ${key.kid}:${key.k}`).join(' ');
    const date = new Date(result.timestamp * 1000);
    const date_string = date.toLocaleString();

    const manifestList = Array.isArray(result.manifests) ? result.manifests : [];
    const logContainer = document.createElement('div');
    logContainer.classList.add('log-container');
    logContainer.innerHTML = `
        <button class="toggleButton">+</button>
        <div class="expandableDiv collapsed">
            <label class="always-visible right-bound">
                URL:<input type="text" class="text-box" value="${result.url}">
            </label>
            <label class="expanded-only right-bound">
            <label class="expanded-only right-bound">
                PSSH:<input type="text" class="text-box" value="${result.pssh_data}">
            </label>
            <label class="expanded-only right-bound key-copy">
                <a href="#" title="Click to copy">Keys:</a><input type="text" class="text-box" value="${key_string}">
            </label>
            <label class="expanded-only right-bound">
                Date:<input type="text" class="text-box" value="${date_string}">
            </label>
            ${manifestList.length > 0 ? `<label class="expanded-only right-bound manifest-copy">
                <a href="#" title="Click to copy">Manifest:</a><select id="manifest" class="text-box"></select>
            </label>
            <label class="expanded-only right-bound command-copy">
                <a href="#" title="Click to copy">Cmd:</a><input type="text" id="command" class="text-box">
            </label>` : ''}
        </div>`;

    const actionsRow = document.createElement('div');
    actionsRow.className = 'log-actions';
    const queueButton = document.createElement('button');
    queueButton.type = 'button';
    queueButton.className = 'log-actions__queue';
    queueButton.textContent = 'このキーでDL開始';
    queueButton.addEventListener('click', () => queueDownloadForLog(result.pssh_data, queueButton));
    actionsRow.append(queueButton);
    logContainer.append(actionsRow);

    const keysInput = logContainer.querySelector('.key-copy');
    keysInput.addEventListener('click', () => {
        navigator.clipboard.writeText(key_string);
    });

    if (manifestList.length > 0) {
        const command = logContainer.querySelector('#command');

        const select = logContainer.querySelector("#manifest");
        select.addEventListener('change', async () => {
            command.value = await createCommand(select.value, key_string);
        });
        manifestList.forEach((manifest) => {
            const option = new Option(`[${manifest.type}] ${manifest.url}`, JSON.stringify(manifest));
            select.add(option);
        });
        command.value = await createCommand(select.value, key_string);

        const manifest_copy = logContainer.querySelector('.manifest-copy');
        manifest_copy.addEventListener('click', () => {
            navigator.clipboard.writeText(JSON.parse(select.value).url);
        });

        const command_copy = logContainer.querySelector('.command-copy');
        command_copy.addEventListener('click', () => {
            navigator.clipboard.writeText(command.value);
        });
    }

    const toggleButtons = logContainer.querySelector('.toggleButton');
    toggleButtons.addEventListener('click', function () {
        const expandableDiv = this.nextElementSibling;
        if (expandableDiv.classList.contains('collapsed')) {
            toggleButtons.innerHTML = "-";
            expandableDiv.classList.remove('collapsed');
            expandableDiv.classList.add('expanded');
        } else {
            toggleButtons.innerHTML = "+";
            expandableDiv.classList.remove('expanded');
            expandableDiv.classList.add('collapsed');
        }
    });

    key_container.appendChild(logContainer);
}

/**
 * @description 指定ログをネイティブホストへ送信します。
 * @param {string} logKey ログの PSSH キーです。
 * @param {HTMLButtonElement} button 状態表示用のボタンです。
 * @returns {Promise<void>} 完了時に解決します。
 */
async function queueDownloadForLog(logKey, button) {
    if (!logKey || !button) {
        return;
    }
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "送信中...";
    try {
        await sendRuntimeMessage({ type: "QUEUE_LOG_DOWNLOAD", logKey });
        button.textContent = "送信済";
        showPanelMessage("ジョブをキューに追加しました");
    } catch (error) {
        console.error("queueDownloadForLog failed", error);
        button.textContent = originalText;
        button.disabled = false;
        showPanelMessage(error?.message || "送信に失敗しました");
    }
}

chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local') {
        return;
    }
    for (const [key, values] of Object.entries(changes)) {
        if (!values || values.newValue === undefined) {
            continue;
        }
        if (key === HOST_JOB_STORAGE_KEY) {
            hydrateJobState(values.newValue);
            continue;
        }
        if (isLogObject(values.newValue)) {
            await appendLog(values.newValue);
        }
    }
});

async function checkLogs() {
    try {
        const response = await sendRuntimeMessage({ type: "GET_LOGS" });
        if (response) {
            for (const result of response) {
                await appendLog(result);
            }
        }
    } catch (error) {
        console.debug("GET_LOGS failed", error);
    }
}

document.addEventListener('DOMContentLoaded', async function () {
    enabled.checked = await SettingsManager.getEnabled();
    SettingsManager.setDarkMode(await SettingsManager.getDarkMode());
    use_shaka.checked = await SettingsManager.getUseShakaPackager();
    downloader_name.value = await SettingsManager.getExecutableName();
    overlayPreviewToggle.checked = await SettingsManager.getOverlayPreviewEnabled();
    const currentStrategy = await SettingsManager.getCookieStrategy();
    cookieStrategySelect.value = currentStrategy;
    cookieProfileInput.value = await SettingsManager.getCookieProfile();
    const savedOutputDir = await SettingsManager.getOutputDirectory();
    outputDirInput.value = savedOutputDir || OUTPUT_DIR_PRESET_VALUES["preset:movies"];
    syncOutputDirPreset(outputDirInput.value);
    await SettingsManager.setSelectedDeviceType(await SettingsManager.getSelectedDeviceType());
    await DeviceManager.loadSetAllWidevineDevices();
    await DeviceManager.selectWidevineDevice(await DeviceManager.getSelectedWidevineDevice());
    await RemoteCDMManager.loadSetAllRemoteCDMs();
    await RemoteCDMManager.selectRemoteCDM(await RemoteCDMManager.getSelectedRemoteCDM());
    const storedJobs = await AsyncLocalStorage.getStorage([HOST_JOB_STORAGE_KEY]);
    hydrateJobState(storedJobs[HOST_JOB_STORAGE_KEY] || {});
    try {
        const status = await sendRuntimeMessage({ type: "HOST_STATUS_QUERY" });
        handleHostStatusResponse(status);
    } catch (error) {
        renderHostStatus({ status: "error", lastError: error.message });
    }
    checkLogs();
});
// ======================================

function handleHostStatusResponse(response) {
    if (chrome.runtime.lastError) {
        renderHostStatus({ status: "error", lastError: chrome.runtime.lastError.message });
        return;
    }
    renderHostStatus(response);
}

/**
 * @description ネイティブホストの状態表示を更新します。
 * @param {{status?: string, lastError?: string|null, lastErrorAt?: number|null}} payload 受信したステータス情報です。
 * @returns {void}
 */
function renderHostStatus(payload) {
    const status = (payload?.status || "disconnected").toLowerCase();
    const detail = payload?.lastError ?? "";
    const detailTimestamp = payload?.lastErrorAt ?? null;

    updateHostRetryVisibility(status);

    const classList = ["status-pill"];
    switch (status) {
        case "connected":
            classList.push("status-pill--connected");
            break;
        case "pending":
            classList.push("status-pill--pending");
            break;
        case "connecting":
            classList.push("status-pill--connecting");
            break;
        case "error":
            classList.push("status-pill--error");
            break;
        default:
            classList.push("status-pill--disconnected");
            break;
    }

    host_status_indicator.className = classList.join(" ");
    host_status_indicator.textContent = status;
    if (status === "error") {
        // エラーはユーザーの Retry 操作までロックする
        hostStatusErrorLocked = true;
        lastHostErrorMessage = formatHostErrorDetail(detail, detailTimestamp);
        host_status_message.textContent = lastHostErrorMessage;
    } else if (hostStatusErrorLocked) {
        hostStatusErrorLocked = false;
        if (host_status_message.textContent === lastHostErrorMessage) {
            host_status_message.textContent = "";
        }
        lastHostErrorMessage = "";
    }
}

/**
 * @description Retry ボタンの表示と活性状態を最新ステータスに合わせます。
 * @param {string} status ネイティブホストの現在ステータスです。
 * @returns {void}
 */
function updateHostRetryVisibility(status) {
    if (!host_retry_button) {
        return;
    }
    const normalized = (status || "").toLowerCase();
    const shouldShowButton = normalized === "error";
    host_retry_button.hidden = !shouldShowButton;
    // エラー解除までは再試行を促し、それ以外では無駄なクリックを抑止する
    host_retry_button.disabled = normalized === "pending" || normalized === "connecting";
}

/**
 * @description エラー詳細をタイムスタンプ付きで整形します。
 * @param {string} detail エラーメッセージです。
 * @param {number|null|undefined} timestampMs 発生時刻のミリ秒です。
 * @returns {string} 整形済み文字列です。
 */
function formatHostErrorDetail(detail, timestampMs) {
    if (!detail) {
        return "";
    }
    if (!timestampMs) {
        return detail;
    }
    try {
        const date = new Date(timestampMs);
        if (!Number.isNaN(date.getTime())) {
            return `${detail} (${date.toLocaleString()})`;
        }
    } catch (error) {
        console.debug("formatHostErrorDetail skipped", error);
    }
    return detail;
}

function showPanelMessage(message, ttl = 5000) {
    if (!message) {
        host_status_message.textContent = "";
        return;
    }
    if (hostStatusErrorLocked) {
        showToast(message, ttl);
        return;
    }
    host_status_message.textContent = message;
    if (ttl > 0) {
        setTimeout(() => {
            if (!hostStatusErrorLocked && host_status_message.textContent === message) {
                host_status_message.textContent = "";
            }
        }, ttl);
    }
}

/**
 * @description ネイティブホストから届くイベントをステータス表示とカードに反映します。
 * @param {object} payload ネイティブホストが送信したイベントです。
 */
function handleNativeEvent(payload) {
    if (!payload) {
        return;
    }
    if (payload?.type === "job-start") {
        showStartToast(payload);
        return;
    }
    const normalized = normalizeJobPayload(payload);
    if (!normalized?.clientJobId) {
        return;
    }
    const previous = jobState.get(normalized.clientJobId) || {};
    const merged = {
        ...previous,
        ...normalized,
        outputDir: normalized.outputDir || previous.outputDir || ""
    };
    jobState.set(normalized.clientJobId, merged);
    if (
        merged.stage === "completed" &&
        !completedToastJobs.has(merged.clientJobId)
    ) {
        completedToastJobs.add(merged.clientJobId);
        showCompletionToast(merged);
    }
    scheduleJobRender();
}

/**
 * @description ネイティブイベントをUI用の共通フォーマットへ正規化します。
 * @param {object} payload ネイティブホストイベントです。
 * @returns {object} 正規化済みのジョブ情報です。
 */
function normalizeJobPayload(payload) {
    const key = payload.clientJobId || payload.jobId;
    if (!key) {
        return null;
    }
    const rawStage = (payload.stage || payload.status || "pending").toString().toLowerCase();
    const stage = JOB_STAGE_LABELS[rawStage] ? rawStage : "queued";
    const normalizedPayload = {
        clientJobId: key,
        hostJobId: payload.jobId || payload.hostJobId || null,
        stage,
        status: (payload.status || payload.stage || "pending").toString(),
        detail: payload.message || payload.detail || payload.outputPath || "",
        progress: typeof payload.progress === "number" ? payload.progress : null,
        outputPath: payload.output_path || payload.outputPath || "",
        outputDir: payload.output_dir || payload.outputDir || "",
        mpdUrl: payload.mpd_url || payload.mpdUrl || "",
        sourceUrl: payload.source_url || payload.sourceUrl || "",
        updatedAt: Date.now()
    };
    if (Object.prototype.hasOwnProperty.call(payload, "runSlot")) {
        normalizedPayload.runSlot = payload.runSlot;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "waitingSince")) {
        normalizedPayload.waitingSince = payload.waitingSince;
    }
    return normalizedPayload;
}

/**
 * @description ネイティブジョブ一覧の再描画を遅延実行してUIのスパイクを防ぎます。
 */
function scheduleJobRender() {
    if (jobRenderTimer) {
        clearTimeout(jobRenderTimer);
    }
    jobRenderTimer = setTimeout(() => {
        jobRenderTimer = null;
        renderJobList(jobState);
    }, JOB_RENDER_DEBOUNCE_MS);
}

/**
 * @description ジョブ完了時のトースト通知を発火します。
 * @param {object} job 完了したジョブ情報です。
 */
function showCompletionToast(job) {
    if (!job) {
        return;
    }
    const title = formatJobTitle(job) || "ダウンロード";
    const parts = [
        `${title} のダウンロードが完了しました`
    ];
    if (job.outputPath) {
        parts.push(job.outputPath);
    } else if (job.outputDir) {
        parts.push(job.outputDir);
    }
    showToast(parts.join("\n"));
}

/**
 * @description ダウンロード開始時のトーストを表示します。
 * @param {object} job 対象ジョブです。
 */
function showStartToast(job) {
    const title = formatJobTitle(job) || "ダウンロード";
    const message = `${title} のダウンロードを開始しました`;
    showToast(message, 4000);
}

/**
 * @description 汎用トースト UI を生成して一定時間後に自動消去します。
 * @param {string} message 表示したいメッセージです。
 * @param {number} [duration=TOAST_DISMISS_DURATION] 表示時間(ミリ秒)です。
 */
function showToast(message, duration = TOAST_DISMISS_DURATION) {
    if (!toastContainer || !message) {
        return;
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");

    const body = document.createElement("span");
    body.className = "toast__message";
    body.textContent = message;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast__close";
    closeButton.setAttribute("aria-label", "閉じる");
    closeButton.textContent = "×";

    const removeToast = () => {
        toast.remove();
    };

    let timerId = 0;
    closeButton.addEventListener("click", () => {
        window.clearTimeout(timerId);
        removeToast();
    });

    toast.append(body, closeButton);
    toastContainer.appendChild(toast);

    timerId = window.setTimeout(() => {
        removeToast();
    }, Math.max(1000, duration));
}

/**
 * @description ジョブマップをリストに描画します。
 * @param {Map<string, object>} state 表示対象のジョブマップです。
 */
function renderJobList(state) {
    if (!jobListContainer) {
        return;
    }
    jobListContainer.innerHTML = "";
    const snapshot = Array.from(state.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const now = Date.now();
    const filtered = [];
    let hiddenCount = 0;
    for (const job of snapshot) {
        if (filterJobByDate(job, now)) {
            filtered.push(job);
        } else {
            hiddenCount += 1;
        }
    }
    updateJobHistoryHint(hiddenCount, snapshot.length);
    const entries = filtered.slice(0, JOB_CARD_DISPLAY_LIMIT);
    if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "job-card job-card--empty";
        empty.textContent = snapshot.length === 0 ? "ジョブ待機中..." : "条件に一致するジョブがありません";
        jobListContainer.appendChild(empty);
        return;
    }
    for (const job of entries) {
        jobListContainer.appendChild(buildJobCard(job));
    }
}

/**
 * @description ジョブがフィルター条件に合致するか判定します。
 * @param {object} job 対象ジョブです。
 * @param {number} now 現在時刻ミリ秒です。
 * @returns {boolean} 表示対象なら true。
 */
function filterJobByDate(job, now = Date.now()) {
    const updatedAt = job?.updatedAt ?? job?.createdAt ?? 0;
    if (!showExtendedHistory && now - updatedAt > JOB_HISTORY_WINDOW_MS) {
        return false;
    }
    const todayStart = getStartOfDay(now);
    const yesterdayStart = todayStart - DAY_MS;
    switch (jobDateFilter) {
        case "today":
            return updatedAt >= todayStart;
        case "yesterday":
            return updatedAt >= yesterdayStart && updatedAt < todayStart;
        default:
            return true;
    }
}

/**
 * @description 履歴ヒントの表示を更新します。
 * @param {number} hiddenCount 折りたたまれた件数です。
 * @param {number} totalCount 全体件数です。
 */
function updateJobHistoryHint(hiddenCount, totalCount) {
    if (!jobHistoryHint) {
        return;
    }
    if (totalCount === 0 || showExtendedHistory || hiddenCount === 0) {
        jobHistoryHint.hidden = true;
        jobHistoryHint.textContent = "";
        return;
    }
    jobHistoryHint.hidden = false;
    jobHistoryHint.textContent = `過去${JOB_HISTORY_WINDOW_DAYS}日より前のジョブ ${hiddenCount} 件を折りたたみ中`;
}

/**
 * @description 指定日の午前0時タイムスタンプを返します。
 * @param {number} timestamp 判定対象の時刻です。
 * @returns {number} 当日0時のミリ秒値です。
 */
function getStartOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/**
 * @description 単一ジョブのカード要素を構築します。
 * @param {object} job 表示するジョブ情報です。
 * @returns {HTMLElement} 描画済みカード要素です。
 */
function buildJobCard(job) {
    const stageKey = job.stage || "pending";
    const card = document.createElement("div");
    card.className = `job-card job-card--${stageKey}`;

    const title = document.createElement("div");
    title.className = "job-card__title";
    title.textContent = formatJobTitle(job);

    const meta = document.createElement("div");
    meta.className = "job-card__meta";
    const statusLabel = document.createElement("span");
    statusLabel.className = `job-card__status job-card__status--${stageKey}`;
    statusLabel.textContent = JOB_STAGE_LABELS[stageKey] || job.status || stageKey;
    const progressLabel = document.createElement("span");
    progressLabel.className = "job-card__progress-value";
    progressLabel.textContent = formatJobProgress(job.progress);
    const timestamp = document.createElement("span");
    timestamp.className = "job-card__timestamp";
    timestamp.textContent = formatJobTimestamp(job.updatedAt);
    const fragments = [statusLabel, progressLabel];
    if (typeof job.runSlot === "number") {
        const slot = document.createElement("span");
        slot.className = "job-card__slot";
        slot.textContent = `Slot ${job.runSlot}/${PANEL_CONCURRENCY_LIMIT}`;
        fragments.push(slot);
    }
    fragments.push(timestamp);
    meta.append(...fragments);

    const detail = document.createElement("div");
    detail.className = "job-card__detail";
    detail.textContent = job.detail || job.outputPath || job.sourceUrl || job.mpdUrl || "";

    card.append(title, meta, detail);

    const pathSection = buildJobPathSection(job);
    if (pathSection) {
        card.append(pathSection);
    }

    const progressBar = buildJobProgressBar(job);
    if (progressBar) {
        card.append(progressBar);
    }

    if (job.commandPreview) {
        const commandBlock = document.createElement("div");
        commandBlock.className = "job-card__command";
        const commandLabel = document.createElement("div");
        commandLabel.className = "job-card__command-label";
        commandLabel.textContent = "yt-dlp preview";
        const commandText = document.createElement("pre");
        commandText.className = "job-card__command-text";
        commandText.textContent = job.commandPreview;
        const previewKey = job.clientJobId || job.hostJobId || job.outputPath || job.mpdUrl || job.sourceUrl || "__global__";
        let expanded = Boolean(commandPreviewExpansion.get(previewKey));
        commandText.hidden = !expanded;
        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.className = "job-card__button";
        toggleButton.textContent = expanded ? "折りたたむ" : "展開";
        const syncToggleState = () => {
            commandText.hidden = !expanded;
            toggleButton.textContent = expanded ? "折りたたむ" : "展開";
            commandPreviewExpansion.set(previewKey, expanded);
        };
        toggleButton.addEventListener("click", () => {
            expanded = !expanded;
            syncToggleState();
        });
        syncToggleState();
        const commandCopy = document.createElement("button");
        commandCopy.type = "button";
        commandCopy.className = "job-card__button job-card__button--secondary";
        commandCopy.textContent = "コピー";
        commandCopy.addEventListener("click", () => handleCommandCopy(job));
        const commandActions = document.createElement("div");
        commandActions.className = "job-card__command-actions";
        commandActions.append(toggleButton, commandCopy);
        commandBlock.append(commandLabel, commandText, commandActions);
        card.append(commandBlock);
    }

    const actions = buildJobActions(job);
    if (actions) {
        card.append(actions);
    }
    return card;
}

/**
 * @description ジョブタイトルの表示文字列を生成します。
 * @param {object} job 対象ジョブです。
 * @returns {string} 表示タイトルです。
 */
function formatJobTitle(job) {
    if (job.outputPath) {
        return job.outputPath.split("/").pop() || job.outputPath;
    }
    if (job.sourceUrl) {
        return job.sourceUrl;
    }
    return job.mpdUrl || job.clientJobId || "";
}

/**
 * @description 進捗値をパーセンテージ表記に整形します。
 * @param {number|null} progress 0-1 の進捗率です。
 * @returns {string} 表示用進捗テキストです。
 */
function formatJobProgress(progress) {
    if (typeof progress !== "number") {
        return "";
    }
    return `${Math.round(progress * 100)}%`;
}

/**
 * @description ジョブ最終更新時刻をローカルタイム表記に変換します。
 * @param {number|undefined} updatedAt Unixエポックミリ秒です。
 * @returns {string} 表示用の時刻文字列です。
 */
function formatJobTimestamp(updatedAt) {
    if (!updatedAt) {
        return "";
    }
    try {
        return new Date(updatedAt).toLocaleTimeString();
    } catch (
        /** @type {unknown} */
        error
    ) {
        console.debug("timestamp format failed", error);
        return "";
    }
}

/**
 * @description 進捗値を可視化するプログレスバー要素を生成します。
 * @param {object} job 対象ジョブです。
 * @returns {HTMLElement|null} プログレスバー要素、未定義時は null。
 */
function buildJobProgressBar(job) {
    if (typeof job?.progress !== "number") {
        return null;
    }
    const normalized = Math.max(0, Math.min(1, job.progress));
    const wrapper = document.createElement("div");
    wrapper.className = "job-card__progress";
    const fill = document.createElement("div");
    fill.className = "job-card__progress-fill";
    fill.style.width = `${Math.round(normalized * 100)}%`;
    wrapper.append(fill);
    return wrapper;
}

/**
 * @description 保存フォルダおよびファイル情報をまとめた要素を構築します。
 * @param {object} job 対象ジョブです。
 * @returns {HTMLElement|null} 表示要素、情報なしなら null。
 */
function buildJobPathSection(job) {
    const displayPath = job.outputPath || job.outputDir || "";
    if (!displayPath) {
        return null;
    }
    const container = document.createElement("div");
    container.className = "job-card__paths";
    const row = createOutputFileRow(job, displayPath);
    if (row) {
        container.append(row);
        return container;
    }
    return null;
}

/**
 * @description 出力ファイル行を構築し、横にフォルダオープンボタンを配置します。
 * @param {object} job 対象ジョブです。
 * @param {string} displayPath 表示用のパス文字列です。
 * @returns {HTMLElement|null} 行要素、条件未達なら null。
 */
function createOutputFileRow(job, displayPath) {
    if (!displayPath) {
        return null;
    }
    const row = document.createElement("div");
    row.className = "job-card__path-row";
    const labelNode = document.createElement("span");
    labelNode.className = "job-card__path-label";
    labelNode.textContent = "出力ファイル";
    const linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.className = "job-card__path-link";
    linkButton.textContent = displayPath;
    linkButton.disabled = !canRevealPath(job);
    linkButton.addEventListener("click", () => handleRevealRequest(job, linkButton));
    row.append(labelNode, linkButton);
    return row;
}

/**
 * @description フォルダオープン可能かを判定します。
 * @param {object} job 対象ジョブです。
 * @returns {boolean} true ならオープン可能。
 */
function canRevealPath(job) {
    return Boolean(job?.outputPath || job?.outputDir);
}

/**
 * @description ファイルパス文字列からディレクトリ部分を推測します。
 * @param {string} path ファイルパスです。
 * @returns {string|null} ディレクトリ文字列。
 */
function deriveDirectoryFromPath(path) {
    if (!path) {
        return null;
    }
    const separator = path.includes("\\") ? "\\" : "/";
    const segments = path.split(separator);
    if (segments.length <= 1) {
        return null;
    }
    segments.pop();
    return segments.join(separator);
}

/**
 * @description フォルダを開く要求を Service Worker へ送ります。
 * @param {object} job 対象ジョブです。
 * @param {HTMLButtonElement} button クリックしたボタンです。
 */
function handleRevealRequest(job, button) {
    const candidatePath = job?.outputPath || job?.outputDir || deriveDirectoryFromPath(job?.outputPath);
    if (!candidatePath) {
        showPanelMessage("出力パスがまだ確定していません");
        return;
    }
    button.disabled = true;
    sendRuntimeMessage({ type: "HOST_REVEAL_OUTPUT", outputPath: candidatePath })
        .then(() => {
            showPanelMessage("フォルダを開くリクエストを送信しました");
        })
        .catch((error) => {
            console.error("reveal request failed", error);
            showPanelMessage(error?.message || "フォルダを開けませんでした");
        })
        .finally(() => {
            button.disabled = false;
        });
}

function normalizeJobStatus(job) {
    return (job?.status || job?.stage || "").toString().toLowerCase();
}

function isRetryableJob(job) {
    return RETRYABLE_STATUSES.has(normalizeJobStatus(job));
}

function isRemovableJob(job) {
    const status = normalizeJobStatus(job);
    if (status === "pending" || status === "downloading" || status === "preparing") {
        return false;
    }
    return REMOVABLE_STATUSES.has(status);
}

/**
 * @description キャンセルボタンを表示するか判定します。
 * @param {object} job 対象ジョブです。
 * @returns {boolean} 中断可能なら true。
 */
function canAbortJob(job) {
    return CANCELLABLE_STATUSES.has(normalizeJobStatus(job));
}

function syncOutputDirPreset(currentValue) {
    const matchingEntry = Object.entries(OUTPUT_DIR_PRESET_VALUES).find(([, value]) => value === currentValue);
    if (matchingEntry) {
        outputDirPreset.value = matchingEntry[0];
        outputDirInput.disabled = true;
    } else {
        outputDirPreset.value = 'custom';
        outputDirInput.disabled = false;
    }
}

function buildJobActions(job) {
    const fragments = [];
    if (canAbortJob(job)) {
        const cancelButton = document.createElement("button");
        cancelButton.className = "job-card__button job-card__button--danger";
        cancelButton.textContent = "キャンセル";
        cancelButton.addEventListener("click", () => handleJobAbort(job, cancelButton));
        fragments.push(cancelButton);
    }
    if (isRetryableJob(job)) {
        const retryButton = document.createElement("button");
        retryButton.className = "job-card__button";
        retryButton.textContent = "再送";
        retryButton.addEventListener("click", () => handleJobRetry(job, retryButton));
        fragments.push(retryButton);
    }
    if (isRemovableJob(job)) {
        const removeButton = document.createElement("button");
        removeButton.className = "job-card__button";
        removeButton.textContent = "削除";
        removeButton.addEventListener("click", () => handleJobDelete(job, removeButton));
        fragments.push(removeButton);
    }
    if (fragments.length === 0) {
        return null;
    }
    const container = document.createElement("div");
    container.className = "job-card__actions";
    fragments.forEach((fragment) => container.appendChild(fragment));
    return container;
}

function handleCommandCopy(job) {
    if (!job?.commandPreview) {
        return;
    }
    navigator.clipboard.writeText(job.commandPreview)
        .then(() => {
            showPanelMessage("コマンドをコピーしました");
        })
        .catch((error) => {
            console.error("command copy failed", error);
            showPanelMessage("コピーに失敗しました");
        });
}

function handleJobRetry(job, button) {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "再送中...";
    sendRuntimeMessage({ type: "HOST_JOB_RETRY", clientJobId: job.clientJobId })
        .then(() => {
            showPanelMessage("ジョブを再送しました");
            button.textContent = "再送済";
        })
        .catch((error) => {
            console.error("job retry failed", error);
            showPanelMessage(error?.message || "再送に失敗しました");
            button.disabled = false;
            button.textContent = originalText;
        });
}

/**
 * @description ジョブのキャンセル処理を発火します。
 * @param {object} job 対象ジョブです。
 * @param {HTMLButtonElement} button 操作ボタンです。
 */
function handleJobAbort(job, button) {
    if (!job?.clientJobId) {
        return;
    }
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "停止中...";
    sendRuntimeMessage({
        type: "HOST_JOB_ABORT",
        clientJobId: job.clientJobId,
        hostJobId: job.hostJobId
    })
        .then(() => {
            showPanelMessage("キャンセル要求を送信しました");
            button.textContent = "キャンセル済";
        })
        .catch((error) => {
            console.error("job abort failed", error);
            showPanelMessage(error?.message || "キャンセルに失敗しました");
            button.disabled = false;
            button.textContent = originalText;
        });
}

function handleJobDelete(job, button) {
    button.disabled = true;
    sendRuntimeMessage({ type: "HOST_JOB_DELETE", clientJobId: job.clientJobId })
        .then(() => {
            jobState.delete(job.clientJobId);
            scheduleJobRender();
        })
        .catch((error) => {
            console.error("job delete failed", error);
            showPanelMessage(error?.message || "削除に失敗しました");
            button.disabled = false;
        });
}

/**
 * @description ストレージのジョブデータをメモリに取り込みます。
 * @param {Record<string, object>} storedJobs chrome.storage.local から取得した値です。
 */
function hydrateJobState(storedJobs = {}) {
    jobState.clear();
    for (const [key, value] of Object.entries(storedJobs)) {
        if (value) {
            jobState.set(key, value);
        }
    }
    scheduleJobRender();
}

/**
 * @description 値がキー情報ログかどうかを判定します。
 * @param {unknown} value 監視対象の値です。
 * @returns {boolean} ログ形式であれば true。
 */
function isLogObject(value) {
    return Boolean(value && Array.isArray(value.keys) && typeof value.pssh_data === "string");
}
