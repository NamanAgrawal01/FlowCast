# Architecture

## Stack

- Frontend: plain HTML, CSS, JavaScript on Firebase Hosting
- Auth: Firebase Auth email/password
- Durable database: Firestore
- Live signaling and heartbeat: Firebase Realtime Database
- Backend logic: Firebase Functions v2
- Desktop agent: Node.js, WebRTC, screen capture, native mouse/keyboard control

## Request flow

1. A user signs in from the mobile web UI.
2. The laptop agent requests a 6-digit pairing code from a Cloud Function.
3. The user claims that code from the web app.
4. A device-scoped Firebase Auth account is minted for the laptop agent.
5. The agent signs in and listens for live session IDs under `deviceSessions/{deviceId}` in Realtime Database.
6. The web app creates a remote session through a callable Function.
7. The browser posts an SDP offer and ICE candidates into Realtime Database.
8. The agent responds with an SDP answer, streams desktop video, and opens the control data channel.
9. Mouse, keyboard, clipboard, file transfer, and screenshot commands flow over the data channel.
10. Heartbeats continue until the user manually disconnects.

## Session lifecycle

- `connecting`: browser created a session and published a fresh SDP offer
- `connected`: data channel and media stream are active
- `reconnecting`: peer connection dropped and the browser is issuing a new offer on the same session
- `manual-disconnect`: user explicitly ended the session
- `ended`: historical terminal state

The reconnect loop intentionally does not auto-end the session on inactivity. If the network blips, the browser keeps trying to re-offer the session until the user presses Disconnect.

## Bandwidth strategy

- Default mode captures the desktop at a reduced frame rate instead of full-motion video conferencing rates.
- Low-data mode reduces both resolution and frame rate further.
- The agent boosts frame rate temporarily after fresh user input and drops back down when idle.
- WebRTC handles actual codec negotiation and transport encryption.

## Security model

- Human users authenticate with Firebase Auth.
- Device agents receive dedicated Firebase Auth credentials after successful pairing.
- Firestore stores device ownership and revocation state.
- Realtime Database rules limit live session access to the owning user and the paired device.
- Pairing endpoints are rate-limited and pairing codes expire automatically.

