#!/usr/bin/env node
// scripts/ws-broker.js
import http from "node:http";
import { WebSocketServer } from "ws";
import { URL } from "node:url";

const argPort = Number(process.argv[2] || "");
const requested = Number.isFinite(argPort) && argPort >= 0 ? argPort : 1234;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  } else if (req.method === "POST" && req.url === "/rendezvous/code") {
    // Minimal stub so README curl flows work if you want to use codes locally
    const appID = crypto.randomUUID();
    const code = appID.slice(0, 8); // trivial code, NOT for prod
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        appID,
        code,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

// Rooms keyed by appID: { A: ws|null, B: ws|null }
const rooms = new Map();

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const appID = u.searchParams.get("appID");
  const side = u.searchParams.get("side");
  if (!appID || !side || !/[AB]/.test(side)) {
    ws.close(1008, "missing appID/side");
    return;
  }

  let room = rooms.get(appID);
  if (!room) {
    room = { A: null, B: null };
    rooms.set(appID, room);
  }
  // Replace existing side (keeping tests simple)
  room[side] = ws;

  const otherSide = side === "A" ? "B" : "A";
  ws.on("message", (data) => {
    const peer = room[otherSide];
    if (peer && peer.readyState === 1) peer.send(data);
  });

  const cleanup = () => {
    if (rooms.get(appID) === room) {
      room[side] = null;
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
