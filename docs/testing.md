# Testing Guide

## Manual smoke test

1. Sign up from the web UI.
2. Start the laptop agent and verify it prints a pairing code.
3. Claim the code in the dashboard.
4. Confirm the device appears in the list.
5. Start a remote session.
6. Verify the desktop video appears within a few seconds.
7. Tap to click, drag to move, and use the special key buttons.
8. Toggle low-data mode and confirm the session remains active.
9. Copy clipboard text in both directions.
10. Upload a small file to the laptop.
11. Download a file from the laptop using a home-directory path.
12. Capture a screenshot and confirm the file downloads on the phone.
13. Press Disconnect and confirm the session ends on both sides.

## Stability test

1. Start a session.
2. Disable Wi-Fi or mobile data on the controller for 5 to 10 seconds.
3. Re-enable connectivity.
4. Confirm the UI shows `Reconnecting` and then returns to `Connected`.
5. Confirm the session does not end unless Disconnect is pressed.

## Browser refresh restore test

1. Start a session.
2. Refresh the browser tab without pressing Disconnect.
3. Sign back in if needed.
4. Confirm the active session is restored automatically.

## Security validation

- Confirm an unauthenticated browser cannot read device data.
- Confirm one user cannot pair a code already claimed by another.
- Confirm repeated invalid pairing attempts trigger rate limits.
- Confirm a revoked device can no longer sign in or connect.

## Debugging tips

- Use the browser devtools console for WebRTC logs.
- Use `chrome://webrtc-internals` when testing in Chrome.
- Watch Firebase emulator logs when validating Functions or rules locally.
- Inspect the agent terminal for pairing, session, and transport logs.
