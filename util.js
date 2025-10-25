import { WidevineDevice } from "./device.js";
import { RemoteCdm } from "./remote_cdm.js";

export class AsyncSyncStorage {
    static async setStorage(items) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.set(items, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve();
                }
            });
        });
    }

    static async getStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve(result);
                }
            });
        });
    }

    static async removeStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.remove(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve(result);
                }
            });
        });
    }
}

export class AsyncLocalStorage {
    static async setStorage(items) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set(items, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve();
                }
            });
        });
    }

    static async getStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve(result);
                }
            });
        });
    }

    static async removeStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.remove(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError));
                } else {
                    resolve(result);
                }
            });
        });
    }
}

export class DeviceManager {
    static async saveWidevineDevice(name, value) {
        const result = await AsyncSyncStorage.getStorage(['devices']);
        const array = result.devices === undefined ? [] : result.devices;
        array.push(name);
        await AsyncSyncStorage.setStorage({ devices: array });
        await AsyncSyncStorage.setStorage({ [name]: value });
    }

    static async loadWidevineDevice(name) {
        const result = await AsyncSyncStorage.getStorage([name]);
        return result[name] || "";
    }

    static setWidevineDevice(name, value){
        const wvd_combobox = document.getElementById('wvd-combobox');
        const wvd_element = document.createElement('option');

        wvd_element.text = name;
        wvd_element.value = value;

        wvd_combobox.appendChild(wvd_element);
    }

    static async loadSetAllWidevineDevices() {
        const result = await AsyncSyncStorage.getStorage(['devices']);
        const array = result.devices || [];
        for (const item of array) {
            this.setWidevineDevice(item, await this.loadWidevineDevice(item));
        }
    }

    static async saveSelectedWidevineDevice(name) {
        await AsyncSyncStorage.setStorage({ selected: name });
    }

    static async getSelectedWidevineDevice() {
        const result = await AsyncSyncStorage.getStorage(["selected"]);
        return result["selected"] || "";
    }

    static async selectWidevineDevice(name) {
        document.getElementById('wvd-combobox').value = await this.loadWidevineDevice(name);
    }

    static async removeSelectedWidevineDevice() {
        const selected_device_name = await DeviceManager.getSelectedWidevineDevice();

        const result = await AsyncSyncStorage.getStorage(['devices']);
        const array = result.devices === undefined ? [] : result.devices;

        const index = array.indexOf(selected_device_name);
        if (index > -1) {
            array.splice(index, 1);
        }

        await AsyncSyncStorage.setStorage({ devices: array });
        await AsyncSyncStorage.removeStorage([selected_device_name]);
    }

    static async removeSelectedWidevineDeviceKey() {
        await AsyncSyncStorage.removeStorage(["selected"]);
    }
}

export class RemoteCDMManager {
    /**
     * @param {string} name 保存対象のリモートCDM名です。
     * @param {object} obj 保存するCDM情報のオブジェクトです。
     */
    static async saveRemoteCDM(name, obj) {
        const result = await AsyncSyncStorage.getStorage(['remote_cdms']);
        const array = result.remote_cdms === undefined ? [] : result.remote_cdms;
        if (!array.includes(name)) {
            array.push(name);
            await AsyncSyncStorage.setStorage({ remote_cdms: array });
        }
        await AsyncSyncStorage.setStorage({ [name]: obj });
    }

    static async loadRemoteCDM(name) {
        const result = await AsyncSyncStorage.getStorage([name]);
        return JSON.stringify(result[name] || {});
    }

    static setRemoteCDM(name, value){
        const remote_combobox = document.getElementById('remote-combobox');
        const remote_element = document.createElement('option');

        remote_element.text = name;
        remote_element.value = value;

        remote_combobox.appendChild(remote_element);
    }

    /**
     * @description 登録済みのリモートCDMを全て読み込み、初期表示に必要な選択肢を構築します。
     */
    static async loadSetAllRemoteCDMs() {
        const { remote_cdms: storedList = [], bootstrap_remote_initialized: initialized = false } = await AsyncSyncStorage.getStorage(['remote_cdms', 'bootstrap_remote_initialized']);
        let array = storedList;

        if (array.length === 0 && !initialized) {
            const bootstrappedName = await this.bootstrapDefaultRemoteCDM();
            if (bootstrappedName) {
                const refreshed = await AsyncSyncStorage.getStorage(['remote_cdms']);
                array = refreshed.remote_cdms || [];
            }
        }

        const remote_combobox = document.getElementById('remote-combobox');
        if (remote_combobox) {
            remote_combobox.innerHTML = '';
        }

        const canonicalNames = [];
        const selectedName = await this.getSelectedRemoteCDM();
        let selectedExists = false;

        for (const originalName of array) {
            const raw = await this.loadRemoteCDM(originalName);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                console.error("リモートCDMの読み込みに失敗しました", originalName, error);
                continue;
            }

            const remoteCdm = RemoteCdm.from_object(parsed);
            const canonicalName = remoteCdm.get_name();

            if (canonicalName !== originalName) {
                await AsyncSyncStorage.removeStorage([originalName]);
                await AsyncSyncStorage.setStorage({ [canonicalName]: parsed });
            }

            if (!canonicalNames.includes(canonicalName)) {
                canonicalNames.push(canonicalName);
            }

            this.setRemoteCDM(canonicalName, JSON.stringify(parsed));

            if (canonicalName === selectedName) {
                selectedExists = true;
            }
        }

