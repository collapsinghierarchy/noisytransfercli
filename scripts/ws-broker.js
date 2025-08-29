#!/usr/bin/env node
//(optional dev helper)
/* eslint-disable no-console */
import { WebSocketServer } from "ws";
import http from "node:http";
import url from "node:url";

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

wss.on("connection", (ws, request) => {
  const { query } = url.parse(request.url, true);
  const room = String(query.appID || "");
  const side = String(query.side || "");
  if (!room || !/^[A-Za-z0-9-_.]{1,100}$/.test(room) || !/[AB]/.test(side)) { ws.close(1008, "bad params"); return; }
  let entry = rooms.get(room); if (!entry) rooms.set(room, (entry = {}));
  entry[side] = ws;
  const other = side === "A" ? "B" : "A";

  const cleanup = () => { try { ws.close(); } catch {} const e = rooms.get(room); if (e) { delete e[side]; if (!e.A && !e.B) rooms.delete(room); } };
  ws.on("message", (buf) => { const peer = entry[other]; if (!peer || peer.readyState !== peer.OPEN) return; try { peer.send(buf); } catch {} });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = url.parse(req.url);
  if (pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const PORT = Number(process.env.PORT || 1234);
server.listen(PORT, () => console.log(`WS broker on ws://localhost:${PORT}/ws`));
