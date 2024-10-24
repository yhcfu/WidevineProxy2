function uint8ArrayToBase64(uint8array) {
    return btoa(String.fromCharCode.apply(null, uint8array));
}

function base64toUint8Array(base64_string){
    return Uint8Array.from(atob(base64_string), c => c.charCodeAt(0))
}

function compareUint8Arrays(arr1, arr2) {
    if (arr1.length !== arr2.length)
        return false;
    return Array.from(arr1).every((value, index) => value === arr2[index]);
}

function emitAndWaitForResponse(type, data) {
    return new Promise((resolve) => {
        const requestId = Math.random().toString(16).substring(2, 9);

        const responseHandler = (event) => {
            const { detail } = event;
            if (detail.substring(0, 7) === requestId) {
                document.removeEventListener('responseReceived', responseHandler);
                resolve(detail.substring(7));
            }
        };
        document.addEventListener('responseReceived', responseHandler);
        const requestEvent = new CustomEvent('response', {
            detail: {
                type: type,
                body: data,
                requestId: requestId,
            }
        });
        document.dispatchEvent(requestEvent);
    });
}

const fnproxy = (object, func) => new Proxy(object, { apply: func });
const proxy = (object, key, func) => Object.hasOwnProperty.call(object, key) && Object.defineProperty(object, key, {
    value: fnproxy(object[key], func)
});

function getEventListeners(type) {
    if (this == null) return [];
    const store = this[Symbol.for(getEventListeners)];
    if (store == null || store[type] == null) return [];
    return store[type];
}

(async () => {
    if (typeof EventTarget !== 'undefined') {
        proxy(EventTarget.prototype, 'addEventListener', async (_target, _this, _args) => {
            if (_this != null) {
                const [type, listener] = _args;

                const storeKey = Symbol.for(getEventListeners);
                if (!(storeKey in _this)) _this[storeKey] = {};

                const store = _this[storeKey];
                if (!(type in store)) store[type] = [];
                const listeners = store[type];

                let wrappedListener = listener;
                if (type === "message" && !!listener && !listener._isWrapped) {
                    wrappedListener = async function(event) {
                        if (event instanceof MediaKeyMessageEvent) {
                            if (event._isCustomEvent) {
                                if (listener.handleEvent) {
                                    listener.handleEvent(event);
                                } else {
                                    listener.call(this, event);
                                }
                                return;
                            }

                            let newBody = new Uint8Array(event.message);
                            if (!compareUint8Arrays(new Uint8Array([0x08, 0x04]), new Uint8Array(event.message))) {
                                console.log("[WidevineProxy2]", "WIDEVINE_PROXY", "MESSAGE", listener);
                                if (listener.name !== "messageHandler") {
                                    const oldChallenge = uint8ArrayToBase64(new Uint8Array(event.message));
                                    const newChallenge = await emitAndWaitForResponse("REQUEST", oldChallenge);
                                    if (oldChallenge !== newChallenge) {
                                        // Playback will fail if the challenges are the same (aka. the background script
                                        // returned the same challenge because the addon is disabled), but I still
                                        // override the challenge anyway, so check beforehand (in base64 form)
                                        newBody = base64toUint8Array(newChallenge);
                                    }
                                } else {
                                    // trick EME Logger
                                    // better suggestions for avoiding EME Logger interference are welcome
                                    await emitAndWaitForResponse("REQUEST", "");
                                }
                            }

                            const newEvent = new MediaKeyMessageEvent('message', {
                                isTrusted: event.isTrusted,
                                bubbles: event.bubbles,
                                cancelBubble: event.cancelBubble,
                                composed: event.composed,
                                currentTarget: event.currentTarget,
                                defaultPrevented: event.defaultPrevented,
                                eventPhase: event.eventPhase,
                                message: newBody.buffer,
                                messageType: event.messageType,
                                returnValue: event.returnValue,
                                srcElement: event.srcElement,
                                target: event.target,
                                timeStamp: event.timeStamp,
                            });
                            newEvent._isCustomEvent = true;

                            _this.dispatchEvent(newEvent);
                            event.stopImmediatePropagation();
                            return
                        }

                        if (listener.handleEvent) {
                            listener.handleEvent(event);
                        } else {
                            listener.call(this, event);
                        }
                    };

                    wrappedListener._isWrapped = true;
                    wrappedListener.originalListener = listener;
                }

                const alreadyAdded = listeners.some(
                    storedListener => storedListener && storedListener.originalListener === listener
                );

                if (!alreadyAdded) {
                    listeners.push(wrappedListener);
                    _args[1] = wrappedListener;
                }
            }
            return _target.apply(_this, _args);
        });
    }

    if (typeof MediaKeySession !== 'undefined') {
        proxy(MediaKeySession.prototype, 'update', async (_target, _this, _args) => {
            const [response] = _args;
            console.log("[WidevineProxy2]", "WIDEVINE_PROXY", "UPDATE");
            await emitAndWaitForResponse("RESPONSE", uint8ArrayToBase64(new Uint8Array(response)))
            return await _target.apply(_this, _args);
        });
    }
})();
