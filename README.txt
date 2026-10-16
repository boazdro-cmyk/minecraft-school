MINECRAFT-SCHOOL: MULTIPLAYER BLOCK SYNC

This package adds shared block edits to the existing Blockworld multiplayer room.

What syncs:
- Placing blocks (right-click / mobile place action)
- Mining/breaking blocks (survival and creative)
- Bucket placement/removal and block edits handled by the regular place action
- Persisted block edits are replayed to players who join later
- Block edits are room-specific and use the same room name: main

Deploy from this folder:
  npx wrangler login
  npx wrangler deploy

The configured Worker name is minecraft-school. Deployment updates that Worker and its static assets.
Game URL: https://minecraft-school.boazdro.workers.dev/
WebSocket URL used by the game: wss://minecraft-school.boazdro.workers.dev/ws?room=main
Health check: https://minecraft-school.boazdro.workers.dev/health

Important: this syncs block changes, not inventory counts, dropped item entities, chests, entities, or the original random world seed. If both players should start from exactly identical terrain, the game also needs a shared world seed/generation system.
