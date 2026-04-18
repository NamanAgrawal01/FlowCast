import { collection, onSnapshot, query, where } from "firebase/firestore";
import { get, onValue, ref } from "firebase/database";
import { configReady, db, observeAuth, rtdb, callFunction, signInUser, signOutUser, signUpUser } from "./firebase-app.js";
import { RemoteSession } from "./remote-session.js";
import { formatBytes } from "./protocol.js";

const elements = {
  authForm: document.getElementById("authForm"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  authSubmit: document.getElementById("authSubmit"),
  authModeToggle: document.getElementById("authModeToggle"),
  authView: document.getElementById("authView"),
  sessionView: document.getElementById("sessionView"),
  signOutButton: document.getElementById("signOutButton"),
  currentUserEmail: document.getElementById("currentUserEmail"),
  configWarning: document.getElementById("configWarning"),
  pairForm: document.getElementById("pairForm"),
  pairCodeInput: document.getElementById("pairCodeInput"),
  deviceList: document.getElementById("deviceList"),
  connectionPill: document.getElementById("connectionPill"),
  activeDeviceName: document.getElementById("activeDeviceName"),
  connectButton: document.getElementById("connectButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  lowDataToggle: document.getElementById("lowDataToggle"),
  remoteVideo: document.getElementById("remoteVideo"),
  remotePlaceholder: document.getElementById("remotePlaceholder"),
  remoteTouchpad: document.getElementById("remoteTouchpad"),
  leftClickButton: document.getElementById("leftClickButton"),
  rightClickButton: document.getElementById("rightClickButton"),
  dragToggleButton: document.getElementById("dragToggleButton"),
  textInputForm: document.getElementById("textInputForm"),
  textToSend: document.getElementById("textToSend"),
  pushClipboardButton: document.getElementById("pushClipboardButton"),
  pullClipboardButton: document.getElementById("pullClipboardButton"),
  screenshotButton: document.getElementById("screenshotButton"),
  clipboardPreview: document.getElementById("clipboardPreview"),
  uploadButton: document.getElementById("uploadButton"),
  fileUploadInput: document.getElementById("fileUploadInput"),
  downloadButton: document.getElementById("downloadButton"),
  downloadPathInput: document.getElementById("downloadPathInput"),
  sessionIdValue: document.getElementById("sessionIdValue"),
  resolutionValue: document.getElementById("resolutionValue"),
  heartbeatValue: document.getElementById("heartbeatValue"),
  transferValue: document.getElementById("transferValue"),
  logOutput: document.getElementById("logOutput"),
  specialKeys: Array.from(document.querySelectorAll(".special-key")),
  comboKeys: Array.from(document.querySelectorAll(".combo-key"))
};

const state = {
  authMode: "signin",
  user: null,
  devices: [],
  selectedDeviceId: null,
  activeSession: null,
  restoreUnsubscribe: null,
  deviceUnsubscribe: null,
  dragMode: false,
  pointer: null,
  moveThrottleAt: 0
};

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  const lines = elements.logOutput.textContent.split("\n").filter(Boolean);
  lines.unshift(`[${timestamp}] ${message}`);
  elements.logOutput.textContent = lines.slice(0, 18).join("\n");
}

function setPill(text, stateName = "offline") {
  elements.connectionPill.textContent = text;
  elements.connectionPill.dataset.state = stateName;
}

function setTransfer(text) {
  elements.transferValue.textContent = text;
}

function setActiveDevice(device) {
  elements.activeDeviceName.textContent = device ? device.name : "No device connected";
}

function setVideoStream(stream) {
  elements.remoteVideo.srcObject = stream;
  elements.remotePlaceholder.hidden = Boolean(stream);
}

function updateAuthModeUI() {
  const isSignIn = state.authMode === "signin";
  elements.authSubmit.textContent = isSignIn ? "Sign in" : "Create account";
  elements.authModeToggle.textContent = isSignIn
    ? "Need an account? Create one"
    : "Already have an account? Sign in";
}

function renderDevices() {
  const selectedId = state.selectedDeviceId;
  elements.deviceList.innerHTML = "";

  if (!state.user) {
    elements.deviceList.innerHTML = `<p class="muted-line">Sign in to view linked devices.</p>`;
    elements.connectButton.disabled = true;
    return;
  }

  if (state.devices.length === 0) {
    elements.deviceList.innerHTML = `<p class="muted-line">No devices linked yet. Start the laptop agent, then enter its pairing code above.</p>`;
    elements.connectButton.disabled = true;
    return;
  }

  state.devices.forEach((device) => {
    const article = document.createElement("article");
    article.className = `device-item${selectedId === device.id ? " active" : ""}`;
    article.innerHTML = `
      <div class="device-topline">
        <div>
          <div class="device-name">${device.name}</div>
          <div class="device-meta">${device.platform || "unknown"} · ${device.screen?.width || 0}×${device.screen?.height || 0}</div>
        </div>
        <span class="status-pill" data-state="${device.status === "online" ? "connected" : "offline"}">${device.status || "offline"}</span>
      </div>
      <div class="device-meta">Last seen: ${device.lastSeenAt?.toDate ? device.lastSeenAt.toDate().toLocaleString() : "Never"}</div>
      <div class="device-actions">
        <button class="ghost-button select-device" type="button" data-device-id="${device.id}">Select</button>
        <button class="danger-button revoke-device" type="button" data-device-id="${device.id}">Revoke</button>
      </div>
    `;
    elements.deviceList.appendChild(article);
  });

  elements.connectButton.disabled = !state.selectedDeviceId || !state.user;
}

function getSelectedDevice() {
  return state.devices.find((device) => device.id === state.selectedDeviceId) || null;
}

async function attachSession({ sessionId, deviceId, lowDataMode }) {
  if (state.activeSession) {
    state.activeSession.dispose();
    state.activeSession = null;
  }

  const session = new RemoteSession({
    sessionId,
    deviceId,
    lowDataMode,
    onLog: log,
    onStatus: (status) => {
      const label = status === "connected"
        ? "Connected"
        : status === "reconnecting"
          ? "Reconnecting"
          : status === "manual-disconnect"
            ? "Disconnected"
            : "Connecting";
      setPill(label, status);
    },
    onStream: setVideoStream,
    onRemoteInfo: (info) => {
      elements.resolutionValue.textContent = `${info.screen.width}×${info.screen.height}`;
    },
    onHeartbeat: (latency) => {
      elements.heartbeatValue.textContent = `${latency} ms`;
    },
    onClipboard: (text) => {
      elements.clipboardPreview.value = text;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      log("Clipboard updated from laptop.");
    },
    onTransfer: (message) => {
      setTransfer(message);
      log(message);
    },
    onEnded: () => {
      state.activeSession = null;
      setVideoStream(null);
      setPill("Offline", "offline");
      elements.disconnectButton.disabled = true;
      elements.connectButton.disabled = !state.selectedDeviceId;
      elements.sessionIdValue.textContent = "-";
      elements.heartbeatValue.textContent = "-";
      elements.resolutionValue.textContent = "-";
      setTransfer("Idle");
      setActiveDevice(getSelectedDevice());
      log("Session closed.");
    }
  });

  state.activeSession = session;
  elements.sessionIdValue.textContent = sessionId;
  await session.start();
}

async function connectToSelectedDevice() {
  const device = getSelectedDevice();
  if (!device) {
    log("Choose a device first.");
    return;
  }

  if (state.activeSession) {
    log("A session is already active.");
    return;
  }

  setActiveDevice(device);
  setPill("Connecting", "connecting");
  elements.connectButton.disabled = true;
  elements.disconnectButton.disabled = false;
  setTransfer("Idle");

  try {
    const result = await callFunction("createRemoteSession", {
      deviceId: device.id,
      lowDataMode: elements.lowDataToggle.checked
    });

    await attachSession({
      sessionId: result.sessionId,
      deviceId: device.id,
      lowDataMode: result.lowDataMode
    });

    log(result.resumed ? "Restored active session." : "Created new remote session.");
  } catch (error) {
    setPill("Error", "error");
    elements.connectButton.disabled = false;
    elements.disconnectButton.disabled = true;
    log(`Could not connect: ${error.message}`);
  }
}

function subscribeDevices(uid) {
  state.deviceUnsubscribe?.();
  const deviceQuery = query(collection(db, "devices"), where("ownerUid", "==", uid));

  state.deviceUnsubscribe = onSnapshot(deviceQuery, (snapshot) => {
    state.devices = snapshot.docs
      .map((docSnapshot) => ({ id: docSnapshot.id, ...docSnapshot.data() }))
      .sort((left, right) => {
        const leftOnline = left.status === "online" ? 1 : 0;
        const rightOnline = right.status === "online" ? 1 : 0;
        if (leftOnline !== rightOnline) {
          return rightOnline - leftOnline;
        }

        return (right.updatedAt?.seconds || 0) - (left.updatedAt?.seconds || 0);
      });

    if (!state.selectedDeviceId || !state.devices.some((device) => device.id === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices[0]?.id || null;
    }

    renderDevices();
    setActiveDevice(getSelectedDevice());
  });
}

function subscribeSessionRestore(uid) {
  state.restoreUnsubscribe?.();
  state.restoreUnsubscribe = onValue(ref(rtdb, `userSessions/${uid}`), async (snapshot) => {
    if (state.activeSession) {
      return;
    }

    const sessionIds = Object.keys(snapshot.val() || {});
    if (sessionIds.length === 0) {
      return;
    }

    const sessionId = sessionIds[0];
    const metaSnapshot = await get(ref(rtdb, `sessions/${sessionId}/meta`));
    const meta = metaSnapshot.val();

    if (!meta || meta.manualDisconnectRequested) {
      return;
    }

    state.selectedDeviceId = meta.deviceId;
    renderDevices();
    setActiveDevice(getSelectedDevice());
    await attachSession({
      sessionId,
      deviceId: meta.deviceId,
      lowDataMode: Boolean(meta.lowDataMode)
    });
    log("Restored session after reload.");
  });
}

function resetForSignedOut() {
  state.user = null;
  state.devices = [];
  state.selectedDeviceId = null;
  state.deviceUnsubscribe?.();
  state.restoreUnsubscribe?.();
  state.deviceUnsubscribe = null;
  state.restoreUnsubscribe = null;
  state.activeSession?.dispose();
  state.activeSession = null;

  elements.currentUserEmail.textContent = "-";
  elements.authView.hidden = false;
  elements.sessionView.hidden = true;
  elements.signOutButton.hidden = true;
  elements.connectButton.disabled = true;
  elements.disconnectButton.disabled = true;
  elements.sessionIdValue.textContent = "-";
  elements.resolutionValue.textContent = "-";
  elements.heartbeatValue.textContent = "-";
  elements.clipboardPreview.value = "";
  setTransfer("Idle");
  setPill("Offline", "offline");
  renderDevices();
}

function bindTouchpad() {
  const stage = elements.remoteTouchpad;

  function pointFromEvent(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    };
  }

  stage.addEventListener("pointerdown", (event) => {
    if (!state.activeSession) {
      return;
    }

    stage.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    state.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startAt: Date.now(),
      lastPoint: point
    };

    if (state.dragMode) {
      state.activeSession.pointerDown(point.x, point.y);
    } else {
      state.activeSession.movePointer(point.x, point.y);
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (!state.activeSession || !state.pointer || state.pointer.id !== event.pointerId) {
      return;
    }

    const point = pointFromEvent(event);
    state.pointer.lastPoint = point;
    const now = Date.now();
    if (now - state.moveThrottleAt < 16) {
      return;
    }

    state.moveThrottleAt = now;
    state.activeSession.movePointer(point.x, point.y);
  });

  stage.addEventListener("pointerup", (event) => {
    if (!state.activeSession || !state.pointer || state.pointer.id !== event.pointerId) {
      return;
    }

    const point = state.pointer.lastPoint || pointFromEvent(event);
    const movedDistance = Math.hypot(
      event.clientX - state.pointer.startX,
      event.clientY - state.pointer.startY
    );
    const duration = Date.now() - state.pointer.startAt;

    if (state.dragMode) {
      state.activeSession.pointerUp(point.x, point.y);
    } else if (movedDistance < 10 && duration < 250) {
      state.activeSession.click(point.x, point.y);
    }

    state.pointer = null;
  });

  stage.addEventListener("wheel", (event) => {
    if (!state.activeSession) {
      return;
    }

    event.preventDefault();
    state.activeSession.scroll(event.deltaY);
  }, { passive: false });
}

function bindUI() {
  elements.configWarning.hidden = configReady;

  elements.authModeToggle.addEventListener("click", () => {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    updateAuthModeUI();
  });

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const email = elements.authEmail.value.trim();
      const password = elements.authPassword.value;
      if (state.authMode === "signin") {
        await signInUser(email, password);
        log("Signed in.");
      } else {
        await signUpUser(email, password);
        log("Account created and signed in.");
      }
    } catch (error) {
      log(`Auth failed: ${error.message}`);
      setPill("Error", "error");
    }
  });

  elements.signOutButton.addEventListener("click", async () => {
    await signOutUser();
    log("Signed out.");
  });

  elements.pairForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.user) {
      log("Sign in before linking a device.");
      return;
    }

    try {
      const pairingCode = elements.pairCodeInput.value.trim();
      const result = await callFunction("claimDevicePairing", { pairingCode });
      elements.pairCodeInput.value = "";
      log(`Linked ${result.deviceName}.`);
    } catch (error) {
      log(`Pairing failed: ${error.message}`);
    }
  });

  elements.deviceList.addEventListener("click", async (event) => {
    const selectButton = event.target.closest(".select-device");
    const revokeButton = event.target.closest(".revoke-device");

    if (selectButton) {
      state.selectedDeviceId = selectButton.dataset.deviceId;
      renderDevices();
      setActiveDevice(getSelectedDevice());
      elements.connectButton.disabled = !state.selectedDeviceId || !state.user;
    }

    if (revokeButton) {
      try {
        await callFunction("revokeDeviceAccess", { deviceId: revokeButton.dataset.deviceId });
        log("Device access revoked.");
      } catch (error) {
        log(`Could not revoke device: ${error.message}`);
      }
    }
  });

  elements.connectButton.addEventListener("click", connectToSelectedDevice);

  elements.disconnectButton.addEventListener("click", async () => {
    if (state.activeSession) {
      await state.activeSession.manualDisconnect();
    }
  });

  elements.lowDataToggle.addEventListener("change", async () => {
    if (state.activeSession) {
      await state.activeSession.setLowDataMode(elements.lowDataToggle.checked);
      log(`Low data mode ${elements.lowDataToggle.checked ? "enabled" : "disabled"}.`);
    }
  });

  elements.leftClickButton.addEventListener("click", () => {
    state.activeSession?.click(undefined, undefined, "left");
  });

  elements.rightClickButton.addEventListener("click", () => {
    state.activeSession?.click(undefined, undefined, "right");
  });

  elements.dragToggleButton.addEventListener("click", () => {
    state.dragMode = !state.dragMode;
    elements.dragToggleButton.textContent = state.dragMode ? "Drag mode on" : "Drag mode off";
    elements.dragToggleButton.setAttribute("aria-pressed", String(state.dragMode));
  });

  elements.textInputForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.textToSend.value;
    if (!text || !state.activeSession) {
      return;
    }

    state.activeSession.sendText(text);
    log(`Sent ${formatBytes(text.length)} of text input.`);
    elements.textToSend.value = "";
  });

  elements.specialKeys.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSession?.sendKey(button.dataset.key);
    });
  });

  elements.comboKeys.forEach((button) => {
    button.addEventListener("click", () => {
      const combo = (button.dataset.combo || "").split(",").filter(Boolean);
      const key = combo.pop();
      state.activeSession?.sendKey(key, combo);
    });
  });

  elements.pushClipboardButton.addEventListener("click", async () => {
    if (!state.activeSession) {
      return;
    }

    let text = elements.clipboardPreview.value;
    if (navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        // fall through to textarea value
      }
    }

    state.activeSession.pushClipboard(text);
    log("Sent local clipboard to laptop.");
  });

  elements.pullClipboardButton.addEventListener("click", () => {
    state.activeSession?.requestClipboard();
  });

  elements.screenshotButton.addEventListener("click", () => {
    state.activeSession?.requestScreenshot();
  });

  elements.uploadButton.addEventListener("click", async () => {
    if (!state.activeSession || !elements.fileUploadInput.files?.length) {
      return;
    }

    const file = elements.fileUploadInput.files[0];
    setTransfer(`Preparing ${file.name}`);
    await state.activeSession.uploadFile(file);
  });

  elements.downloadButton.addEventListener("click", () => {
    if (!state.activeSession) {
      return;
    }

    const path = elements.downloadPathInput.value.trim();
    if (!path) {
      log("Enter a home-relative path to download.");
      return;
    }

    state.activeSession.requestFile(path);
  });
}

function bootstrap() {
  updateAuthModeUI();
  bindUI();
  bindTouchpad();

  if (!configReady) {
    resetForSignedOut();
    log("Firebase config missing. Update web/public/config.js.");
    return;
  }

  observeAuth((user) => {
    if (!user) {
      resetForSignedOut();
      return;
    }

    state.user = user;
    elements.currentUserEmail.textContent = user.email || user.uid;
    elements.authView.hidden = true;
    elements.sessionView.hidden = false;
    elements.signOutButton.hidden = false;
    setPill("Online", "connected");
    subscribeDevices(user.uid);
    subscribeSessionRestore(user.uid);
  });
}

bootstrap();
