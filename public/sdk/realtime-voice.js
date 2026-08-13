const DEFAULT_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";

/**
 * Browser SDK for one OpenAI Realtime speech-to-speech session.
 *
 * Audio is carried by WebRTC media. Realtime JSON events use the WebRTC data
 * channel. No OpenAI WebSocket is created by this class.
 */
export class RealtimeVoiceClient extends EventTarget {
  #bootstrapUrl;
  #realtimeUrl;
  #audioElement;
  #iceGatheringTimeoutMs;
  #peerConnection;
  #dataChannel;
  #localStream;
  #signaling;
  #closed = true;

  constructor({
    bootstrapUrl = "/api/bootstrap",
    realtimeUrl = DEFAULT_REALTIME_URL,
    audioElement = new Audio(),
    iceGatheringTimeoutMs = 8_000,
  } = {}) {
    super();
    this.#bootstrapUrl = bootstrapUrl;
    this.#realtimeUrl = realtimeUrl;
    this.#audioElement = audioElement;
    this.#audioElement.autoplay = true;
    this.#iceGatheringTimeoutMs = iceGatheringTimeoutMs;
  }

  get connected() {
    return this.#dataChannel?.readyState === "open";
  }

  get muted() {
    return this.#localStream?.getAudioTracks().every((track) => !track.enabled) ?? false;
  }

  async connect({ openaiApiKey, forceRelay = false, includeSignaling = false, peerId } = {}) {
    if (!this.#closed) throw new Error("A Realtime session is already active");
    if (typeof openaiApiKey !== "string" || !openaiApiKey.startsWith("sk-")) {
      throw new TypeError("An OpenAI API key is required for this BYOK demo");
    }
    this.#closed = false;
    const resolvedPeerId = peerId ?? crypto.randomUUID();

    try {
      this.#setStatus("requesting-microphone");
      // Ask for permission before minting short-lived provider credentials.
      this.#localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.#setStatus("fetching-credentials");
      let requestBody = JSON.stringify({
        openaiApiKey,
        includeSignaling,
        peerId: resolvedPeerId,
      });
      let bootstrap;
      try {
        bootstrap = await fetchJson(this.#bootstrapUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
      } finally {
        // Do not retain the tester's standard key after the one-time exchange.
        openaiApiKey = "";
        requestBody = "";
      }
      assertBootstrap(bootstrap);

      this.#peerConnection = new RTCPeerConnection({
        iceServers: bootstrap.iceServers,
        iceTransportPolicy: forceRelay ? "relay" : "all",
      });
      this.#wirePeerConnection();

      for (const track of this.#localStream.getAudioTracks()) {
        this.#peerConnection.addTrack(track, this.#localStream);
      }

      this.#dataChannel = this.#peerConnection.createDataChannel("oai-events");
      this.#wireDataChannel();

      if (bootstrap.signaling) {
        this.#signaling = new XirsysSignalingClient();
        this.#wireSignaling();
        await this.#signaling.connect(bootstrap.signaling);
      }

      this.#setStatus("negotiating");
      const offer = await this.#peerConnection.createOffer();
      await this.#peerConnection.setLocalDescription(offer);

      // OpenAI's endpoint uses one non-trickle SDP exchange. Waiting gives TURN
      // candidates time to appear in localDescription before it is posted.
      await waitForIceGatheringComplete(
        this.#peerConnection,
        this.#iceGatheringTimeoutMs,
      );
      const localSdp = this.#peerConnection.localDescription?.sdp;
      if (!localSdp) throw new Error("The browser did not create a local SDP offer");

      const sdpResponse = await fetch(this.#realtimeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.clientSecret.value}`,
          "Content-Type": "application/sdp",
        },
        body: localSdp,
      });

      if (!sdpResponse.ok) {
        const details = (await sdpResponse.text()).slice(0, 1_000);
        throw new Error(
          `OpenAI SDP negotiation failed (${sdpResponse.status})${details ? `: ${details}` : ""}`,
        );
      }

      await this.#peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });

