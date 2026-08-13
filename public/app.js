import { RealtimeVoiceClient } from "./sdk/realtime-voice.js";

const elements = {
  audio: document.querySelector("#remote-audio"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  mute: document.querySelector("#mute"),
  send: document.querySelector("#send"),
  text: document.querySelector("#text-message"),
  forceRelay: document.querySelector("#force-relay"),
  signaling: document.querySelector("#use-signaling"),
  status: document.querySelector("#status"),
  model: document.querySelector("#model"),
  ice: document.querySelector("#ice-route"),
  signalingState: document.querySelector("#signaling-state"),
  log: document.querySelector("#event-log"),
};

const client = new RealtimeVoiceClient({ audioElement: elements.audio });
let isMuted = false;

client.addEventListener("status", ({ detail }) => {
  setStatus(detail.status);
  const connected = detail.status === "connected";
  elements.connect.disabled = detail.status !== "idle";
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
  if (detail.state === "connected" || detail.state === "completed") showStats();
});

client.addEventListener("peer-state", ({ detail }) => log("peer", detail));

client.addEventListener("signaling-state", ({ detail }) => {
  elements.signalingState.textContent = `WebSocket ${detail.state}`;
});

client.addEventListener("signaling-message", ({ detail }) => {
  log("xirsys websocket", detail);
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
  elements.connect.disabled = true;
  try {
    await client.connect({
      forceRelay: elements.forceRelay.checked,
      includeSignaling: elements.signaling.checked,
    });
  } catch (error) {
    log("connect failed", error.message);
  }
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
  const stats = await client.getConnectionStats();
  if (!stats) return;
  const roundTrip = Number.isFinite(stats.currentRoundTripTime)
    ? ` · ${Math.round(stats.currentRoundTripTime * 1_000)} ms RTT`
    : "";
  elements.ice.textContent = `${stats.localCandidateType ?? "unknown"} / ${stats.localProtocol ?? "unknown"}${roundTrip}`;
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

function log(label, value) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${label}  ${typeof value === "string" ? value : JSON.stringify(value)}`;
  elements.log.prepend(line);
}

setStatus("idle");
