import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import clipboard from "clipboardy";
import screenshot from "screenshot-desktop";
import Jimp from "jimp";
import robot from "@jitsi/robotjs";
import wrtc from "@roamhq/wrtc";
import { onChildAdded, onValue, push, ref, update } from "firebase/database";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { config } from "./config.js";
import { BUTTON_ALIASES, FILE_CHUNK_SIZE, HEARTBEAT_INTERVAL_MS, mapKey, mapModifiers } from "./protocol.js";

const {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  nonstandard
} = wrtc;
const { RTCVideoSource, rgbaToI420 } = nonstandard;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function toBuffer(base64) {
  return Buffer.from(base64, "base64");
}

export class SessionAgent {
  constructor({ sessionId, deviceId, firestore, rtdb, logger = console.log }) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.firestore = firestore;
    this.rtdb = rtdb;
    this.logger = logger;

    this.negotiationId = null;
    this.lowDataMode = false;
    this.disposed = false;
    this.peerConnection = null;
    this.dataChannel = null;
    this.videoSource = null;
    this.videoTrack = null;
    this.captureTimer = null;
    this.captureInProgress = false;
    this.lastInputAt = 0;
    this.lastScreenInfo = robot.getScreenSize();
    this.uploadTransfers = new Map();
    this.unsubscribers = [];
    this.offerCandidateUnsubscribe = null;
    this.heartbeatTimer = null;
  }

  log(message) {
    this.logger(`[session:${this.sessionId}] ${message}`);
  }

  sessionRef(pathSuffix = "") {
    return ref(this.rtdb, pathSuffix ? `sessions/${this.sessionId}/${pathSuffix}` : `sessions/${this.sessionId}`);
  }

  async start() {
    this.log("Attaching realtime listeners.");

    this.unsubscribers.push(onValue(this.sessionRef("meta"), (snapshot) => {
      const meta = snapshot.val();
      if (!meta) {
        return;
      }

      this.lowDataMode = Boolean(meta.lowDataMode);
      if (meta.manualDisconnectRequested) {
        this.dispose();
      }
    }));

    this.unsubscribers.push(onValue(this.sessionRef("control/lowDataMode"), (snapshot) => {
      this.lowDataMode = Boolean(snapshot.val());
    }));

    this.unsubscribers.push(onValue(this.sessionRef("signals/offer"), async (snapshot) => {
      const offer = snapshot.val();
      if (!offer || !offer.sdp || !offer.negotiationId) {
        return;
      }

      if (offer.negotiationId === this.negotiationId && this.peerConnection) {
        return;
      }

      try {
        await this.handleOffer(offer);
      } catch (error) {
        this.log(`Offer handling failed: ${error.message}`);
      }
    }));

    this.heartbeatTimer = setInterval(async () => {
      if (this.disposed) {
        return;
      }

      const now = Date.now();
      await update(this.sessionRef("heartbeat"), {
        agentAt: now
      }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  async handleOffer(offer) {
    this.negotiationId = offer.negotiationId;
    this.stopCaptureLoop();
    this.cleanupPeerConnection();

    this.videoSource = new RTCVideoSource({ isScreencast: true });
    this.videoTrack = this.videoSource.createTrack();

    const peerConnection = new RTCPeerConnection({
      iceServers: config.stunServers
    });

    const mediaStream = new MediaStream();
    mediaStream.addTrack(this.videoTrack);
    peerConnection.addTrack(this.videoTrack, mediaStream);
    this.peerConnection = peerConnection;

    peerConnection.ondatachannel = (event) => {
      this.bindDataChannel(event.channel);
    };

    peerConnection.onicecandidate = async (event) => {
      if (!event.candidate || !this.negotiationId) {
        return;
      }

      await push(this.sessionRef(`answerCandidates/${this.negotiationId}`), {
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
        }).catch(() => {});
      }

      if (state === "disconnected" || state === "failed") {
        this.stopCaptureLoop();
        await update(this.sessionRef("meta"), {
          state: "reconnecting",
          updatedAt: Date.now()
        }).catch(() => {});
      }
    };

    peerConnection.oniceconnectionstatechange = async () => {
      const state = peerConnection.iceConnectionState;
      if (state === "disconnected" || state === "failed") {
        this.stopCaptureLoop();
        await update(this.sessionRef("meta"), {
          state: "reconnecting",
          updatedAt: Date.now()
        }).catch(() => {});
      }
    };

    this.attachOfferCandidates();

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription({
        type: offer.type,
        sdp: offer.sdp
      })
    );

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await update(this.sessionRef(), {
      "signals/answer": {
        type: answer.type,
        sdp: answer.sdp,
        negotiationId: this.negotiationId,
        createdAt: Date.now()
      },
      "meta/negotiationId": this.negotiationId,
      "meta/state": "connecting",
      "meta/updatedAt": Date.now()
    });

    this.log(`Published answer ${this.negotiationId}`);
  }

  attachOfferCandidates() {
    this.offerCandidateUnsubscribe?.();

    this.offerCandidateUnsubscribe = onChildAdded(
      this.sessionRef(`offerCandidates/${this.negotiationId}`),
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

  bindDataChannel(channel) {
    this.dataChannel = channel;

    channel.onopen = async () => {
      this.log("Data channel open.");
      await this.sendAgentReady();
      this.startCaptureLoop();
    };

    channel.onclose = () => {
      this.log("Data channel closed.");
      this.stopCaptureLoop();
    };

    channel.onmessage = async (event) => {
      await this.handleDataMessage(event.data);
    };
  }

  async sendAgentReady() {
    const screen = robot.getScreenSize();
    await this.send({
      type: "agent-ready",
      screen,
      capabilities: {
        clipboard: true,
        fileTransfer: true,
        screenshots: true,
        audio: false
      }
    });

    await this.updateDeviceRecord({
      status: "online",
      screen,
      metrics: {
        lastPingMs: null,
        activeLowDataMode: this.lowDataMode
      }
    });
  }

  async send(message) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return;
    }

    this.dataChannel.send(JSON.stringify(message));
  }

  async handleDataMessage(rawData) {
    let message;

    try {
      const text = typeof rawData === "string" ? rawData : Buffer.from(rawData).toString("utf8");
      message = JSON.parse(text);
    } catch (error) {
      this.log(`Unable to parse control payload: ${error.message}`);
      return;
    }

    this.lastInputAt = Date.now();

    switch (message.type) {
      case "heartbeat-ping":
        await update(this.sessionRef("heartbeat"), {
          agentAt: Date.now(),
          lastPongAt: Date.now()
        }).catch(() => {});
        await this.send({
          type: "heartbeat-pong",
          sentAt: message.sentAt
        });
        break;
      case "set-low-data-mode":
        this.lowDataMode = Boolean(message.enabled);
        await this.updateDeviceRecord({
          metrics: {
            lastPingMs: null,
            activeLowDataMode: this.lowDataMode
          }
        });
        break;
      case "mouse-move":
        this.moveMouse(message.x, message.y);
        break;
      case "mouse-down":
        if (Number.isFinite(Number(message.x)) && Number.isFinite(Number(message.y))) {
          this.moveMouse(message.x, message.y);
        }
        robot.mouseToggle("down", BUTTON_ALIASES[message.button] || "left");
        break;
      case "mouse-up":
        if (Number.isFinite(Number(message.x)) && Number.isFinite(Number(message.y))) {
          this.moveMouse(message.x, message.y);
        }
        robot.mouseToggle("up", BUTTON_ALIASES[message.button] || "left");
        break;
      case "mouse-click":
        if (Number.isFinite(Number(message.x)) && Number.isFinite(Number(message.y))) {
          this.moveMouse(message.x, message.y);
        }
        robot.mouseClick(BUTTON_ALIASES[message.button] || "left");
        break;
      case "mouse-wheel": {
        const amount = Math.round(Number(message.deltaY || 0) / 120) || Math.sign(Number(message.deltaY || 0)) || 1;
        robot.scrollMouse(0, -amount);
        break;
      }
      case "keyboard-text":
        robot.typeString(String(message.text || ""));
        break;
      case "keyboard-key":
        robot.keyTap(mapKey(message.key), mapModifiers(message.modifiers));
        break;
      case "clipboard-get":
        await this.send({
          type: "clipboard-data",
          text: await clipboard.read()
        });
        break;
      case "clipboard-set":
        await clipboard.write(String(message.text || ""));
        break;
      case "screenshot-request":
        await this.send({
          type: "screenshot-response",
          requestId: message.requestId,
          fileName: `flowcast-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          mime: "image/png",
          base64: (await screenshot({ format: "png" })).toString("base64")
        });
        break;
      case "file-upload-start":
        this.uploadTransfers.set(message.transferId, {
          fileName: message.fileName,
          mime: message.mime,
          chunks: []
        });
        break;
      case "file-upload-chunk": {
        const transfer = this.uploadTransfers.get(message.transferId);
        if (transfer) {
          transfer.chunks.push(toBuffer(message.base64));
        }
        break;
      }
      case "file-upload-complete":
        await this.finishUpload(message.transferId);
        break;
      case "file-download-request":
        await this.sendFile(message.transferId, message.path);
        break;
      default:
        this.log(`Unhandled control message ${message.type}`);
        break;
    }
  }

  moveMouse(normalizedX, normalizedY) {
    const screen = robot.getScreenSize();
    const x = Math.round(clamp(Number(normalizedX || 0)) * (screen.width - 1));
    const y = Math.round(clamp(Number(normalizedY || 0)) * (screen.height - 1));
    robot.moveMouse(x, y);
  }

  getCaptureProfile() {
    const screen = robot.getScreenSize();
    const active = Date.now() - this.lastInputAt < 4000;

    if (this.lowDataMode) {
      return {
        width: Math.min(screen.width, 640),
        fps: active ? 5 : 3
      };
    }

    return {
      width: Math.min(screen.width, active ? 1280 : 960),
      fps: active ? 10 : 6
    };
  }

  startCaptureLoop() {
    if (this.captureTimer || !this.videoSource) {
      return;
    }

    const run = async () => {
      if (this.disposed || !this.videoSource || !this.dataChannel || this.dataChannel.readyState !== "open") {
        this.captureTimer = null;
        return;
      }

      await this.captureFrame();
      const { fps } = this.getCaptureProfile();
      this.captureTimer = setTimeout(async () => {
        this.captureTimer = null;
        await run();
      }, Math.max(90, Math.round(1000 / fps)));
    };

    run().catch((error) => {
      this.log(`Capture loop failed: ${error.message}`);
      this.captureTimer = null;
    });
  }

  stopCaptureLoop() {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
  }

  async captureFrame() {
    if (this.captureInProgress || !this.videoSource) {
      return;
    }

    this.captureInProgress = true;
    try {
      const pngBuffer = await screenshot({ format: "png" });
      const image = await Jimp.read(pngBuffer);
      const profile = this.getCaptureProfile();

      if (image.bitmap.width > profile.width) {
        image.resize(profile.width, Jimp.AUTO);
      }

      const width = image.bitmap.width;
      const height = image.bitmap.height;
      const rgbaFrame = {
        width,
        height,
        data: new Uint8Array(image.bitmap.data)
      };
      const i420Frame = {
        width,
        height,
        data: new Uint8Array(width * height * 1.5)
      };

      rgbaToI420(rgbaFrame, i420Frame);
      this.videoSource.onFrame(i420Frame);

      const currentScreen = robot.getScreenSize();
      if (
        currentScreen.width !== this.lastScreenInfo.width ||
        currentScreen.height !== this.lastScreenInfo.height
      ) {
        this.lastScreenInfo = currentScreen;
        await this.updateDeviceRecord({ screen: currentScreen });
      }
    } catch (error) {
      this.log(`Frame capture failed: ${error.message}`);
    } finally {
      this.captureInProgress = false;
    }
  }

  async waitForBufferedAmount() {
    while (this.dataChannel && this.dataChannel.bufferedAmount > 512 * 1024) {
      await sleep(80);
    }
  }

  resolveDownloadPath(inputPath) {
    const home = os.homedir();
    const normalized = String(inputPath || "").replace(/^[/\\]+/, "");
    const resolved = path.resolve(home, normalized);
    if (!resolved.startsWith(home)) {
      throw new Error("Requested path escapes the home directory.");
    }
    return resolved;
  }

  async finishUpload(transferId) {
    const transfer = this.uploadTransfers.get(transferId);
    if (!transfer) {
      return;
    }

    this.uploadTransfers.delete(transferId);
    const targetDir = path.join(os.homedir(), "Downloads", "FlowCast");
    await fs.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, transfer.fileName);
    await fs.writeFile(targetPath, Buffer.concat(transfer.chunks));

    await this.send({
      type: "file-upload-complete",
      path: targetPath,
      message: `Saved ${transfer.fileName} to ${targetPath}`
    });
  }

  async sendFile(transferId, inputPath) {
    try {
      const targetPath = this.resolveDownloadPath(inputPath);
      const fileBuffer = await fs.readFile(targetPath);
      const fileName = path.basename(targetPath);
      const totalChunks = Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE);

      await this.send({
        type: "file-download-start",
        transferId,
        fileName,
        mime: "application/octet-stream",
        size: fileBuffer.length
      });

      for (let index = 0; index < totalChunks; index += 1) {
        const chunk = fileBuffer.subarray(index * FILE_CHUNK_SIZE, (index + 1) * FILE_CHUNK_SIZE);
        await this.waitForBufferedAmount();
        await this.send({
          type: "file-download-chunk",
          transferId,
          index,
          base64: chunk.toString("base64")
        });
      }

      await this.send({
        type: "file-download-complete",
        transferId
      });
    } catch (error) {
      await this.send({
        type: "file-download-error",
        transferId,
        message: error.message
      });
    }
  }

  async updateDeviceRecord(partial = {}) {
    const deviceDoc = doc(this.firestore, "devices", this.deviceId);
    await updateDoc(deviceDoc, {
      ...partial,
      lastSeenAt: serverTimestamp(),
      lastHeartbeatAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }

  cleanupPeerConnection() {
    this.offerCandidateUnsubscribe?.();
    this.offerCandidateUnsubscribe = null;

    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.videoTrack?.stop) {
      this.videoTrack.stop();
    }
    this.videoTrack = null;
    this.videoSource = null;
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopCaptureLoop();
    clearInterval(this.heartbeatTimer);
    this.cleanupPeerConnection();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe?.());
    this.unsubscribers = [];
    this.log("Session disposed.");
  }
}