        await AsyncSyncStorage.setStorage({ remote_cdms: canonicalNames });

        if (canonicalNames.length > 0 && !initialized) {
            await AsyncSyncStorage.setStorage({ bootstrap_remote_initialized: true });
        }

        if (!selectedExists && canonicalNames.length > 0) {
            await this.saveSelectedRemoteCDM(canonicalNames[0]);
        }
    }

    static async saveSelectedRemoteCDM(name) {
        await AsyncSyncStorage.setStorage({ selected_remote_cdm: name });
    }

    /**
     * @description 選択済みのリモートCDM名を取得します。
     * @returns {Promise<string>} 選択されているCDM名、未設定なら空文字です。
     */
    static async getSelectedRemoteCDM() {
        const result = await AsyncSyncStorage.getStorage(["selected_remote_cdm"]);
        return result["selected_remote_cdm"] || "";
    }

    /**
     * @param {string} name UI上で選択したいCDM名です。
     */
    static async selectRemoteCDM(name) {
        const remote_combobox = document.getElementById('remote-combobox');
        if (!remote_combobox) {
            return;
        }
        if (!name) {
            const firstOption = remote_combobox.options[0];
            if (firstOption) {
                remote_combobox.value = firstOption.value;
                await this.saveSelectedRemoteCDM(firstOption.text);
            }
            return;
        }
        remote_combobox.value = await this.loadRemoteCDM(name);
    }

    static async removeSelectedRemoteCDM() {
        const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();

        const result = await AsyncSyncStorage.getStorage(['remote_cdms']);
        const array = result.remote_cdms === undefined ? [] : result.remote_cdms;

        const index = array.indexOf(selected_remote_cdm_name);
        if (index > -1) {
            array.splice(index, 1);
        }

        await AsyncSyncStorage.setStorage({ remote_cdms: array });
        await AsyncSyncStorage.removeStorage([selected_remote_cdm_name]);
    }

    static async removeSelectedRemoteCDMKey() {
        await AsyncSyncStorage.removeStorage(["selected_remote_cdm"]);
    }

    /**
     * @description 組み込みのremote.jsonから初期CDMを登録します。
     */
    static async bootstrapDefaultRemoteCDM() {
        try {
            const { bootstrap_remote_initialized: initialized } = await AsyncSyncStorage.getStorage(['bootstrap_remote_initialized']);
            if (initialized) {
                return null;
            }
            const manifestUrl = chrome.runtime.getURL("remote.json");
            const response = await fetch(manifestUrl);
            if (!response.ok) {
                console.warn("remote.json の取得に失敗しました", response.status);
                return null;
            }

            // デフォルトの remote.json を読み込み、初期状態を整える。
            const remoteJson = await response.json();
            const remoteCdm = RemoteCdm.from_object(remoteJson);
            const deviceName = remoteCdm.get_name();
            const existing = await AsyncSyncStorage.getStorage([deviceName]);
            if (existing[deviceName]) {
                await this.saveSelectedRemoteCDM(deviceName);
                await AsyncSyncStorage.setStorage({ bootstrap_remote_initialized: true });
                return deviceName;
            }

            await this.saveRemoteCDM(deviceName, remoteJson);
            await this.saveSelectedRemoteCDM(deviceName);
            await AsyncSyncStorage.setStorage({ bootstrap_remote_initialized: true });
            return deviceName;
        } catch (error) {
            console.error("デフォルトリモートCDMの初期化に失敗しました", error);
            return null;
        }
    }
}

export class SettingsManager {
    static async setEnabled(enabled) {
        await AsyncSyncStorage.setStorage({ enabled: enabled });
    }

    /**
     * @description 拡張機能の有効状態を取得します。
     * @returns {Promise<boolean>} 保存値が無い場合は既定でtrueを返します。
     */
    static async getEnabled() {
        const result = await AsyncSyncStorage.getStorage(["enabled"]);
        return result["enabled"] === undefined ? true : result["enabled"];
    }

