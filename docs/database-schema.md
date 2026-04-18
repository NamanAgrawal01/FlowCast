# Database Schema

## Firestore

### `users/{uid}`

Stores lightweight profile data for the authenticated person using the web app.

```json
{
  "email": "owner@example.com",
  "displayName": "Owner Name",
  "createdAt": "timestamp",
  "lastLoginAt": "timestamp"
}
```

### `devices/{deviceId}`

Durable record for each paired laptop agent.

```json
{
  "ownerUid": "firebase-user-uid",
  "authUid": "device-auth-uid",
  "installationId": "local-installation-guid",
  "name": "Naman's Laptop",
  "platform": "win32",
  "platformRelease": "10.0.26100",
  "status": "online",
  "capabilities": {
    "clipboard": true,
    "fileTransfer": true,
    "screenshots": true,
    "audio": false
  },
  "screen": {
    "width": 1920,
    "height": 1080
  },
  "metrics": {
    "lastPingMs": 142,
    "activeLowDataMode": false
  },
  "linkedAt": "timestamp",
  "createdAt": "timestamp",
  "updatedAt": "timestamp",
  "lastSeenAt": "timestamp",
  "lastHeartbeatAt": "timestamp",
  "lastSessionId": "session-id-or-null",
  "revoked": false
}
```

### `pairingCodes/{pairingCode}`

Ephemeral one-time records created by the pairing endpoint.

```json
{
  "registrationId": "random-registration-id",
  "installationId": "local-installation-guid",
  "deviceName": "Naman's Laptop",
  "platform": "win32",
  "status": "pending",
  "createdAt": "timestamp",
  "expiresAt": "timestamp",
  "ownerUid": "set-after-claim",
  "deviceId": "set-after-claim"
}
```

### `deviceRegistrations/{registrationId}`

Private delivery channel for the laptop agent while waiting to be claimed.

```json
{
  "pollTokenHash": "sha256",
  "pairingCode": "123456",
  "installationId": "local-installation-guid",
  "deviceName": "Naman's Laptop",
  "platform": "win32",
  "platformRelease": "10.0.26100",
  "status": "pending",
  "createdAt": "timestamp",
  "updatedAt": "timestamp",
  "expiresAt": "timestamp",
  "ownerUid": "set-after-claim",
  "deviceId": "set-after-claim",
  "deviceEmail": "device-deviceId@flowcast.device.local",
  "devicePassword": "generated-secret"
}
```

### `remoteSessions/{sessionId}`

Lightweight historical record for created sessions.

```json
{
  "ownerUid": "firebase-user-uid",
  "controllerUid": "firebase-user-uid",
  "deviceId": "device-id",
  "deviceAuthUid": "device-auth-uid",
  "state": "connected",
  "manualDisconnectRequested": false,
  "lowDataMode": true,
  "startedAt": "timestamp",
  "updatedAt": "timestamp",
  "endedAt": null
}
```

### `rateLimits/{key}`

Internal sliding window counters used by Cloud Functions.

```json
{
  "count": 3,
  "resetAt": "timestamp",
  "updatedAt": "timestamp"
}
```

## Realtime Database

### `/sessions/{sessionId}`

Live WebRTC session state, signaling data, and heartbeats.

```json
{
  "meta": {
    "sessionId": "session-id",
    "ownerUid": "firebase-user-uid",
    "controllerUid": "firebase-user-uid",
    "deviceId": "device-id",
    "deviceAuthUid": "device-auth-uid",
    "state": "connected",
    "negotiationId": "uuid",
    "manualDisconnectRequested": false,
    "lowDataMode": true,
    "createdAt": 1713410000000,
    "updatedAt": 1713410000000,
    "endedAt": null
  },
  "signals": {
    "offer": {
      "type": "offer",
      "sdp": "v=0...",
      "negotiationId": "uuid",
      "createdAt": 1713410000000
    },
    "answer": {
      "type": "answer",
      "sdp": "v=0...",
      "negotiationId": "uuid",
      "createdAt": 1713410005000
    }
  },
  "offerCandidates": {
    "uuid": {
      "candidate-a": {
        "candidate": "candidate:...",
        "sdpMid": "0",
        "sdpMLineIndex": 0,
        "createdAt": 1713410001000
      }
    }
  },
  "answerCandidates": {
    "uuid": {
      "candidate-b": {
        "candidate": "candidate:...",
        "sdpMid": "0",
        "sdpMLineIndex": 0,
        "createdAt": 1713410006000
      }
    }
  },
  "heartbeat": {
    "controllerAt": 1713410010000,
    "agentAt": 1713410010100,
    "lastPingAt": 1713410010000,
    "lastPongAt": 1713410010100
  },
  "control": {
    "lowDataMode": true
  }
}
```

### `/deviceSessions/{deviceId}/{sessionId}`

Lookup index so the laptop agent can subscribe only to its own sessions.

### `/userSessions/{uid}/{sessionId}`

Lookup index so the web app can restore a non-manually-ended session after refresh or reconnect.
