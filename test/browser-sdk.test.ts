import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelayOnlySdp,
  describeXirsysSignalingEndpoint,
  summarizeIceConnection,
} from "../public/sdk/realtime-voice.js";

test("summarizes a selected Xirsys TURN relay without exposing URL credentials", () => {
  const reports = new Map([
    [
      "transport-1",
      {
        id: "transport-1",
        type: "transport",
        selectedCandidatePairId: "pair-1",
      },
    ],
    [
      "pair-1",
      {
        id: "pair-1",
        type: "candidate-pair",
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1",
        currentRoundTripTime: 0.042,
        bytesSent: 1234,
        bytesReceived: 5678,
      },
    ],
    [
      "local-1",
      {
        id: "local-1",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "tcp",
        address: "203.0.113.10",
        port: 49152,
        url: "turns:temporary-user:temporary-password@turn.example.xirsys.com:443?transport=tcp",
      },
    ],
    [
      "remote-1",
      {
        id: "remote-1",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "udp",
      },
    ],
  ]);

  const stats = summarizeIceConnection(reports);

  assert.equal(stats?.route, "turn");
  assert.equal(stats?.routeLabel, "TURN relay");
  assert.deepEqual(stats?.turnServer, {
    host: "turn.example.xirsys.com",
    port: 443,
    transport: "tcp",
    scheme: "turns",
  });
  assert.equal(stats?.localAddress, "203.0.113.10");
  assert.equal(stats?.localPort, 49152);
  assert.equal(JSON.stringify(stats).includes("temporary-user"), false);
  assert.equal(JSON.stringify(stats).includes("temporary-password"), false);
});

test("labels a server-reflexive candidate as a STUN-discovered direct path", () => {
  const reports = new Map([
    [
      "pair-1",
      {
        id: "pair-1",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1",
      },
    ],
    [
      "local-1",
      {
        id: "local-1",
        type: "local-candidate",
        candidateType: "srflx",
        protocol: "udp",
      },
    ],
    [
      "remote-1",
      {
        id: "remote-1",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "udp",
      },
    ],
  ]);

  const stats = summarizeIceConnection(reports);

  assert.equal(stats?.route, "stun");
  assert.equal(stats?.routeLabel, "Direct (STUN-discovered)");
  assert.equal(stats?.turnServer, undefined);
});

test("labels a peer-reflexive candidate as STUN connectivity", () => {
  const reports = candidateReports("prflx");

  const stats = summarizeIceConnection(reports);

  assert.equal(stats?.route, "stun");
  assert.equal(stats?.routeLabel, "STUN (peer-reflexive)");
});

test("relay-only mode overrides misleading peer-reflexive browser stats", () => {
  const reports = candidateReports("prflx");
  const stats = summarizeIceConnection(reports, {
    forceRelay: true,
    relayCandidates: [
      {
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "udp",
        address: "203.0.113.20",
        port: 50000,
        url: "turn:turn.example.xirsys.com:3478?transport=udp",
      },
    ],
  });

  assert.equal(stats?.route, "turn");
  assert.equal(stats?.routeLabel, "TURN relay");
  assert.equal(stats?.relayEnforced, true);
  assert.equal(stats?.localCandidateType, "relay");
  assert.equal(stats?.browserCandidateType, "prflx");
  assert.deepEqual(stats?.turnServer, {
    host: "turn.example.xirsys.com",
    port: 3478,
    transport: "udp",
    scheme: "turn",
  });
});

test("relay-only SDP removes every non-relay candidate", () => {
  const sdp = [
    "v=0",
    "a=candidate:1 1 udp 1 192.0.2.1 5000 typ host",
    "a=candidate:2 1 udp 1 198.51.100.1 5001 typ srflx raddr 192.0.2.1 rport 5000",
    "a=candidate:3 1 udp 1 203.0.113.1 5002 typ relay raddr 198.51.100.1 rport 5001",
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  const filtered = createRelayOnlySdp(sdp);

  assert.equal(filtered.includes("typ host"), false);
  assert.equal(filtered.includes("typ srflx"), false);
  assert.equal(filtered.includes("typ relay"), true);
  assert.equal(filtered.endsWith("\r\n"), true);
});

test("relay-only SDP fails before OpenAI negotiation when TURN gathering fails", () => {
  const sdp = [
    "v=0",
    "a=candidate:1 1 udp 1 192.0.2.1 5000 typ host",
    "",
  ].join("\r\n");

  assert.throws(
    () => createRelayOnlySdp(sdp),
    /no Xirsys relay candidate was gathered/,
  );
});

test("describes Xirsys signaling without exposing the token-bearing URL path", () => {
  const token = "secret-signaling-token";
  const details = describeXirsysSignalingEndpoint(
    `wss://signal.example.xirsys.com/v2/${token}`,
    "peer-123",
  );

  assert.deepEqual(details, {
    endpoint: "wss://signal.example.xirsys.com:443",
    host: "signal.example.xirsys.com",
    port: 443,
    protocol: "wss",
    peerId: "peer-123",
  });
  assert.equal(JSON.stringify(details).includes(token), false);
});

function candidateReports(candidateType: string) {
  return new Map([
    [
      "pair-1",
      {
        id: "pair-1",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1",
      },
    ],
    [
      "local-1",
      {
        id: "local-1",
        type: "local-candidate",
        candidateType,
        protocol: "udp",
      },
    ],
    [
      "remote-1",
      {
        id: "remote-1",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "udp",
      },
    ],
  ]);
}