    static downloadFile(content, filename) {
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    static async importDevice(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async function (loaded) {
                const result = loaded.target.result;

                const widevine_device = new WidevineDevice(result);
                const b64_device = uint8ArrayToBase64(new Uint8Array(result));
                const device_name = widevine_device.get_name();

                if (!await DeviceManager.loadWidevineDevice(device_name)) {
                    await DeviceManager.saveWidevineDevice(device_name, b64_device);
                }

                await DeviceManager.saveSelectedWidevineDevice(device_name);
                resolve();
            };
            reader.readAsArrayBuffer(file);
        });
    }

    static async saveDarkMode(dark_mode) {
        await AsyncSyncStorage.setStorage({ dark_mode: dark_mode });
    }

    static async getDarkMode() {
        const result = await AsyncSyncStorage.getStorage(["dark_mode"]);
        return result["dark_mode"] || false;
    }

    static setDarkMode(dark_mode) {
        const textImage = document.getElementById("textImage");
        const toggle = document.getElementById('darkModeToggle');
        toggle.checked = dark_mode;
        document.body.classList.toggle('dark-mode', dark_mode);
        textImage.src = dark_mode ? "../images/proxy_text_dark.png" : "../images/proxy_text.png";
    }

    static async loadRemoteCDM(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async function (loaded) {
                const result = loaded.target.result;

                let json_file = void 0;
                try {
                    json_file = JSON.parse(result);
                } catch {
                    resolve();
                    return;
                }

                console.log("LOADED DEVICE:", json_file);
                const remote_cdm = new RemoteCdm(
                    json_file.device_type,
                    json_file.system_id,
                    json_file.security_level,
                    json_file.host,
                    json_file.secret,
                    json_file.device_name ?? json_file.name,
                );
                const device_name = remote_cdm.get_name();
                console.log("NAME:", device_name);

                if (await RemoteCDMManager.loadRemoteCDM(device_name) === "{}") {
                    await RemoteCDMManager.saveRemoteCDM(device_name, json_file);
                }

                await RemoteCDMManager.saveSelectedRemoteCDM(device_name);
                resolve();
            };
            reader.readAsText(file);
        });
    }

    static async saveSelectedDeviceType(selected_type) {
        await AsyncSyncStorage.setStorage({ device_type: selected_type });
    }

    /**
     * @description 選択済みのデバイスタイプを返します。
     * @returns {Promise<string>} 保存値が無ければ"REMOTE"を返します。
     */
    static async getSelectedDeviceType() {
        const result = await AsyncSyncStorage.getStorage(["device_type"]);
        return result["device_type"] || "REMOTE";
    }

    static setSelectedDeviceType(device_type) {
        switch (device_type) {
            case "WVD":
                const wvd_select = document.getElementById('wvd_select');
                wvd_select.checked = true;
                break;
            case "REMOTE":
                const remote_select = document.getElementById('remote_select');
                remote_select.checked = true;
                break;
        }
    }

    static async saveUseShakaPackager(use_shaka) {
        await AsyncSyncStorage.setStorage({ use_shaka: use_shaka });
    }

    static async getUseShakaPackager() {
        const result = await AsyncSyncStorage.getStorage(["use_shaka"]);
        return result["use_shaka"] ?? true;
    }

    static async saveExecutableName(exe_name) {
        await AsyncSyncStorage.setStorage({ exe_name: exe_name });
    }

    static async getExecutableName() {
        const result = await AsyncSyncStorage.getStorage(["exe_name"]);
        return result["exe_name"] ?? "N_m3u8DL-RE";
    }

    /**
     * @description オーバーレイプレビューの有効状態を保存します。
     * @param {boolean} enabled 有効かどうかです。
     * @returns {Promise<void>} 保存完了時に解決します。
     */
    static async saveOverlayPreviewEnabled(enabled) {
        await AsyncSyncStorage.setStorage({ overlay_preview_enabled: Boolean(enabled) });
    }

    /**
     * @description オーバーレイプレビューの有効状態を取得します。
     * @returns {Promise<boolean>} 未設定の場合は true を返します。
     */
    static async getOverlayPreviewEnabled() {
        const result = await AsyncSyncStorage.getStorage(["overlay_preview_enabled"]);
        const rawValue = result["overlay_preview_enabled"];
        if (rawValue === undefined) {
            return true;
        }
        return Boolean(rawValue);
    }

    /**
     * @description Cookie 取得戦略 (browser / netscape) を保存します。
     * @param {"browser"|"netscape"} strategy 選択した戦略です。
     * @returns {Promise<void>} 保存完了時に解決します。
     */
    static async saveCookieStrategy(strategy) {
        const normalized = strategy === "netscape" ? "netscape" : "browser";
        await AsyncSyncStorage.setStorage({ cookie_strategy: normalized });
    }

    /**
     * @description Cookie 取得戦略を取得します。未設定時は browser を返します。
     * @returns {Promise<"browser"|"netscape">} 設定値です。
     */
    static async getCookieStrategy() {
        const result = await AsyncSyncStorage.getStorage(["cookie_strategy"]);
        return result["cookie_strategy"] === "netscape" ? "netscape" : "browser";
    }

    /**
     * @description ブラウザプロファイル名 (例: chrome:Default) を保存します。
     * @param {string} profileName プロファイル表記です。
     * @returns {Promise<void>} 保存完了時に解決します。
     */
    static async saveCookieProfile(profileName) {
        const value = (profileName || "").trim() || "chrome:Default";
        await AsyncSyncStorage.setStorage({ cookie_profile: value });
    }

    /**
     * @description ブラウザプロファイル名を取得します。未設定時は chrome:Default を返します。
     * @returns {Promise<string>} プロファイル名です。
     */
    static async getCookieProfile() {
        const result = await AsyncSyncStorage.getStorage(["cookie_profile"]);
        const value = typeof result["cookie_profile"] === "string" ? result["cookie_profile"].trim() : "";
        return value || "chrome:Default";
    }

    /**
     * @description 保存先ディレクトリ設定を保存します。
     * @param {string} directoryPath ユーザーが入力したパスです。
     * @returns {Promise<void>} 保存完了時に解決します。
     */
    static async saveOutputDirectory(directoryPath) {
        const normalized = (directoryPath || "").trim();
        await AsyncSyncStorage.setStorage({ output_dir: normalized });
    }

    /**
     * @description 保存先ディレクトリ設定を取得します。
     * @returns {Promise<string>} 未設定時は空文字列です。
     */
    static async getOutputDirectory() {
        const result = await AsyncSyncStorage.getStorage(["output_dir"]);
        const value = typeof result["output_dir"] === "string" ? result["output_dir"].trim() : "";
        const normalized = stripLegacyOutputDirSuffix(value);
        if (normalized !== value) {
            await AsyncSyncStorage.setStorage({ output_dir: normalized });
        }
        return normalized;
    }

}

