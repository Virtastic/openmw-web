# Id scope beyond one Node process (OT3-141, decision)

Status: DECIDED for the region-peer design (OT3-77). Region peers are separate *engine*
processes under ONE Node process, so none of the ids below has to leave the process today. This
note fixes which ids stay process-local, which must become global the day a second Node
process exists, and how to migrate. It changes no code.

## Why this is safe now

`peers/regions.ts` shards the *simulation* (one headless OpenMW per region). Every region peer
connects to the same Node server over the ordinary websocket, so there is still one roster, one
cell store and one resume directory. The 'killing one region's peer' gate (SimReady only to that
region) needs no id change.

## Decision per id

| Id | Where | Scope now | Decision |
| --- | --- | --- | --- |
| Player id (u16) | `core/players.ts` `nextId`, wraps at 0xffff, skips in-use | per Node process | **Stays process-local.** It is a wire handle for the live session, never persisted (the character is `charId`). Region peers are players of the same roster, so they share the space. A second Node process would be a second *world* with its own roster; ids may repeat across worlds because no message crosses worlds. |
| `netId` of placed objects | `persist/cellstore.ts` `nextNetId` / `netIdCeiling`, block-allocated from the world's global row | per world (persisted) | **Stays per-world, persisted.** It is stored inside the cell docs (`n:<netId>` keys), so it is only meaningful with that world's cell store. Two Node processes sharing one cell store would need the block allocation (already `NET_ID_BLOCK`) moved to a shared sequence; do not share a store between processes without that. |
| Cell key | `"x,y"` / interior name | global by construction | **Global.** Content-derived, identical in every process and every region. Region ownership is derived from it (`RegionMap.regionOf`), never stored on it. |
| Region id | `peers/regions.ts` | config | **Global, operator-defined.** Part of the peer account name (`simpeer-<region>`) and of the `region` metric label. Renaming a region is a restart. |
| Resume ticket | `core/resume.ts`, per-world directory | per world | **Stays per-world.** A ticket resumes a socket onto the roster that parked it. It must not be honoured by another process. |
| Peer account name | `simpeer-<region>` | per world | Region peers authenticate with the server password; the name is how `keyOfAccount` maps a connection to its region. Unique per region, so two regions never collide. |
| `charId` / `accountKey` | persist | global | Already global (opaque ids). Unchanged. |

## What must change before a SECOND NODE PROCESS (not planned)

1. Player ids: no change if the processes are separate worlds. If they ever share one logical
   world, move to a (process, local id) pair on the wire, or a lease-based allocator.
2. `netId`: allocate blocks from one shared store (the existing ceiling row becomes the shared
   counter); keep `NET_ID_BLOCK` allocation so the hot path stays local.
3. Resume tickets: move the directory to shared storage and key by world id, or keep per-process
   and pin a session to the process that parked it.

## Migration notes

* Adding regions to an existing world needs **no data migration**: ids and cell docs are
  unchanged; only which peer holds a cell changes.
* Interiors learn their owning region from the first door seen (`RegionMap.learnDoor`). The
  learned table is in memory; after a restart an interior is owned by the default region until a
  player walks in again. `RegionMap` already takes a static door table; exposing it in config is the follow-up if that matters.
* Changing region rectangles on a live world only moves *authority*: the claimed-diff in
  `simPeerPass` releases cells from the old peer and enters them on the new one.
