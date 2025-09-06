// src/env/node-polyfills.js
import { webcrypto } from "node:crypto";
import WebSocket from "ws";

// WebCrypto on Node
globalThis.crypto ??= webcrypto;

// WebSocket on Node
globalThis.WebSocket ||= WebSocket;
