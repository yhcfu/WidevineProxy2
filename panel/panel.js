import "../protobuf.min.js";
import "../license_protocol.js";
import { base64toUint8Array, DeviceManager, SettingsManager } from "../util.js";

const key_container = document.getElementById('key-container');

const toggle = document.getElementById('darkModeToggle');
toggle.addEventListener('change', async () => {
    await SettingsManager.setDarkMode(toggle.checked);
    await SettingsManager.saveDarkMode(toggle.checked);
});

const enabled = document.getElementById('enabled');
enabled.addEventListener('change', async function (){
    await SettingsManager.setEnabled(enabled.checked);
});

const wvd_combobox = document.getElementById('wvd-combobox');
wvd_combobox.addEventListener('change', async function() {
    await DeviceManager.saveSelectedWidevineDevice(wvd_combobox.options[wvd_combobox.selectedIndex].text);
});

const remove = document.getElementById('remove');
remove.addEventListener('click', async function() {
    await DeviceManager.removeSelectedWidevineDevice();
    wvd_combobox.innerHTML = '';
    await DeviceManager.loadSetAllWidevineDevices();
    const selected_option = wvd_combobox.options[wvd_combobox.selectedIndex];
    if (selected_option) {
        await DeviceManager.saveSelectedWidevineDevice(selected_option.text);
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

const clear = document.getElementById('clear');
clear.addEventListener('click', async function() {
    chrome.runtime.sendMessage({ type: "CLEAR" });
    key_container.innerHTML = "";
});

document.getElementById('fileInput').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "OPEN_PICKER" });
    window.close();
});

function appendLog(result) {
    const key_string = result.keys.map(key => `--key ${key.kid}:${key.k}`).join(' ');
    const date = new Date(result.timestamp * 1000);
    const date_string = date.toLocaleString();

    key_container.innerHTML += `
                <div class="log-container">
                    <button class="toggleButton">+</button>
                    <div class="expandableDiv collapsed">
                        <label class="always-visible right-bound">
                            URL:<input id="url" type="text" class="text-box" value="${result.url}">
                        </label>
                        <label class="expanded-only right-bound">
                            PSSH:<input id="pssh" type="text" class="text-box" value="${result.pssh_data}">
                        </label>
                        <label class="expanded-only right-bound">
                            Keys:<input id="keys" type="text" class="text-box" value="${key_string}">
                        </label>
                        <label class="expanded-only right-bound">
                            Date:<input id="date" type="text" class="text-box" value="${date_string}">
                        </label>
                    </div>
                </div>`
}

function applyListeners() {
    const toggleButtons = document.querySelectorAll('.toggleButton');
    toggleButtons.forEach(button => {
        button.addEventListener('click', function () {
            const expandableDiv = this.nextElementSibling;
            if (expandableDiv.classList.contains('collapsed')) {
                button.innerHTML = "-";
                expandableDiv.classList.remove('collapsed');
                expandableDiv.classList.add('expanded');
            } else {
                button.innerHTML = "+";
                expandableDiv.classList.remove('expanded');
                expandableDiv.classList.add('collapsed');
            }
        });
    });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        for (const [key, values] of Object.entries(changes)) {
            appendLog(values.newValue);
            applyListeners();
        }
    }
});

function checkLogs() {
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, function(response) {
        if (response) {
            response.forEach((result) => {
                appendLog(result);
            });
            applyListeners();
        }
    });
}

document.addEventListener('DOMContentLoaded', async function () {
    enabled.checked = await SettingsManager.getEnabled();
    SettingsManager.setDarkMode(await SettingsManager.getDarkMode());
    await DeviceManager.loadSetAllWidevineDevices();
    await DeviceManager.selectWidevineDevice(await DeviceManager.getSelectedWidevineDevice());
    checkLogs();
});
