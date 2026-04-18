import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import {
  FieldValue,
  Timestamp,
  getFirestore
} from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

initializeApp();

const firestore = getFirestore();
const rtdb = getDatabase();
const adminAuth = getAdminAuth();

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ACTIVE_SESSION_STATES = new Set(["connecting", "connected", "reconnecting"]);

function nowMillis() {
  return Date.now();
}

function timestampFromNow(ms) {
  return Timestamp.fromMillis(nowMillis() + ms);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function requireAuthed(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  return request.auth.uid;
}

function sanitizeString(value, { field, min = 1, max = 128, pattern } = {}) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new HttpsError("invalid-argument", `${field} must be between ${min} and ${max} characters.`);
  }

  if (pattern && !pattern.test(text)) {
    throw new HttpsError("invalid-argument", `${field} is not in the expected format.`);
  }

  return text;
}

function getIpAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return request.ip || "unknown";
}

async function enforceRateLimit(key, limit, windowSeconds) {
  const rateLimitRef = firestore.collection("rateLimits").doc(hashValue(key));

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateLimitRef);
    const currentMillis = nowMillis();
    const resetAtMillis = currentMillis + windowSeconds * 1000;

    let count = 0;
    let resetAt = Timestamp.fromMillis(resetAtMillis);

    if (snapshot.exists) {
      const existing = snapshot.data();
      const existingResetAt = existing?.resetAt instanceof Timestamp
        ? existing.resetAt.toMillis()
        : 0;

      if (existingResetAt > currentMillis) {
        count = Number(existing?.count || 0);
        resetAt = existing.resetAt;
      }
    }

    if (count >= limit) {
      throw new HttpsError("resource-exhausted", "Too many attempts. Please try again later.");
    }

    transaction.set(rateLimitRef, {
      count: count + 1,
      resetAt,
      updatedAt: Timestamp.now()
    }, { merge: true });
  });
}

async function generatePairingCode() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = `${Math.floor(100000 + Math.random() * 900000)}`;
    const snapshot = await firestore.collection("pairingCodes").doc(code).get();

    if (!snapshot.exists) {
      return code;
    }
  }

  throw new HttpsError("aborted", "Unable to reserve a pairing code right now.");
}

async function cleanupExpiredPairings(limit = 25) {
  const now = Timestamp.now();
  const pairingSnapshot = await firestore.collection("pairingCodes")
    .where("expiresAt", "<=", now)
    .limit(limit)
    .get();

  if (pairingSnapshot.empty) {
    return 0;
  }

  const batch = firestore.batch();
  pairingSnapshot.docs.forEach((docSnapshot) => {
    const pairing = docSnapshot.data();
    batch.delete(docSnapshot.ref);
    if (pairing.registrationId) {
      batch.delete(firestore.collection("deviceRegistrations").doc(pairing.registrationId));
    }
  });

  await batch.commit();
  return pairingSnapshot.size;
}

function createDeviceCredentials(deviceId) {
  return {
    email: `device-${deviceId}@flowcast.device.local`,
    password: `${crypto.randomBytes(18).toString("base64url")}Aa1!`
  };
}

function buildRemoteSessionPayload({
  sessionId,
  ownerUid,
  controllerUid,
  deviceId,
  deviceAuthUid,
  lowDataMode
}) {
  const createdAt = nowMillis();

  return {
    meta: {
      sessionId,
      ownerUid,
      controllerUid,
      deviceId,
      deviceAuthUid,
      state: "connecting",
      negotiationId: null,
      manualDisconnectRequested: false,
      lowDataMode: Boolean(lowDataMode),
      createdAt,
      updatedAt: createdAt,
      endedAt: null
    },
    signals: {
      offer: null,
      answer: null
    },
    offerCandidates: {},
    answerCandidates: {},
    heartbeat: {
      controllerAt: createdAt,
      agentAt: null,
      lastPingAt: null,
      lastPongAt: null
    },
    control: {
      lowDataMode: Boolean(lowDataMode)
    }
  };
}

async function syncRemoteSessionRecord(sessionId, payload) {
  await firestore.collection("remoteSessions").doc(sessionId).set(payload, { merge: true });
}

async function listActiveDeviceSessions(deviceId) {
  const indexSnapshot = await rtdb.ref(`deviceSessions/${deviceId}`).get();
  const sessionIds = Object.keys(indexSnapshot.val() || {});
  const active = [];

  for (const sessionId of sessionIds) {
    const metaSnapshot = await rtdb.ref(`sessions/${sessionId}/meta`).get();
    const meta = metaSnapshot.val();
    if (!meta) {
      continue;
    }

    if (!meta.manualDisconnectRequested && ACTIVE_SESSION_STATES.has(meta.state)) {
      active.push({ sessionId, meta });
    }
  }

  return active;
}

