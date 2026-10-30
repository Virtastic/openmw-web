# What the sim peer's dummy player represents (OT3-62)

Status: decided. Covers v2 (one world, per-character progression).

## The facts

The sim peer is one headless engine with ONE MWScript state and ONE `Player` object (the
dummy), parked next to whatever it simulates. Every real player is an avatar actor on the peer.
Nothing about progression is world-wide any more (OT3-51): journal, story globals, topics,
factions, disposition, kill tallies and NPC locals live on each character's doc.

## The decision

**The dummy is neutral: it represents nobody's progress.** It is a camera and an anchor for
the engine's `Player` reference, not a character.

1. **Per-character conditions are evaluated on the character's own client.** Dialogue,
   journal-gated quest steps, faction rank checks, disposition and `GetDeadCount` run in the
   engine of the player in the conversation. That engine holds that character's journal, globals,
   topics and (OT3-113) NPC locals, so `GetJournalIndex`, `GetPCRank`, `GetDeadCount` mean
   "this player's" there. They are never answered by the peer.
2. **On the peer, a condition that reads the dummy's own state answers neutrally.** The dummy
   has an empty journal, no faction, no topics, no kills: `GetJournalIndex` is 0 and
   `GetPCFaction` is false. A script that depends on that is a *world* script (ambient AI
   packages, schedules, combat, weather/blight) and its answer must not depend on any one
   player. A world script that really needs a player's progress must be driven by the client
   that has it; the peer only simulates the consequences (movement, combat, spawns).
3. **Peer writes credit a character or nobody.** A peer `JournalEntry`/`GlobalVarUpdate`/
   `GlobalScriptsUpdate` that names the causing character (`charId`) is credited to that
   character alone. Without one: the journal credits only characters that already hold that
   quest, globals and scripts credit nobody (`quests.ts peerCredit`, OT3-19). Never everyone.
4. **A human's writes reach the peer, not other humans.** The peer hears a human's global and
   NPC-local write (it runs the world's copy of the scripts); no other player does.
5. **Shared state is only the clock and weather.** `worldGlobals` (weather, blight, ghostfence)
   are the sole globals relayed to everyone.
6. **The dummy's script-class table**

| Script class | Runs on | Condition reads |
|---|---|---|
| Dialogue results, topic filters, quest-step scripts | the talking player's client | that character |
| Faction/PC rank scripts (`PCRaiseRank`, `PCExpell`) | the character's client; the peer's dummy calls are ignored (`faction()` returns for `system`) | that character |
| Global scripts started by a quest | the character's client (`doc.scripts`, OT3-116) | that character |
| NPC local scripts (AI timers, animations) | the peer, shared per cell | neutral dummy |
| Ambient/world scripts (weather, blight, schedules) | the peer | neutral dummy |

## Step 7 gate

Two players at different stages of one quest both finish it independently: pinned by
`server/test/step7gate.test.ts` (journal, story global and NPC local per character, nothing
relayed, both end at the final stage), with `quests.test.ts`/`quest171.test.ts` covering the
peer-credit and NPC-local rules. The in-engine half (a bake and a two-client sweep) is still to
be run.

## Not covered here

An NPC local-script quest flag that the PEER itself writes while evaluating a neutral dummy is
shared per cell by design (rule 2); if a vanilla quest turns out to use one, it moves to the
client-driven class above.
