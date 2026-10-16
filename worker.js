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
      // Let Cloudflare Assets serve the actual game (index.html, CSS, JS and embedded models).
      // This fallback matters if the route is configured to run the Worker before static assets.
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }
      return new Response(
        "Blockworld Multiplayer Worker\nEndpoints: static game assets, GET /health, WebSocket /ws?room=main",
        { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }
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

  async webSocketMessage(ws, message) {
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
      // Replay persisted block edits so newly joined players receive the current room terrain.
      await this.sendBlockSnapshot(ws);
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

    if (packet.type === "block_edit") {
      const edit = this.cleanBlockEdit(packet.edit);
      if (!edit) {
        this.send(ws, { type: "error", message: "Invalid block edit" });
        return;
      }
      // Each room owns its own durable map edits. Last edit to a coordinate wins.
      const key = `block:${edit.dimension}:${edit.x},${edit.y},${edit.z}`;
      await this.ctx.storage.put(key, edit);
      // Do not echo back to the author; they have already applied the edit locally.
      this.broadcast({ type: "block_edit", edit, by: session.id }, ws);
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

  cleanBlockEdit(value) {
    if (!value || typeof value !== "object") return null;
    const integer = (v, min, max) => Number.isSafeInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
    const x = integer(value.x, -100000, 100000);
    const y = integer(value.y, 0, 255);
    const z = integer(value.z, -100000, 100000);
    const id = integer(value.id, 0, 65535);
    const dimension = ["overworld", "nether", "end", "fortnite"].includes(value.dimension) ? value.dimension : null;
    if ([x, y, z, id].some(v => v === null) || !dimension) return null;
    return { x, y, z, id, dimension };
  }

  async sendBlockSnapshot(ws) {
    try {
      const saved = await this.ctx.storage.list({ prefix: "block:" });
      const edits = [];
      for (const value of saved.values()) {
        if (value && typeof value === "object") edits.push(value);
      }
      // Small batches keep WebSocket messages compact even for a heavily edited world.
      for (let i = 0; i < edits.length; i += 24) {
        this.send(ws, { type: "block_snapshot", edits: edits.slice(i, i + 24) });
      }
    } catch (err) {
      this.send(ws, { type: "error", message: "Could not load saved block edits" });
    }
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
      elytra: value.elytra === true,
      dimension: ['overworld', 'nether', 'end', 'fortnite'].includes(value.dimension) ? value.dimension : 'overworld'
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
