// scripts/ws-check.js
import WebSocket from "ws";
const urlA = "ws://127.0.0.1:1234/ws?appID=pingpong&side=A";
const urlB = "ws://127.0.0.1:1234/ws?appID=pingpong&side=B";
const a = new WebSocket(urlA);
const b = new WebSocket(urlB);
b.on("message", (m) => {
  console.log("B got:", m.toString());
  process.exit(0);
});
b.on("open", () => {
  a.on("open", () => a.send(JSON.stringify({ type: "offer", hello: true })));
});
[a, b].forEach((ws) =>
  ws.on("error", (e) => {
    console.error("WS error", e.message);
    process.exit(1);
  })
);