/**
 * @description 旧バージョンで付与していた WidevineProxy2 サフィックスを取り除きます。
 * @param {string} value 入力された保存先パスです。
 * @returns {string} サフィックス除去後のパスです。
 */
function stripLegacyOutputDirSuffix(value) {
    if (!value) {
        return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    const legacyPattern = /([/\\])WidevineProxy2(?:[/\\]artifacts)?[/\\]?$/i;
    if (!legacyPattern.test(trimmed)) {
        return trimmed;
    }
    return trimmed.replace(legacyPattern, "").trim() || "";
}

export function intToUint8Array(num) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, num, false);
    return new Uint8Array(buffer);
}

export function compareUint8Arrays(arr1, arr2) {
    if (arr1.length !== arr2.length)
        return false;
    return Array.from(arr1).every((value, index) => value === arr2[index]);
}

export function uint8ArrayToHex(buffer) {
    return Array.prototype.map.call(buffer, x => x.toString(16).padStart(2, '0')).join('');
}

const sharedTextDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const sharedTextEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function uint8ArrayToString(uint8array) {
    if (sharedTextDecoder) {
        return sharedTextDecoder.decode(uint8array);
    }
    return String.fromCharCode.apply(null, uint8array)
}

export function uint8ArrayToBase64(uint8array) {
    if (typeof btoa === "function") {
        let binary = "";
        const sliceSize = 0x8000;
        for (let offset = 0; offset < uint8array.length; offset += sliceSize) {
            const slice = uint8array.subarray(offset, offset + sliceSize);
            binary += String.fromCharCode.apply(null, slice);
        }
        return btoa(binary);
    }
    // eslint-disable-next-line no-undef
    return Buffer.from(uint8array).toString("base64");
}

export function base64toUint8Array(base64_string){
    if (typeof atob === "function") {
        const decoded = atob(base64_string);
        const array = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i += 1) {
            array[i] = decoded.charCodeAt(i);
        }
        return array;
    }
    // eslint-disable-next-line no-undef
    return Uint8Array.from(Buffer.from(base64_string, "base64"));
}

export function stringToUint8Array(string) {
    return Uint8Array.from(string.split("").map(x => x.charCodeAt()))
}

export function stringToHex(string){
    return string.split("").map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