function requireRequestBody(request) {
  if (request.method !== "POST") {
    throw new HttpsError("invalid-argument", "POST is required.");
  }

  if (typeof request.body === "string" && request.body.length > 0) {
    return JSON.parse(request.body);
  }

  return request.body || {};
}

function jsonResponse(response, statusCode, payload) {
  response.status(statusCode).set("cache-control", "no-store").json(payload);
}

export const registerDevicePairing = onRequest(async (request, response) => {
  try {
    await cleanupExpiredPairings(10);

    const body = requireRequestBody(request);
    const installationId = sanitizeString(body.installationId, {
      field: "installationId",
      min: 16,
      max: 128,
      pattern: /^[a-zA-Z0-9._-]+$/
    });
    const deviceName = sanitizeString(body.deviceName || "Laptop", {
      field: "deviceName",
      min: 2,
      max: 64
    });
    const platform = sanitizeString(body.platform || "unknown", {
      field: "platform",
      min: 2,
      max: 32,
      pattern: /^[a-zA-Z0-9._ -]+$/
    });
    const platformRelease = sanitizeString(body.platformRelease || "unknown", {
      field: "platformRelease",
      min: 1,
      max: 32,
      pattern: /^[a-zA-Z0-9._ -]+$/
    });

    await enforceRateLimit(`pair-register:${getIpAddress(request)}:${installationId}`, 8, 600);

    const pairingCode = await generatePairingCode();
    const registrationId = firestore.collection("deviceRegistrations").doc().id;
    const pollToken = crypto.randomBytes(24).toString("hex");
    const expiresAt = timestampFromNow(PAIRING_TTL_MS);

    const batch = firestore.batch();
    const registrationRef = firestore.collection("deviceRegistrations").doc(registrationId);
    const pairingRef = firestore.collection("pairingCodes").doc(pairingCode);

    batch.set(registrationRef, {
      pollTokenHash: hashValue(pollToken),
      pairingCode,
      installationId,
      deviceName,
      platform,
      platformRelease,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt
    });

    batch.set(pairingRef, {
      registrationId,
      installationId,
      deviceName,
      platform,
      platformRelease,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      expiresAt
    });

    await batch.commit();

    jsonResponse(response, 200, {
      ok: true,
      registrationId,
      pollToken,
      pairingCode,
      expiresAt: expiresAt.toDate().toISOString()
    });
  } catch (error) {
    logger.error("registerDevicePairing failed", error);
    const statusCode = error instanceof HttpsError
      ? (error.code === "resource-exhausted" ? 429 : 400)
      : 500;
    jsonResponse(response, statusCode, {
      ok: false,
      error: error instanceof HttpsError ? error.message : "Unexpected error."
    });
  }
});

export const pollDevicePairing = onRequest(async (request, response) => {
  try {
    const body = requireRequestBody(request);
    const registrationId = sanitizeString(body.registrationId, {
      field: "registrationId",
      min: 10,
      max: 128,
      pattern: /^[a-zA-Z0-9_-]+$/
    });
    const pollToken = sanitizeString(body.pollToken, {
      field: "pollToken",
      min: 32,
      max: 128,
      pattern: /^[a-zA-Z0-9]+$/
    });

    await enforceRateLimit(`pair-poll:${registrationId}:${getIpAddress(request)}`, 240, 600);

    const registrationRef = firestore.collection("deviceRegistrations").doc(registrationId);
    const registrationSnapshot = await registrationRef.get();

    if (!registrationSnapshot.exists) {
      throw new HttpsError("not-found", "Pairing registration not found.");
    }

    const registration = registrationSnapshot.data();
    if (registration.pollTokenHash !== hashValue(pollToken)) {
      throw new HttpsError("permission-denied", "Invalid pairing poll token.");
    }

    const expiresAt = registration.expiresAt instanceof Timestamp
      ? registration.expiresAt.toMillis()
      : 0;
    if (expiresAt && expiresAt <= nowMillis() && registration.status === "pending") {
      await registrationRef.update({
        status: "expired",
        updatedAt: FieldValue.serverTimestamp()
      });
      jsonResponse(response, 200, { ok: true, status: "expired" });
      return;
    }

    await registrationRef.update({ updatedAt: FieldValue.serverTimestamp() });

    if (registration.status === "claimed") {
      jsonResponse(response, 200, {
        ok: true,
        status: "claimed",
        deviceId: registration.deviceId,
        deviceEmail: registration.deviceEmail,
        devicePassword: registration.devicePassword
      });
      return;
    }

    jsonResponse(response, 200, {
      ok: true,
      status: registration.status || "pending",
      pairingCode: registration.pairingCode
    });
  } catch (error) {
    logger.error("pollDevicePairing failed", error);
    const statusCode = error instanceof HttpsError
      ? (error.code === "permission-denied" ? 403 : 400)
      : 500;
    jsonResponse(response, statusCode, {
      ok: false,
      error: error instanceof HttpsError ? error.message : "Unexpected error."
    });
  }
});

