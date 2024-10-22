import "./protobuf.min.js";
import "./license_protocol.js";
import "./forge.min.js";

import { Session } from "./license.js";
import { DeviceManager, base64toUint8Array, uint8ArrayToBase64, uint8ArrayToHex, SettingsManager, AsyncLocalStorage } from "./util.js";
import { WidevineDevice } from "./device.js";

const { LicenseType, SignedMessage, LicenseRequest, License } = protobuf.roots.default.license_protocol;

let sessions = new Map();
let logs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        switch (message.type) {
            case "REQUEST":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    return;
                }
                try {
                    JSON.parse(atob(message.body));
                    sendResponse(message.body);
                    return;
                } catch {
                    if (message.body) {
                        const signed_message =  SignedMessage.decode(base64toUint8Array(message.body));
                        const license_request = LicenseRequest.decode(signed_message.msg);
                        const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

                        if (!pssh_data) {
                            sendResponse(message.body); // TODO: send report message back or just log from background script
                            return;
                        }

                        if (logs.filter(log => log.pssh_data === uint8ArrayToBase64(pssh_data)).length > 0) {
                            console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${uint8ArrayToBase64(pssh_data)}`);
                            sendResponse(message.body);
                            return;
                        }

                        const selected_device_name = await DeviceManager.getSelectedWidevineDevice();
                        if (!selected_device_name) {
                            sendResponse(message.body);
                            return;
                        }

                        const device_b64 = await DeviceManager.loadWidevineDevice(selected_device_name);
                        const widevine_device = new WidevineDevice(base64toUint8Array(device_b64).buffer);

                        const private_key = `-----BEGIN RSA PRIVATE KEY-----${uint8ArrayToBase64(widevine_device.private_key)}-----END RSA PRIVATE KEY-----`;
                        const session = new Session(
                            {
                                privateKey: private_key,
                                identifierBlob: widevine_device.client_id_bytes
                            },
                            pssh_data
                        );

                        const [challenge, request_id] = session.createLicenseRequest(LicenseType.STREAMING, widevine_device.type === 2);
                        sessions.set(uint8ArrayToBase64(request_id), session);

                        sendResponse(uint8ArrayToBase64(challenge));
                    }
                }
                break;

            case "RESPONSE":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    return;
                }
                const tab_url = sender.tab ? sender.tab.url : null;

                try {
                    const clearkey = JSON.parse(atob(message.body));

                    const formatted_keys = clearkey["keys"].map(key => ({
                        ...key,
                        kid: uint8ArrayToHex(base64toUint8Array(key.kid.replace(/-/g, "+").replace(/_/g, "/") + "==")),
                        k: uint8ArrayToHex(base64toUint8Array(key.k.replace(/-/g, "+").replace(/_/g, "/") + "=="))
                    }));
                    const pssh_data = btoa(JSON.stringify({kids: clearkey["keys"].map(key => key.k)}));

                    if (logs.filter(log => log.pssh_data === pssh_data).length > 0) {
                        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${pssh_data}`);
                        sendResponse();
                        return;
                    }

                    console.log("keys", formatted_keys);
                    const log = {
                        type: "CLEARKEY",
                        pssh_data: pssh_data,
                        keys: formatted_keys,
                        url: tab_url,
                        timestamp: Math.floor(Date.now() / 1000)
                    }
                    logs.push(log);

                    await AsyncLocalStorage.setStorage({[pssh_data]: log});
                    sendResponse();
                    return;
                } catch (e) {
                    const license = base64toUint8Array(message.body);
                    const signed_license_message = SignedMessage.decode(license);
                    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
                        console.log("[WidevineProxy2]", "INVALID_MESSAGE_TYPE", signed_license_message.type.toString())
                        sendResponse();
                        return;
                    }

                    const license_obj = License.decode(signed_license_message.msg);
                    const loaded_request_id = uint8ArrayToBase64(license_obj.id.requestId);

                    if (!sessions.has(loaded_request_id)) {
                        sendResponse();
                        return;
                    }

                    const loadedSession = sessions.get(loaded_request_id);
                    const keys = await loadedSession.parseLicense(license);
                    const pssh = loadedSession.getPSSH();

                    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tab_url);
                    const log = {
                        type: "WIDEVINE",
                        pssh_data: pssh,
                        keys: keys,
                        url: tab_url,
                        timestamp: Math.floor(Date.now() / 1000)
                    }
                    logs.push(log);
                    await AsyncLocalStorage.setStorage({[pssh]: log});

                    sessions.delete(loaded_request_id);
                    sendResponse();
                    return;
                }
            case "GET_LOGS":
                sendResponse(logs);
                break;
            case "OPEN_PICKER":
                chrome.windows.create({
                    url: 'picker/filePicker.html',
                    type: 'popup',
                    width: 300,
                    height: 200,
                });
                break;
            case "CLEAR":
                logs = [];
                break;
        }
    })();
    return true;
});