      this.dispatchEvent(
        new CustomEvent("session", {
          detail: {
            model: bootstrap.session?.model,
            voice: bootstrap.session?.voice,
            peerId: resolvedPeerId,
            signaling: Boolean(bootstrap.signaling),
          },
        }),
      );
    } catch (error) {
      this.#emitError(error);
      this.disconnect();
      throw error;
    }
  }

  /** Send any supported OpenAI Realtime client event over the data channel. */
  sendEvent(event) {
    if (!this.#dataChannel || this.#dataChannel.readyState !== "open") {
      throw new Error("The OpenAI Realtime data channel is not open");
    }
    this.#dataChannel.send(JSON.stringify(event));
  }

  /** Add a text turn, then ask the voice model to respond. */
  sendText(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: trimmed }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  setMuted(muted) {
    for (const track of this.#localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    this.dispatchEvent(new CustomEvent("mute", { detail: { muted } }));
  }

  /** Send an optional application message through Xirsys Signaling V2. */
  sendSignalingMessage(operation, payload, targetPeerId) {
    if (!this.#signaling) throw new Error("Xirsys WebSocket signaling is not enabled");
    this.#signaling.send(operation, payload, targetPeerId);
  }

  async getConnectionStats() {
    if (!this.#peerConnection) return undefined;
    const reports = await this.#peerConnection.getStats();
    let selectedPair;

    for (const report of reports.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPair = reports.get(report.selectedCandidatePairId);
        break;
      }
      if (
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        (report.nominated || report.selected)
      ) {
        selectedPair = report;
      }
    }

    if (!selectedPair) return undefined;
    const local = reports.get(selectedPair.localCandidateId);
    const remote = reports.get(selectedPair.remoteCandidateId);
    return {
      currentRoundTripTime: selectedPair.currentRoundTripTime,
      localCandidateType: local?.candidateType,
      localProtocol: local?.protocol,
      remoteCandidateType: remote?.candidateType,
      remoteProtocol: remote?.protocol,
    };
  }

  disconnect() {
    if (this.#closed) return;
    this.#closed = true;
    this.#signaling?.disconnect();
    this.#dataChannel?.close();
    this.#peerConnection?.close();
    for (const track of this.#localStream?.getTracks() ?? []) track.stop();
    this.#audioElement.srcObject = null;
    this.#signaling = undefined;
    this.#dataChannel = undefined;
    this.#peerConnection = undefined;
    this.#localStream = undefined;
    this.#setStatus("idle");
  }

  #wirePeerConnection() {
    const pc = this.#peerConnection;
    pc.addEventListener("track", (event) => {
      this.#audioElement.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.#audioElement.play().catch(() => {
        // The connect action normally satisfies autoplay policy. If a browser
        // still blocks playback, the visible audio controls let the user start it.
      });
    });
    pc.addEventListener("connectionstatechange", () => {
      this.dispatchEvent(
        new CustomEvent("peer-state", { detail: { state: pc.connectionState } }),
      );
      if (pc.connectionState === "failed") {
        this.#emitError(new Error("The WebRTC peer connection failed"));
      }
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      this.dispatchEvent(
        new CustomEvent("ice-state", { detail: { state: pc.iceConnectionState } }),
      );
    });
  }

  #wireDataChannel() {
    const channel = this.#dataChannel;
    channel.addEventListener("open", () => this.#setStatus("connected"));
    channel.addEventListener("close", () => {
      if (!this.#closed) this.#setStatus("data-channel-closed");
    });
    channel.addEventListener("message", (event) => {
      try {
        const realtimeEvent = JSON.parse(event.data);
        this.dispatchEvent(new CustomEvent("realtime", { detail: realtimeEvent }));
        if (realtimeEvent.type === "error") {
          this.#emitError(new Error(realtimeEvent.error?.message ?? "OpenAI Realtime error"));
        }
      } catch {
        this.#emitError(new Error("Received a non-JSON Realtime data-channel message"));
      }
    });
  }

  #wireSignaling() {
    this.#signaling.addEventListener("state", (event) => {
      this.dispatchEvent(new CustomEvent("signaling-state", { detail: event.detail }));
    });
    this.#signaling.addEventListener("message", (event) => {
      this.dispatchEvent(new CustomEvent("signaling-message", { detail: event.detail }));
    });
    this.#signaling.addEventListener("error", (event) => {
      this.#emitError(event.detail.error);
    });
  }

  #setStatus(status) {
    this.dispatchEvent(new CustomEvent("status", { detail: { status } }));
  }

  #emitError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.dispatchEvent(new CustomEvent("error", { detail: { error: normalized } }));
  }
}

/** Optional Xirsys WebSocket application signaling; never carries OpenAI audio. */
export class XirsysSignalingClient extends EventTarget {
  #socket;
  #peerId;
  #heartbeat;

  async connect(credentials) {
    if (!credentials?.url || !credentials?.peerId) {
      throw new TypeError("Valid Xirsys signaling credentials are required");
    }

    this.#peerId = credentials.peerId;
    this.#socket = new WebSocket(credentials.url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        this.#heartbeat = window.setInterval(() => {
          if (this.#socket?.readyState === WebSocket.OPEN) {
            this.#socket.send(JSON.stringify({ t: "ping", ts: Date.now() }));
          }
        }, 30_000);
        this.dispatchEvent(new CustomEvent("state", { detail: { state: "open" } }));
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to Xirsys signaling"));
      };
      const cleanup = () => {
        this.#socket.removeEventListener("open", onOpen);
        this.#socket.removeEventListener("error", onError);
      };
      this.#socket.addEventListener("open", onOpen, { once: true });
      this.#socket.addEventListener("error", onError, { once: true });
    });

    this.#socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.t !== "pong") {
          this.dispatchEvent(new CustomEvent("message", { detail: packet }));
        }
      } catch {
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: { error: new Error("Received invalid Xirsys signaling JSON") },
          }),
        );
      }
    });
    this.#socket.addEventListener("close", () => {
      this.dispatchEvent(new CustomEvent("state", { detail: { state: "closed" } }));
    });
  }

  send(operation, payload, targetPeerId) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Xirsys signaling is not connected");
    }
    this.#socket.send(
      JSON.stringify({
        t: "u",
        m: {
          f: this.#peerId,
          o: operation,
          ...(targetPeerId ? { t: targetPeerId } : {}),
        },
        p: payload,
      }),
    );
  }

  disconnect() {
    if (this.#heartbeat) window.clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }
}

export function waitForIceGatheringComplete(peerConnection, timeoutMs = 8_000) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = window.setTimeout(finish, timeoutMs);
    function finish() {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
    function onStateChange() {
      if (peerConnection.iceGatheringState === "complete") finish();
    }
    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

function assertBootstrap(value) {
  if (
    !value ||
    !Array.isArray(value.iceServers) ||
    typeof value.clientSecret?.value !== "string"
  ) {
    throw new Error("The bootstrap endpoint returned an invalid response");
  }
}
