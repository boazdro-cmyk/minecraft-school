import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 32;
const MAX_PACKET_CHARS = 4096;
const STATE_RATE_MS = 70;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "blockworld-multiplayer", version: 1 });
    }
    if (url.pathname !== "/ws") {
      return new Response(
        "Blockworld Multiplayer Worker\nEndpoints: GET /health, WebSocket /ws?room=world1",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const room = (url.searchParams.get("room") || "world1")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 32) || "world1";
    const id = env.GAME_ROOMS.idFromName(room);
    return env.GAME_ROOMS.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    // Rebuild room sessions after hibernation from connection attachments.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const data = ws.deserializeAttachment();
        if (data?.id) this.sessions.set(ws, data);
      } catch { /* Ignore a damaged stale attachment. */ }
    }
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch { /* Heartbeat auto-response is optional on older compatibility dates. */ }
  }

  async fetch(request) {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS_PER_ROOM) {
      return new Response("Room is full (maximum 32 players)", { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = {
      id: crypto.randomUUID(),
      name: "Player",
      state: null,
      lastStateAt: 0,
      joined: false
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const raw = typeof message === "string"
      ? message
      : message instanceof ArrayBuffer
        ? new TextDecoder().decode(message)
        : String(message);
    if (raw.length > MAX_PACKET_CHARS) {
      this.send(ws, { type: "error", message: "Packet too large" });
      return;
    }
    let packet;
    try { packet = JSON.parse(raw); }
    catch { this.send(ws, { type: "error", message: "Invalid JSON" }); return; }
    if (!packet || typeof packet.type !== "string") return;

    let session = this.sessions.get(ws);
    if (!session) {
      try { session = ws.deserializeAttachment(); } catch { session = null; }
    }
    if (!session?.id) session = { id: crypto.randomUUID(), name: "Player", state: null, lastStateAt: 0, joined: false };

    if (packet.type === "join") {
      session.name = this.cleanName(packet.name);
      session.joined = true;
      session.state = session.state || null;
      session.lastStateAt = 0;
      this.sessions.set(ws, session);
      ws.serializeAttachment(session);
      this.send(ws, {
        type: "welcome",
        id: session.id,
        roomSize: this.ctx.getWebSockets().length,
        players: this.playersExcept(session.id)
      });
      this.broadcast({ type: "player_joined", player: this.toPlayer(session) }, ws);
      return;
    }

    if (!session.joined) {
      this.send(ws, { type: "error", message: "Send join first" });
      return;
    }

    if (packet.type === "state") {
      const now = Date.now();
      if (now - (session.lastStateAt || 0) < STATE_RATE_MS) return;
      const state = this.cleanState(packet.state);
      if (!state) return;
      session.state = state;
      session.lastStateAt = now;
      this.sessions.set(ws, session);
      ws.serializeAttachment(session);
      this.broadcast({ type: "player_update", player: this.toPlayer(session) }, ws);
      return;
    }

    if (packet.type === "chat") {
      const text = typeof packet.text === "string" ? packet.text.trim().slice(0, 160) : "";
      if (text) this.broadcast({ type: "chat", id: session.id, name: session.name, text });
      return;
    }
    if (packet.type === "ping") this.send(ws, { type: "pong", time: Date.now() });
  }

  webSocketClose(ws) {
    let session = this.sessions.get(ws);
    if (!session) { try { session = ws.deserializeAttachment(); } catch { session = null; } }
    this.sessions.delete(ws);
    if (session?.id) this.broadcast({ type: "player_left", id: session.id });
  }

  webSocketError(ws) {
    let session = this.sessions.get(ws);
    if (!session) { try { session = ws.deserializeAttachment(); } catch { session = null; } }
    this.sessions.delete(ws);
    if (session?.id) this.broadcast({ type: "player_left", id: session.id });
  }

  cleanName(value) {
    const name = typeof value === "string" ? value.replace(/[<>\r\n]/g, "").trim().slice(0, 18) : "";
    return name || "Player";
  }

  cleanState(value) {
    if (!value || typeof value !== "object") return null;
    const num = (k, lo, hi) => {
      const n = Number(value[k]);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
    };
    const x = num("x", -100000, 100000);
    const y = num("y", -512, 2048);
    const z = num("z", -100000, 100000);
    const yaw = num("yaw", -100000, 100000);
    const pitch = num("pitch", -1.7, 1.7);
    if ([x, y, z, yaw, pitch].some(v => v === null)) return null;
    return {
      x, y, z,
      yaw: ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
      pitch,
      mode: value.mode === "creative" ? "creative" : "survival",
      vehicle: value.vehicle === true,
      elytra: value.elytra === true
    };
  }

  toPlayer(session) {
    return { id: session.id, name: session.name, state: session.state };
  }

  playersExcept(id) {
    const players = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const s = ws.deserializeAttachment();
        if (s?.joined && s.id !== id && s.state) players.push(this.toPlayer(s));
      } catch { /* ignore */ }
    }
    return players;
  }

  send(ws, packet) {
    try { ws.send(JSON.stringify(packet)); } catch { /* Ignore disconnected clients. */ }
  }

  broadcast(packet, except = null) {
    const text = JSON.stringify(packet);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { if (ws.readyState === WebSocket.OPEN) ws.send(text); } catch { /* disconnected */ }
    }
  }
}
