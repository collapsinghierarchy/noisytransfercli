#!/usr/bin/env node
// scripts/ws-broker.js
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { URL } from "node:url";

const argPort = Number(process.argv[2] || "");
const requested = Number.isFinite(argPort) && argPort >= 0 ? argPort : 1234;

// shortCode -> { appID, expiresAt }
const codes = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Create short code
  if (req.method === "POST" && url.pathname === "/rendezvous/code") {
    const appID = crypto.randomUUID();
    const code = appID.slice(0, 8); // tests only
    const expiresAt = new Date(Date.now() + 600_000).toISOString(); // +10min
    codes.set(code, { appID, expiresAt });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", appID, code, expiresAt }));
    return;
  }

  // Redeem short code -> appID (support the 3 probe paths)
  if (
    req.method === "POST" &&
    (url.pathname === "/rendezvous/redeem" ||
      url.pathname === "/redeem" ||
      url.pathname === "/code/redeem")
  ) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let short = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        short = String(body?.code || "").trim();
      } catch {}
      if (!short) {
        res.statusCode = 400;
        res.end("code required");
        return;
      }
      short = short.replace(/-pq$/, ""); // allow "-pq" suffix
      const rec = codes.get(short);
      if (!rec) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", appID: rec.appID, expiresAt: rec.expiresAt }));
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

// ----------------------
// Minimal signaling WS
// ----------------------

// Rooms keyed by appID
// room = { A: ws|null, B: ws|null, qA: string[], qB: string[] }
const rooms = new Map();

const wss = new WebSocketServer({ server, path: "/ws" });

function sendJSON(ws, obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {}
}

function normalizeToText(data) {
  // Ensure JSON goes out as a text frame. Node 'ws' may give Buffer/Uint8Array.
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data === "object" && "toString" in data) return String(data);
  return String(data);
}

wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const appID = u.searchParams.get("appID");
  const side = u.searchParams.get("side"); // "A" or "B"
  if (!appID || !side || !/[AB]/.test(side)) {
    ws.close(1008, "missing appID/side");
    return;
  }

  let room = rooms.get(appID);
  if (!room) {
    room = { A: null, B: null, qA: [], qB: [] };
    rooms.set(appID, room);
  }
  // Replace existing side (keeps tests simple)
  room[side] = ws;

  const other = side === "A" ? "B" : "A";

  // If both peers are present, notify and flush any queued signaling
  if (room.A && room.B) {
    sendJSON(room.A, { type: "room_full" });
    sendJSON(room.B, { type: "room_full" });

    // flush queues (messages buffered before the peer connected)
    for (const msg of room.qA) if (room.B?.readyState === 1) room.B.send(msg);
    for (const msg of room.qB) if (room.A?.readyState === 1) room.A.send(msg);
    room.qA.length = 0;
    room.qB.length = 0;
  }

  ws.on("message", (data) => {
    const text = normalizeToText(data);
    const peer = room[other];
    if (peer && peer.readyState === 1) {
      peer.send(text); // forward as TEXT
    } else {
      // buffer until peer connects
      if (side === "A") room.qA.push(text);
      else room.qB.push(text);
    }
  });

  const cleanup = () => {
    if (rooms.get(appID) === room) {
      room[side] = null;
      const peer = room[other];
      if (peer && peer.readyState === 1) sendJSON(peer, { type: "peer_left" });
      if (!room.A && !room.B) rooms.delete(appID);
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

function listen(port) {
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const chosen = typeof addr === "object" && addr ? addr.port : port;
    console.log(`BROKER_PORT=${chosen}`);
  });
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && argPort === 0) return listen(0);
  throw err;
});

listen(requested);