export const claimDevicePairing = onCall(async (request) => {
  const ownerUid = requireAuthed(request);
  await cleanupExpiredPairings(10);

  const pairingCode = sanitizeString(request.data?.pairingCode, {
    field: "pairingCode",
    min: 6,
    max: 6,
    pattern: /^[0-9]{6}$/
  });

  await enforceRateLimit(`pair-claim:${ownerUid}`, 20, 600);

  const pairingRef = firestore.collection("pairingCodes").doc(pairingCode);
  const pairingSnapshot = await pairingRef.get();

  if (!pairingSnapshot.exists) {
    throw new HttpsError("not-found", "Pairing code not found or already expired.");
  }

  const pairing = pairingSnapshot.data();
  const expiresAt = pairing.expiresAt instanceof Timestamp ? pairing.expiresAt.toMillis() : 0;
  if (pairing.status !== "pending" || (expiresAt && expiresAt <= nowMillis())) {
    throw new HttpsError("failed-precondition", "This pairing code is no longer valid.");
  }

  const deviceId = firestore.collection("devices").doc().id;
  const credentials = createDeviceCredentials(deviceId);
  await adminAuth.createUser({
    uid: deviceId,
    email: credentials.email,
    password: credentials.password,
    displayName: pairing.deviceName
  });

  const registrationRef = firestore.collection("deviceRegistrations").doc(pairing.registrationId);
  const deviceRef = firestore.collection("devices").doc(deviceId);
  const userRef = firestore.collection("users").doc(ownerUid);

  const batch = firestore.batch();
  batch.set(deviceRef, {
    ownerUid,
    authUid: deviceId,
    installationId: pairing.installationId,
    name: pairing.deviceName,
    platform: pairing.platform,
    platformRelease: pairing.platformRelease,
    status: "offline",
    revoked: false,
    capabilities: {
      clipboard: true,
      fileTransfer: true,
      screenshots: true,
      audio: false
    },
    screen: {
      width: 0,
      height: 0
    },
    metrics: {
      lastPingMs: null,
      activeLowDataMode: false
    },
    linkedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastSeenAt: null,
    lastHeartbeatAt: null,
    lastSessionId: null,
    appVersion: "1.0.0"
  });

  batch.set(userRef, {
    email: request.auth.token.email || null,
    displayName: request.auth.token.name || null,
    createdAt: FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp()
  }, { merge: true });

  batch.update(pairingRef, {
    status: "claimed",
    ownerUid,
    deviceId,
    claimedAt: FieldValue.serverTimestamp()
  });

  batch.set(registrationRef, {
    status: "claimed",
    ownerUid,
    deviceId,
    deviceEmail: credentials.email,
    devicePassword: credentials.password,
    claimedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await batch.commit();

  return {
    ok: true,
    deviceId,
    deviceName: pairing.deviceName
  };
});

export const createRemoteSession = onCall(async (request) => {
  const ownerUid = requireAuthed(request);
  const deviceId = sanitizeString(request.data?.deviceId, {
    field: "deviceId",
    min: 10,
    max: 128,
    pattern: /^[a-zA-Z0-9_-]+$/
  });
  const lowDataMode = Boolean(request.data?.lowDataMode);

  const deviceRef = firestore.collection("devices").doc(deviceId);
  const deviceSnapshot = await deviceRef.get();
  if (!deviceSnapshot.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }

  const device = deviceSnapshot.data();
  if (device.ownerUid !== ownerUid || device.revoked) {
    throw new HttpsError("permission-denied", "You do not have access to this device.");
  }

  const activeSessions = await listActiveDeviceSessions(deviceId);
  if (activeSessions.length > 0) {
    const existing = activeSessions[0];
    if (existing.meta.controllerUid !== ownerUid) {
      throw new HttpsError("failed-precondition", "This device already has an active controller.");
    }

    return {
      ok: true,
      sessionId: existing.sessionId,
      resumed: true,
      lowDataMode: Boolean(existing.meta.lowDataMode)
    };
  }

  const sessionId = rtdb.ref("sessions").push().key;
  const payload = buildRemoteSessionPayload({
    sessionId,
    ownerUid,
    controllerUid: ownerUid,
    deviceId,
    deviceAuthUid: device.authUid,
    lowDataMode
  });

  const updatePayload = {};
  updatePayload[`sessions/${sessionId}`] = payload;
  updatePayload[`deviceSessions/${deviceId}/${sessionId}`] = true;
  updatePayload[`userSessions/${ownerUid}/${sessionId}`] = true;

  await rtdb.ref().update(updatePayload);
  await syncRemoteSessionRecord(sessionId, {
    ownerUid,
    controllerUid: ownerUid,
    deviceId,
    deviceAuthUid: device.authUid,
    state: "connecting",
    manualDisconnectRequested: false,
    lowDataMode,
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    endedAt: null
  });

  return {
    ok: true,
    sessionId,
    resumed: false,
    lowDataMode
  };
});

export const disconnectRemoteSession = onCall(async (request) => {
  const ownerUid = requireAuthed(request);
  const sessionId = sanitizeString(request.data?.sessionId, {
    field: "sessionId",
    min: 10,
    max: 128,
    pattern: /^[a-zA-Z0-9_-]+$/
  });

  const metaSnapshot = await rtdb.ref(`sessions/${sessionId}/meta`).get();
  const meta = metaSnapshot.val();
  if (!meta) {
    throw new HttpsError("not-found", "Session not found.");
  }

  if (meta.ownerUid !== ownerUid && meta.controllerUid !== ownerUid) {
    throw new HttpsError("permission-denied", "You cannot disconnect this session.");
  }

  const currentMillis = nowMillis();
  const updatePayload = {};
  updatePayload[`sessions/${sessionId}/meta/manualDisconnectRequested`] = true;
  updatePayload[`sessions/${sessionId}/meta/state`] = "manual-disconnect";
  updatePayload[`sessions/${sessionId}/meta/updatedAt`] = currentMillis;
  updatePayload[`sessions/${sessionId}/meta/endedAt`] = currentMillis;
  updatePayload[`deviceSessions/${meta.deviceId}/${sessionId}`] = null;
  updatePayload[`userSessions/${meta.controllerUid}/${sessionId}`] = null;

  await rtdb.ref().update(updatePayload);
  await syncRemoteSessionRecord(sessionId, {
    state: "manual-disconnect",
    manualDisconnectRequested: true,
    updatedAt: FieldValue.serverTimestamp(),
    endedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});

export const revokeDeviceAccess = onCall(async (request) => {
  const ownerUid = requireAuthed(request);
  const deviceId = sanitizeString(request.data?.deviceId, {
    field: "deviceId",
    min: 10,
    max: 128,
    pattern: /^[a-zA-Z0-9_-]+$/
  });

  const deviceRef = firestore.collection("devices").doc(deviceId);
  const deviceSnapshot = await deviceRef.get();
  if (!deviceSnapshot.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }

  const device = deviceSnapshot.data();
  if (device.ownerUid !== ownerUid) {
    throw new HttpsError("permission-denied", "You cannot revoke this device.");
  }

  await adminAuth.updateUser(device.authUid, { disabled: true });

  const activeSessions = await listActiveDeviceSessions(deviceId);
  const updatePayload = {};
  for (const { sessionId, meta } of activeSessions) {
    updatePayload[`sessions/${sessionId}/meta/manualDisconnectRequested`] = true;
    updatePayload[`sessions/${sessionId}/meta/state`] = "manual-disconnect";
    updatePayload[`sessions/${sessionId}/meta/updatedAt`] = nowMillis();
    updatePayload[`sessions/${sessionId}/meta/endedAt`] = nowMillis();
    updatePayload[`deviceSessions/${deviceId}/${sessionId}`] = null;
    updatePayload[`userSessions/${meta.controllerUid}/${sessionId}`] = null;

    await syncRemoteSessionRecord(sessionId, {
      state: "manual-disconnect",
      manualDisconnectRequested: true,
      updatedAt: FieldValue.serverTimestamp(),
      endedAt: FieldValue.serverTimestamp()
    });
  }

  if (Object.keys(updatePayload).length > 0) {
    await rtdb.ref().update(updatePayload);
  }

  await deviceRef.update({
    revoked: true,
    status: "revoked",
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});
