export class RemoteCdm {
    constructor(device_type, system_id, security_level, host, secret, device_name) {
        this.device_type = device_type;
        this.system_id = system_id;
        this.security_level = security_level;
        this.host = host;
        this.secret = secret;
        this.device_name = device_name;
    }

    static from_object(obj) {
        return new RemoteCdm(
            obj.device_type,
            obj.system_id,
            obj.security_level,
            obj.host,
            obj.secret,
            obj.device_name ?? obj.name,
        );
    }

    get_name() {
        const type = this.device_type === "CHROME" ? "CHROME" : `L${this.security_level}`
        return `[${type}] ${this.host}/${this.device_name} (${this.system_id})`;
    }

    async open() {
        const open_request = await fetch(
            `${this.host}/${this.device_name}/open`,
            {
                method: 'GET',
                headers: {
                    "X-Secret-Key": this.secret
                }
            }
        );
        console.log("[WidevineProxy2]", "REMOTE_CDM", "OPEN", open_request.status);
        const open_json = await open_request.json();
        if (!open_json?.data?.session_id) {
            console.error("REMOTE_CDM OPEN エラー", open_json);
            throw new Error("Remote CDM がセッションIDを返却しませんでした。");
        }

        return open_json.data.session_id;
    }

    async close(session_id) {
        const close_request = await fetch(
            `${this.host}/${this.device_name}/close/${session_id}`,
            {
                method: 'GET',
                headers: {
                    "X-Secret-Key": this.secret
                }
            }
        );
        console.log("[WidevineProxy2]", "REMOTE_CDM", "CLOSE", close_request.status);
    }

    // TODO:
    //   + get_service_certificate
    //   + set_service_certificate

    async get_license_challenge(session_id, pssh, privacy_mode) {
        const license_request = await fetch(
            `${this.host}/${this.device_name}/get_license_challenge/STREAMING`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "X-Secret-Key": this.secret
                },
                body: JSON.stringify({
                    session_id: session_id,
                    init_data: pssh,
                    privacy_mode: privacy_mode
                })
            }
        )
        console.log("[WidevineProxy2]", "REMOTE_CDM", "GET_LICENSE_CHALLENGE", license_request.status);
        const license_request_json = await license_request.json();
        if (!license_request_json?.data?.challenge_b64) {
            console.error("REMOTE_CDM GET_LICENSE_CHALLENGE エラー", license_request_json);
            throw new Error("Remote CDM が challenge_b64 を返却しませんでした。");
        }

        return license_request_json.data.challenge_b64;
    }

    async parse_license(session_id, license_b64) {
        const license = await fetch(
            `${this.host}/${this.device_name}/parse_license`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "X-Secret-Key": this.secret
                },
                body: JSON.stringify({
                    session_id: session_id,
                    license_message: license_b64
                })
            }
        )
        console.log("[WidevineProxy2]", "REMOTE_CDM", "PARSE_LICENSE", license.status);
    }

    async get_keys(session_id, type) {
        const key_request = await fetch(
            `${this.host}/${this.device_name}/get_keys/${type}`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "X-Secret-Key": this.secret
                },
                body: JSON.stringify({
                    session_id: session_id
                })
            }
        )
        console.log("[WidevineProxy2]", "REMOTE_CDM", "GET_KEYS", key_request.status);
        const key_request_json = await key_request.json();
        if (!Array.isArray(key_request_json?.data?.keys)) {
            console.error("REMOTE_CDM GET_KEYS エラー", key_request_json);
            throw new Error("Remote CDM が鍵一覧を返却しませんでした。");
        }

        return key_request_json.data.keys;
    }
}
