import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import robot from "@jitsi/robotjs";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { doc, getFirestore, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { getDatabase, onValue, ref } from "firebase/database";
import { config } from "./config.js";
import { SessionAgent } from "./session-agent.js";

const INSTALLATION_FILE = path.join(config.stateDir, "installation.json");
const CREDENTIALS_FILE = path.join(config.stateDir, "credentials.json");

const app = initializeApp(config.firebase);
const auth = getAuth(app);
const firestore = getFirestore(app);
const rtdb = getDatabase(app);

const sessions = new Map();
let shuttingDown = false;
let deviceId = null;
let deviceDocUnsubscribe = null;
let sessionIndexUnsubscribe = null;
let presenceTimer = null;

function log(message) {
  console.log(`[agent] ${message}`);
}

async function ensureStateDir() {
  await fs.mkdir(config.stateDir, { recursive: true });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadInstallationInfo() {
  await ensureStateDir();
  const existing = await readJson(INSTALLATION_FILE);
  if (existing?.installationId) {
    return existing;
  }

  const created = {
    installationId: crypto.randomUUID(),
    deviceName: process.env.DEVICE_NAME || os.hostname()
  };
  await writeJson(INSTALLATION_FILE, created);
  return created;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPairingFlow(installation) {
  while (true) {
    const registerPayload = await postJson(`${config.functionsBaseUrl}/registerDevicePairing`, {
      installationId: installation.installationId,
      deviceName: installation.deviceName,
      platform: process.platform,
      platformRelease: os.release()
    });

    log(`Pair this laptop with code ${registerPayload.pairingCode}. Expires at ${registerPayload.expiresAt}`);

    while (true) {
      await wait(3000);
      const pollPayload = await postJson(`${config.functionsBaseUrl}/pollDevicePairing`, {
        registrationId: registerPayload.registrationId,
        pollToken: registerPayload.pollToken
      });

      if (pollPayload.status === "claimed") {
        const credentials = {
          deviceEmail: pollPayload.deviceEmail,
          devicePassword: pollPayload.devicePassword
        };
        await writeJson(CREDENTIALS_FILE, credentials);
        return credentials;
      }

      if (pollPayload.status === "expired") {
        log("Pairing code expired. Requesting a new one.");
        break;
      }
    }
  }
}

async function signInDevice(credentials) {
  try {
    await signInWithEmailAndPassword(auth, credentials.deviceEmail, credentials.devicePassword);
    return credentials;
  } catch (error) {
    if (
      error.code === "auth/user-disabled" ||
      error.code === "auth/invalid-credential" ||
      error.code === "auth/user-not-found"
    ) {
      log("Saved device credentials are no longer valid. Re-pairing is required.");
      await fs.rm(CREDENTIALS_FILE, { force: true });
      const installation = await loadInstallationInfo();
      const repairedCredentials = await runPairingFlow(installation);
      await signInWithEmailAndPassword(auth, repairedCredentials.deviceEmail, repairedCredentials.devicePassword);
      return repairedCredentials;
    }

    throw error;
  }
}

async function updatePresence(status = "online") {
  if (!deviceId) {
    return;
  }

  const screen = robot.getScreenSize();
  await updateDoc(doc(firestore, "devices", deviceId), {
    status,
    screen,
    metrics: {
      lastPingMs: null,
      activeLowDataMode: false
    },
    appVersion: "1.0.0",
    lastSeenAt: serverTimestamp(),
    lastHeartbeatAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }).catch((error) => {
    log(`Presence update failed: ${error.message}`);
  });
}

async function synchronizeSessionAgents(sessionIds) {
  for (const sessionId of sessionIds) {
    if (sessions.has(sessionId)) {
      continue;
    }

    const agent = new SessionAgent({
      sessionId,
      deviceId,
      firestore,
      rtdb,
      logger: log
    });
    sessions.set(sessionId, agent);
    await agent.start();
    await updateDoc(doc(firestore, "devices", deviceId), {
      lastSessionId: sessionId,
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }

  for (const [sessionId, agent] of sessions.entries()) {
    if (!sessionIds.includes(sessionId)) {
      agent.dispose();
      sessions.delete(sessionId);
    }
  }
}

async function bootstrapRealtime() {
  const deviceDocRef = doc(firestore, "devices", deviceId);
  deviceDocUnsubscribe = onSnapshot(deviceDocRef, (snapshot) => {
    const data = snapshot.data();
    if (!data) {
      return;
    }

    if (data.revoked) {
      log("Device access has been revoked by the owner.");
      shutdown(0).catch(() => {});
    }
  });

  sessionIndexUnsubscribe = onValue(ref(rtdb, `deviceSessions/${deviceId}`), async (snapshot) => {
    const sessionIds = Object.keys(snapshot.val() || {});
    await synchronizeSessionAgents(sessionIds);
  });

  presenceTimer = setInterval(() => {
    updatePresence("online").catch(() => {});
  }, 5000);
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(presenceTimer);
  deviceDocUnsubscribe?.();
  sessionIndexUnsubscribe?.();

  for (const agent of sessions.values()) {
    agent.dispose();
  }
  sessions.clear();

  await updatePresence("offline");
  process.exit(code);
}

async function main() {
  const installation = await loadInstallationInfo();
  let credentials = await readJson(CREDENTIALS_FILE);
  if (!credentials?.deviceEmail || !credentials?.devicePassword) {
    credentials = await runPairingFlow(installation);
  }

  await signInDevice(credentials);
  deviceId = auth.currentUser.uid;
  log(`Signed in as device ${deviceId}.`);

  await updatePresence("online");
  await bootstrapRealtime();
  log("Laptop agent is now listening for remote sessions.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("SIGINT", () => {
    shutdown(0).catch(() => process.exit(1));
  });

  process.on("SIGTERM", () => {
    shutdown(0).catch(() => process.exit(1));
  });

  main().catch((error) => {
    log(`Fatal startup error: ${error.message}`);
    process.exit(1);
  });
}
