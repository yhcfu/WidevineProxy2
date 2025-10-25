# Notes: d_anime Native Host Flow

This document captures observed patterns from `/Users/hasegawa/app/d_anime_discord_presence/packages/native-host/src`,
so we can compare them with WidevineProxy2 native host integration.

## High-level flow

- `main.rs` uses `tokio::main`, async runtime, and continuously reads from stdin.
- Message structure is JSON with fields like `message_type`.
- They queue updates for Discord presence and keep the process alive.

## Differences observed

1. **Message frequency**
   - d_anime bridges send updates frequently (`UPDATE`, `CLEAR`, etc.).
   - This heavy usage keeps the native host alive and prevents Chrome from closing the port.

2. **Long-lived workers**
   - Service worker equivalent in d_anime keeps calling `assertNative()` to ensure the port is open.
   - They maintain `isNativeConnected` and send data whenever the user interacts or playback changes.

3. **Native host complexity**
   - Uses adapters, service registry, Discord communication.
   - Multi-module with `DiscordManager` etc. Writes logs via tracing.

4. **Keepalive**
   - Not explicitly alarms-based but frequent messages naturally serve as keepalive.

Key idea for WidevineProxy2: we need to build a consistent flow of messages/queue jobs so the port does not idle. The new ping/pong handshake + `chrome.alarms` should imitate this, but until real job payloads send, the connection gets closed by Chrome.
