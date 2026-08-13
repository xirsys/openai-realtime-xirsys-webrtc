import { RealtimeVoiceClient } from "./sdk/realtime-voice.js";

const elements = {
  audio: document.querySelector("#remote-audio"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  mute: document.querySelector("#mute"),
  send: document.querySelector("#send"),
  text: document.querySelector("#text-message"),
  apiKey: document.querySelector("#openai-api-key"),
  toggleApiKey: document.querySelector("#toggle-api-key"),
  forceRelay: document.querySelector("#force-relay"),
  signaling: document.querySelector("#use-signaling"),
  status: document.querySelector("#status"),
  model: document.querySelector("#model"),
  ice: document.querySelector("#ice-route"),
  signalingState: document.querySelector("#signaling-state"),
  diagnosticRoute: document.querySelector("#diagnostic-route"),
  diagnosticPath: document.querySelector("#diagnostic-path"),
  diagnosticTurn: document.querySelector("#diagnostic-turn"),
  diagnosticWebSocket: document.querySelector("#diagnostic-websocket"),
  log: document.querySelector("#event-log"),
};

const client = new RealtimeVoiceClient({ audioElement: elements.audio });
let isMuted = false;
let currentStatus = "idle";
let lastConnectivityFingerprint = "";
let websocketInfo = createWebSocketInfo(false);

client.addEventListener("status", ({ detail }) => {
  currentStatus = detail.status;
  setStatus(detail.status);
  const connected = detail.status === "connected";
  syncConnectAvailability();
  elements.disconnect.disabled = detail.status === "idle";
  elements.mute.disabled = !connected;
  elements.send.disabled = !connected;

  if (connected) {
    window.setTimeout(showStats, 1_000);
  }
});

client.addEventListener("session", ({ detail }) => {
  elements.model.textContent = `${detail.model ?? "Realtime"} · ${detail.voice ?? "default voice"}`;
  log("session", detail);
  if (detail.signaling) {
    client.sendSignalingMessage("agent-status", { state: "connected" });
  }
});

client.addEventListener("ice-state", ({ detail }) => {
  elements.ice.textContent = `ICE ${detail.state}`;
  log("ice state", detail);
  if (detail.state === "connected" || detail.state === "completed") showStats();
});

client.addEventListener("peer-state", ({ detail }) => log("peer", detail));

client.addEventListener("signaling-state", ({ detail }) => {
  elements.signalingState.textContent = `WebSocket ${detail.state}`;
  websocketInfo = { ...websocketInfo, ...detail, enabled: true };
  renderWebSocketInfo();
  log("xirsys websocket state", detail);
});

client.addEventListener("signaling-message", ({ detail }) => {
  websocketInfo.received += 1;
  renderWebSocketInfo();
  log("xirsys websocket", detail);
});

client.addEventListener("signaling-sent", ({ detail }) => {
  websocketInfo.sent += 1;
  renderWebSocketInfo();
  log("xirsys websocket sent", detail);
});

client.addEventListener("realtime", ({ detail }) => {
  const important = new Set([
    "session.created",
    "session.updated",
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "conversation.item.input_audio_transcription.completed",
    "response.output_audio_transcript.done",
    "response.done",
    "error",
  ]);
  if (important.has(detail.type)) log("openai data channel", detail);
});

client.addEventListener("error", ({ detail }) => log("error", detail.error.message));

elements.connect.addEventListener("click", async () => {
  let openaiApiKey = elements.apiKey.value.trim();
  if (!openaiApiKey) return;
  resetConnectionDiagnostics(elements.signaling.checked);
  elements.connect.disabled = true;
  try {
    const connection = client.connect({
      openaiApiKey,
      forceRelay: elements.forceRelay.checked,
      includeSignaling: elements.signaling.checked,
    });
    elements.apiKey.value = "";
    openaiApiKey = "";
    syncConnectAvailability();
    await connection;
  } catch (error) {
    log("connect failed", error.message);
  }
});

elements.apiKey.addEventListener("input", syncConnectAvailability);
elements.apiKey.addEventListener("paste", () => window.setTimeout(syncConnectAvailability));
elements.toggleApiKey.addEventListener("click", () => {
  const reveal = elements.apiKey.type === "password";
  elements.apiKey.type = reveal ? "text" : "password";
  elements.toggleApiKey.textContent = reveal ? "Hide" : "Show";
  elements.toggleApiKey.setAttribute("aria-label", `${reveal ? "Hide" : "Show"} API key`);
});

elements.disconnect.addEventListener("click", () => client.disconnect());

elements.mute.addEventListener("click", () => {
  isMuted = !isMuted;
  client.setMuted(isMuted);
  elements.mute.textContent = isMuted ? "Unmute" : "Mute";
});

elements.send.addEventListener("click", sendText);
elements.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendText();
});

