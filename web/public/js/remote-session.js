import { onChildAdded, onValue, push, ref, remove, update } from "firebase/database";
import { callFunction, config, rtdb } from "./firebase-app.js";
import {
  DATA_CHANNEL_LABEL,
  FILE_CHUNK_SIZE,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_DELAY_MS,
  bytesToBase64,
  clamp,
  downloadBase64File,
  wait
} from "./protocol.js";

export class RemoteSession {
  constructor({
    sessionId,
    deviceId,
    lowDataMode = false,
    onLog,
    onStatus,
    onStream,
    onRemoteInfo,
    onHeartbeat,
    onClipboard,
    onTransfer,
    onEnded
  }) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.lowDataMode = Boolean(lowDataMode);
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.onStream = onStream;
    this.onRemoteInfo = onRemoteInfo;
    this.onHeartbeat = onHeartbeat;
    this.onClipboard = onClipboard;
    this.onTransfer = onTransfer;
    this.onEnded = onEnded;

    this.peerConnection = null;
    this.dataChannel = null;
    this.negotiationId = null;
    this.remoteStream = null;
    this.manualDisconnectRequested = false;
    this.disposed = false;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.answerUnsubscribe = null;
    this.answerCandidateUnsubscribe = null;
    this.metaUnsubscribe = null;
    this.pendingDownloads = new Map();
  }

  log(message) {
    this.onLog?.(message);
  }

  sessionRef(path = "") {
    return ref(rtdb, path ? `sessions/${this.sessionId}/${path}` : `sessions/${this.sessionId}`);
  }

  async start() {
    this.log(`Starting session ${this.sessionId}`);
    this.attachMetaListener();
    this.startHeartbeatLoop();
    await this.renegotiate();
  }

  attachMetaListener() {
    this.metaUnsubscribe?.();

    this.metaUnsubscribe = onValue(this.sessionRef("meta"), (snapshot) => {
      const meta = snapshot.val();
      if (!meta) {
        return;
      }

      this.lowDataMode = Boolean(meta.lowDataMode);
      this.onStatus?.(meta.state || "connecting");

      if (meta.manualDisconnectRequested && !this.manualDisconnectRequested) {
        this.log("Session ended remotely.");
        this.dispose({ remoteEnded: true });
      }
    });
  }

  startHeartbeatLoop() {
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(async () => {
      if (this.disposed) {
        return;
      }

      const timestamp = Date.now();
      try {
        await update(this.sessionRef("heartbeat"), {
          controllerAt: timestamp,
          lastPingAt: timestamp
        });
      } catch (error) {
        this.log(`Heartbeat update failed: ${error.message}`);
      }

      if (this.dataChannel?.readyState === "open") {
        this.send({
          type: "heartbeat-ping",
          sentAt: timestamp
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  async renegotiate() {
    if (this.disposed || this.manualDisconnectRequested) {
      return;
    }

    this.negotiationId = crypto.randomUUID();
    this.cleanupAnswerListeners();
    this.closePeerConnection();

    this.remoteStream = new MediaStream();
    this.onStream?.(this.remoteStream);

    const peerConnection = new RTCPeerConnection({
      iceServers: config.stunServers || [{ urls: "stun:stun.l.google.com:19302" }]
    });

    this.peerConnection = peerConnection;
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    this.bindPeerEvents(peerConnection);

    const controlChannel = peerConnection.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true
    });
    this.bindDataChannel(controlChannel);

    await remove(this.sessionRef(`answerCandidates/${this.negotiationId}`)).catch(() => {});

    await update(this.sessionRef(), {
      "meta/negotiationId": this.negotiationId,
      "meta/state": "connecting",
      "meta/manualDisconnectRequested": false,
      "meta/updatedAt": Date.now(),
      "control/lowDataMode": this.lowDataMode,
      "signals/answer": null
    });

    this.attachAnswerListeners();

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: true
    });
    await peerConnection.setLocalDescription(offer);

    await update(this.sessionRef(), {
      "signals/offer": {
        type: offer.type,
        sdp: offer.sdp,
        negotiationId: this.negotiationId,
        createdAt: Date.now()
      }
    });

    this.log(`Published fresh offer ${this.negotiationId}`);
  }

  bindPeerEvents(peerConnection) {
    peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        if (!this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
          this.remoteStream.addTrack(track);
        }
      });
      this.onStream?.(this.remoteStream);
    };

    peerConnection.onicecandidate = async (event) => {
      if (!event.candidate || !this.negotiationId) {
        return;
      }

      await push(this.sessionRef(`offerCandidates/${this.negotiationId}`), {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        createdAt: Date.now()
      });
    };

    peerConnection.onconnectionstatechange = async () => {
      const state = peerConnection.connectionState;
      if (state === "connected") {
        await update(this.sessionRef("meta"), {
          state: "connected",
          updatedAt: Date.now()
        });
        this.onStatus?.("connected");
      }

      if (state === "failed" || state === "disconnected") {
        this.scheduleReconnect(`Peer connection ${state}`);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === "failed" || state === "disconnected") {
        this.scheduleReconnect(`ICE ${state}`);
      }
    };
  }

  bindDataChannel(channel) {
    this.dataChannel = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = async () => {
      this.log("Control data channel open.");
      await update(this.sessionRef("meta"), {
        state: "connected",
        updatedAt: Date.now()
      });
      this.onStatus?.("connected");
      this.send({ type: "set-low-data-mode", enabled: this.lowDataMode });
    };

    channel.onclose = () => {
      if (!this.manualDisconnectRequested && !this.disposed) {
        this.scheduleReconnect("Data channel closed");
      }
    };

    channel.onmessage = (event) => {
      this.handleDataMessage(event.data);
    };
  }

  attachAnswerListeners() {
    this.cleanupAnswerListeners();

    this.answerUnsubscribe = onValue(this.sessionRef("signals/answer"), async (snapshot) => {
      const answer = snapshot.val();
      if (!answer || answer.negotiationId !== this.negotiationId || !this.peerConnection) {
        return;
      }

      if (this.peerConnection.currentRemoteDescription) {
        return;
      }

      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription({
          type: answer.type,
          sdp: answer.sdp
        })
      );

      this.log(`Remote answer accepted for ${this.negotiationId}`);
    });

    this.answerCandidateUnsubscribe = onChildAdded(
      this.sessionRef(`answerCandidates/${this.negotiationId}`),
      async (snapshot) => {
        const candidate = snapshot.val();
        if (!candidate || !this.peerConnection) {
          return;
        }

        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          this.log(`Could not add remote ICE candidate: ${error.message}`);
        }
      }
    );
  }

  cleanupAnswerListeners() {
    this.answerUnsubscribe?.();
    this.answerCandidateUnsubscribe?.();
    this.answerUnsubscribe = null;
    this.answerCandidateUnsubscribe = null;
  }

  closePeerConnection() {
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  scheduleReconnect(reason) {
    if (this.reconnectTimer || this.manualDisconnectRequested || this.disposed) {
      return;
    }

    this.log(`${reason}. Re-offering in ${RECONNECT_DELAY_MS}ms.`);
    this.onStatus?.("reconnecting");
    update(this.sessionRef("meta"), {
      state: "reconnecting",
      updatedAt: Date.now()
    }).catch(() => {});

    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.renegotiate();
      } catch (error) {
        this.log(`Reconnect failed: ${error.message}`);
        this.scheduleReconnect("Retrying after failed reconnect");
      }
    }, RECONNECT_DELAY_MS);
  }

  send(payload) {
    if (this.dataChannel?.readyState !== "open") {
      throw new Error("Control channel is not open yet.");
    }

    this.dataChannel.send(JSON.stringify(payload));
  }

  handleDataMessage(rawData) {
    let message;

    try {
      const text = typeof rawData === "string"
        ? rawData
        : new TextDecoder().decode(rawData);
      message = JSON.parse(text);
    } catch (error) {
      this.log(`Could not parse data channel payload: ${error.message}`);
      return;
    }

    switch (message.type) {
      case "agent-ready":
        this.onRemoteInfo?.(message);
        break;
      case "heartbeat-pong": {
        const latency = Date.now() - Number(message.sentAt || Date.now());
        this.onHeartbeat?.(latency);
        update(this.sessionRef("heartbeat"), {
          agentAt: Date.now(),
          lastPongAt: Date.now()
        }).catch(() => {});
        break;
      }
      case "clipboard-data":
        this.onClipboard?.(message.text || "");
        break;
      case "screenshot-response":
        downloadBase64File({
          base64: message.base64,
          fileName: message.fileName || `flowcast-${Date.now()}.png`,
          mime: message.mime || "image/png"
        });
        this.onTransfer?.("Screenshot downloaded");
        break;
      case "file-upload-complete":
      case "file-upload-error":
        this.onTransfer?.(message.message || message.path || "Upload finished");
        break;
      case "file-download-start":
        this.pendingDownloads.set(message.transferId, {
          fileName: message.fileName,
          mime: message.mime || "application/octet-stream",
          chunks: []
        });
        this.onTransfer?.(`Downloading ${message.fileName}`);
        break;
      case "file-download-chunk": {
        const transfer = this.pendingDownloads.get(message.transferId);
        if (!transfer) {
          return;
        }

        transfer.chunks.push(message.base64);
        break;
      }
      case "file-download-complete": {
        const transfer = this.pendingDownloads.get(message.transferId);
        if (!transfer) {
          return;
        }

        this.pendingDownloads.delete(message.transferId);
        downloadBase64File({
          base64: transfer.chunks.join(""),
          fileName: transfer.fileName,
          mime: transfer.mime
        });
        this.onTransfer?.(`Downloaded ${transfer.fileName}`);
        break;
      }
      case "file-download-error":
        this.onTransfer?.(message.message || "Download failed");
        break;
      default:
        this.log(`Unhandled agent message: ${message.type}`);
        break;
    }
  }

  async waitForBufferedAmount() {
    while (this.dataChannel && this.dataChannel.bufferedAmount > 512 * 1024) {
      await wait(80);
    }
  }

  async setLowDataMode(enabled) {
    this.lowDataMode = Boolean(enabled);
    await update(this.sessionRef(), {
      "meta/lowDataMode": this.lowDataMode,
      "meta/updatedAt": Date.now(),
      "control/lowDataMode": this.lowDataMode
    });

    if (this.dataChannel?.readyState === "open") {
      this.send({ type: "set-low-data-mode", enabled: this.lowDataMode });
    }
  }

  movePointer(x, y) {
    this.send({ type: "mouse-move", x: clamp(x), y: clamp(y) });
  }

  pointerDown(x, y, button = "left") {
    const payload = { type: "mouse-down", button };
    if (Number.isFinite(x) && Number.isFinite(y)) {
      payload.x = clamp(x);
      payload.y = clamp(y);
    }
    this.send(payload);
  }

  pointerUp(x, y, button = "left") {
    const payload = { type: "mouse-up", button };
    if (Number.isFinite(x) && Number.isFinite(y)) {
      payload.x = clamp(x);
      payload.y = clamp(y);
    }
    this.send(payload);
  }

  click(x, y, button = "left") {
    const payload = { type: "mouse-click", button };
    if (Number.isFinite(x) && Number.isFinite(y)) {
      payload.x = clamp(x);
      payload.y = clamp(y);
    }
    this.send(payload);
  }

  scroll(deltaY) {
    this.send({ type: "mouse-wheel", deltaY });
  }

  sendText(text) {
    this.send({ type: "keyboard-text", text });
  }

  sendKey(key, modifiers = []) {
    this.send({ type: "keyboard-key", key, modifiers });
  }

  requestClipboard() {
    this.send({ type: "clipboard-get" });
  }

  pushClipboard(text) {
    this.send({ type: "clipboard-set", text });
  }

  requestScreenshot() {
    this.send({ type: "screenshot-request", requestId: crypto.randomUUID() });
  }

  async uploadFile(file) {
    const transferId = crypto.randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.ceil(bytes.length / FILE_CHUNK_SIZE);

    this.send({
      type: "file-upload-start",
      transferId,
      fileName: file.name,
      mime: file.type || "application/octet-stream",
      size: bytes.length,
      totalChunks
    });

    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = bytes.subarray(index * FILE_CHUNK_SIZE, (index + 1) * FILE_CHUNK_SIZE);
      await this.waitForBufferedAmount();
      this.send({
        type: "file-upload-chunk",
        transferId,
        index,
        base64: bytesToBase64(chunk)
      });
      this.onTransfer?.(`Uploading ${file.name} (${index + 1}/${totalChunks})`);
    }

    this.send({ type: "file-upload-complete", transferId });
  }

  requestFile(path) {
    this.send({
      type: "file-download-request",
      transferId: crypto.randomUUID(),
      path
    });
  }

  async manualDisconnect() {
    this.manualDisconnectRequested = true;
    this.log("Manual disconnect requested.");
    await callFunction("disconnectRemoteSession", {
      sessionId: this.sessionId
    });
    this.dispose({ remoteEnded: true });
  }

  dispose({ remoteEnded = false } = {}) {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    window.clearInterval(this.heartbeatTimer);
    window.clearTimeout(this.reconnectTimer);
    this.cleanupAnswerListeners();
    this.metaUnsubscribe?.();
    this.metaUnsubscribe = null;
    this.closePeerConnection();
    this.onStream?.(null);
    this.pendingDownloads.clear();
    this.onEnded?.({ remoteEnded });
  }
}
