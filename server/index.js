const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
// THE USER WILL NEED TO PROVIDE A SERVICE ACCOUNT KEY
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
} else {
  // If NO service account provided, try to use default environment (useful for local dev)
  admin.initializeApp();
}

const firestore = admin.firestore();
const rtdb = admin.database();
const adminAuth = admin.auth();

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ACTIVE_SESSION_STATES = new Set(["connecting", "connected", "reconnecting"]);

function nowMillis() { return Date.now(); }
function hashValue(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

// --- API Endpoints ---

// 1. Register Device Pairing
app.post('/registerDevicePairing', async (req, res) => {
    try {
        const { installationId, deviceName, platform, platformRelease } = req.body;
        const pairingCode = `${Math.floor(100000 + Math.random() * 900000)}`;
        const registrationId = firestore.collection("deviceRegistrations").doc().id;
        const pollToken = crypto.randomBytes(24).toString("hex");
        const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS);

        const batch = firestore.batch();
        batch.set(firestore.collection("deviceRegistrations").doc(registrationId), {
            pollTokenHash: hashValue(pollToken),
            pairingCode,
            installationId,
            deviceName: deviceName || "Laptop",
            platform: platform || "unknown",
            status: "pending",
            expiresAt
        });

        batch.set(firestore.collection("pairingCodes").doc(pairingCode), {
            registrationId,
            status: "pending",
            expiresAt
        });

        await batch.commit();

        res.json({ ok: true, registrationId, pollToken, pairingCode, expiresAt: expiresAt.toDate() });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// 2. Poll Device Pairing
app.post('/pollDevicePairing', async (req, res) => {
    try {
        const { registrationId, pollToken } = req.body;
        const regDoc = await firestore.collection("deviceRegistrations").doc(registrationId).get();
        if (!regDoc.exists) return res.status(404).json({ ok: false, error: "Not found" });
        
        const data = regDoc.data();
        if (data.pollTokenHash !== hashValue(pollToken)) return res.status(403).json({ ok: false });

        res.json({ ok: true, status: data.status, deviceId: data.deviceId, deviceEmail: data.deviceEmail, devicePassword: data.devicePassword });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// 3. Claim Device Pairing (Requires Auth Header)
app.post('/claimDevicePairing', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ ok: false, error: "Unauthenticated" });
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const ownerUid = decodedToken.uid;

        const { pairingCode } = req.body;
        const pairingDoc = await firestore.collection("pairingCodes").doc(pairingCode).get();
        
        if (!pairingDoc.exists) return res.status(404).json({ ok: false, error: "Invalid code" });
        
        const pairing = pairingDoc.data();
        const deviceId = firestore.collection("devices").doc().id;
        const deviceEmail = `device-${deviceId}@flowcast.local`;
        const devicePassword = crypto.randomBytes(16).toString('hex');

        await adminAuth.createUser({ uid: deviceId, email: deviceEmail, password: devicePassword });

        const batch = firestore.batch();
        batch.set(firestore.collection("devices").doc(deviceId), {
            ownerUid,
            authUid: deviceId,
            installationId: pairing.installationId,
            name: pairing.deviceName || "Laptop",
            status: "offline",
            capabilities: { clipboard: true, fileTransfer: true, screenshots: true },
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        batch.update(firestore.collection("deviceRegistrations").doc(pairing.registrationId), {
            status: "claimed",
            deviceId,
            deviceEmail,
            devicePassword
        });
        batch.delete(firestore.collection("pairingCodes").doc(pairingCode));

        await batch.commit();
        res.json({ ok: true, deviceId, deviceName: pairing.deviceName });

    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// 4. Create Remote Session
app.post('/createRemoteSession', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const ownerUid = decodedToken.uid;

        const { deviceId, lowDataMode } = req.body;
        const deviceDoc = await firestore.collection("devices").doc(deviceId).get();
        if (!deviceDoc.exists || deviceDoc.data().ownerUid !== ownerUid) {
            return res.status(403).json({ ok: false, error: "Forbidden" });
        }

        const sessionId = rtdb.ref("sessions").push().key;
        const createdAt = Date.now();
        const payload = {
            meta: {
                sessionId, ownerUid, controllerUid: ownerUid, deviceId,
                state: "connecting", createdAt, updatedAt: createdAt
            }
        };

        const updatePayload = {};
        updatePayload[`sessions/${sessionId}`] = payload;
        updatePayload[`deviceSessions/${deviceId}/${sessionId}`] = true;
        updatePayload[`userSessions/${ownerUid}/${sessionId}`] = true;

        await rtdb.ref().update(updatePayload);
        res.json({ ok: true, sessionId, lowDataMode });

    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// 5. Revoke Device
app.post('/revokeDeviceAccess', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        const ownerUid = decodedToken.uid;

        const { deviceId } = req.body;
        const deviceRef = firestore.collection("devices").doc(deviceId);
        const deviceDoc = await deviceRef.get();
        if (!deviceDoc.exists || deviceDoc.data().ownerUid !== ownerUid) {
            return res.status(403).json({ ok: false, error: "Forbidden" });
        }

        await adminAuth.updateUser(deviceId, { disabled: true });
        await deviceRef.update({ revoked: true, status: "revoked" });

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
