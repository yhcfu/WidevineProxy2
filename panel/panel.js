import "../protobuf.min.js";
import "../license_protocol.js";
import { base64toUint8Array, DeviceManager, RemoteCDMManager, SettingsManager } from "../util.js";

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

const wvd_combobox = document.getElementById('wvd-combobox');
wvd_combobox.addEventListener('change', async function() {
    await DeviceManager.saveSelectedWidevineDevice(wvd_combobox.options[wvd_combobox.selectedIndex].text);
});

const remote_combobox = document.getElementById('remote-combobox');
remote_combobox.addEventListener('change', async function() {
    await RemoteCDMManager.saveSelectedRemoteCDM(remote_combobox.options[remote_combobox.selectedIndex].text);
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
})

const download = document.getElementById('download');
download.addEventListener('click', async function() {
    const widevine_device = await DeviceManager.getSelectedWidevineDevice();
    SettingsManager.downloadFile(
        base64toUint8Array(await DeviceManager.loadWidevineDevice(widevine_device)),
        widevine_device + ".wvd"
    )
});

const remote_download = document.getElementById('remoteDownload');
remote_download.addEventListener('click', async function() {
    const remote_cdm = await RemoteCDMManager.getSelectedRemoteCDM();
    SettingsManager.downloadFile(
        await RemoteCDMManager.loadRemoteCDM(remote_cdm),
        remote_cdm + ".json"
    )
});

const clear = document.getElementById('clear');
clear.addEventListener('click', async function() {
    chrome.runtime.sendMessage({ type: "CLEAR" });
    key_container.innerHTML = "";
});

document.getElementById('fileInput').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "OPEN_PICKER_WVD" });
    window.close();
});

document.getElementById('remoteInput').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "OPEN_PICKER_REMOTE" });
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
    await SettingsManager.setSelectedDeviceType(await SettingsManager.getSelectedDeviceType());
    await DeviceManager.loadSetAllWidevineDevices();
    await DeviceManager.selectWidevineDevice(await DeviceManager.getSelectedWidevineDevice());
    await RemoteCDMManager.loadSetAllRemoteCDMs();
    await RemoteCDMManager.selectRemoteCDM(await RemoteCDMManager.getSelectedRemoteCDM());
    checkLogs();
});