async function showStats() {
  try {
    const stats = await client.getConnectionStats();
    if (!stats) return;
    const roundTripMs = Number.isFinite(stats.currentRoundTripTime)
      ? Math.round(stats.currentRoundTripTime * 1_000)
      : undefined;
    const roundTrip = roundTripMs === undefined ? "" : ` · ${roundTripMs} ms RTT`;
    const protocol = stats.localProtocol?.toUpperCase() ?? "unknown protocol";

    elements.ice.textContent = `${stats.routeLabel} · ${protocol}${roundTrip}`;
    elements.diagnosticRoute.textContent = stats.routeLabel;
    elements.diagnosticPath.textContent = [
      `${stats.localCandidateType ?? "unknown"} candidate`,
      protocol,
      stats.relayProtocol ? `TURN over ${stats.relayProtocol.toUpperCase()}` : undefined,
      roundTripMs === undefined ? undefined : `${roundTripMs} ms RTT`,
    ]
      .filter(Boolean)
      .join(" · ");

    const turnEndpoint = stats.turnServer
      ? formatHostPort(stats.turnServer.host, stats.turnServer.port)
      : undefined;
    const relayAllocation =
      stats.route === "turn" && stats.localAddress
        ? formatHostPort(stats.localAddress, stats.localPort)
        : undefined;
    elements.diagnosticTurn.textContent =
      stats.route === "turn"
        ? [
            turnEndpoint ? `server ${turnEndpoint}` : "server unavailable",
            stats.turnServer?.transport
              ? `transport ${stats.turnServer.transport.toUpperCase()}`
              : undefined,
            relayAllocation ? `relay ${relayAllocation}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Not in use — selected path is direct";

    const connectivity = {
      route: stats.routeLabel,
      candidateType: stats.localCandidateType,
      protocol: stats.localProtocol,
      rttMs: roundTripMs,
      ...(stats.route === "turn"
        ? {
            xirsysTurnServer: stats.turnServer?.host,
            xirsysTurnPort: stats.turnServer?.port,
            turnTransport: stats.turnServer?.transport,
            relayAddress: stats.localAddress,
            relayPort: stats.localPort,
          }
        : {}),
    };
    const fingerprint = JSON.stringify({
      ...connectivity,
      rttMs: undefined,
    });
    if (fingerprint !== lastConnectivityFingerprint) {
      lastConnectivityFingerprint = fingerprint;
      log("webrtc connectivity", removeUndefined(connectivity));
    }
  } catch (error) {
    log("stats unavailable", error instanceof Error ? error.message : String(error));
  }
}

function sendText() {
  const text = elements.text.value;
  if (!text.trim()) return;
  client.sendText(text);
  log("you (text event)", text);
  elements.text.value = "";
}

function setStatus(status) {
  elements.status.textContent = status.replaceAll("-", " ");
  elements.status.dataset.state = status;
}

function syncConnectAvailability() {
  elements.connect.disabled = currentStatus !== "idle" || !elements.apiKey.value.trim();
}

function resetConnectionDiagnostics(signalingEnabled, pending = true) {
  lastConnectivityFingerprint = "";
  elements.diagnosticRoute.textContent = pending
    ? "Waiting for selected ICE pair"
    : "Not connected";
  elements.diagnosticPath.textContent = pending
    ? "Gathering candidates"
    : "No candidate pair selected";
  elements.diagnosticTurn.textContent = pending
    ? "Waiting for selected path"
    : "Not in use";
  websocketInfo = createWebSocketInfo(signalingEnabled);
  elements.signalingState.textContent = signalingEnabled
    ? "WebSocket requested"
    : "WebSocket off";
  renderWebSocketInfo();
}

function createWebSocketInfo(enabled) {
  return {
    enabled,
    state: enabled ? "requesting credentials" : "disabled",
    sent: 0,
    received: 0,
  };
}

function renderWebSocketInfo() {
  if (!websocketInfo.enabled) {
    elements.diagnosticWebSocket.textContent = "Disabled";
    return;
  }

  elements.diagnosticWebSocket.textContent = [
    websocketInfo.state,
    websocketInfo.endpoint,
    websocketInfo.peerId ? `peer ${websocketInfo.peerId}` : undefined,
    `app messages ↑${websocketInfo.sent} ↓${websocketInfo.received}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatHostPort(host, port) {
  if (!host) return undefined;
  const safeHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port ? `${safeHost}:${port}` : safeHost;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function log(label, value) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${label}  ${typeof value === "string" ? value : JSON.stringify(value)}`;
  elements.log.prepend(line);
}

setStatus("idle");
syncConnectAvailability();
resetConnectionDiagnostics(false, false);
