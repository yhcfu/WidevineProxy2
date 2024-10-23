import { WidevineDevice } from "./device.js";

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
}

export class SettingsManager {
    static async setEnabled(enabled) {
        await AsyncSyncStorage.setStorage({ enabled: enabled });
    }

    static async getEnabled() {
        const result = await AsyncSyncStorage.getStorage(["enabled"]);
        return result["enabled"] === undefined ? false : result["enabled"];
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
        })
    }
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

export function uint8ArrayToString(uint8array) {
    return String.fromCharCode.apply(null, uint8array)
}

export function uint8ArrayToBase64(uint8array) {
    return btoa(String.fromCharCode.apply(null, uint8array));
}

export function base64toUint8Array(base64_string){
    return Uint8Array.from(atob(base64_string), c => c.charCodeAt(0))
}

export function stringToUint8Array(string) {
    return Uint8Array.from(string.split("").map(x => x.charCodeAt()))
}

export function stringToHex(string){
    return string.split("").map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
