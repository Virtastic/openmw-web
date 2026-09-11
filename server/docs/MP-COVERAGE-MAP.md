# Multiplayer coverage map

Every single-player action, routine and NPC behaviour, mapped to the path it takes in the
server-centralized model, with its status. This is the checklist the gameplay passes work
from; MP-BACKLOG.md holds the long-form reasoning for anything marked GAP.

Model in one paragraph: the SERVER holds truth (character docs, cell docs, clock, quest
state) and relays; ONE SIM PEER per world runs the engine for every occupied cell (NPC AI,
combat resolution, physics of each player's AVATAR); each CLIENT runs its own engine for
rendering, UI, dialogue and everything the player does with their own hands, and sees other
players and NPCs as PUPPETS steered by relayed poses with their AI off. Anything the client
does that changes the world has to travel; anything the peer does to a player has to come
back. Status: OK = traced and correct; FIXED = broken until the pass found it (date); GAP =
known and recorded; N/A = does not exist in single player either.

## 1. Session

| Action | MP path | Status |
|---|---|---|
| Sign in (password / SSO ticket) | launcher -> gateway -> world server SessionHello/Login | OK |
| Create character, chargen | private world `priv-<user>-<char>`; chargen sanctuary keeps the peer out of the cell | OK |
| Resume after disconnect | resume ticket, same character, world snapshot re-sent; IP_CAP retried | FIXED 09-11 (IP_CAP was terminal RATE) |
| Rejoin after dying and closing the tab | doc has hp 0 (death flushes); restored at 10% health on both the client and the peer's avatar, where they fell | FIXED 09-11 (was: die again on arrival, second "has fallen", respawn loop) |
| Join a friend (party) | joinFriend -> ownerWorld (occupied) -> switch -> mayJoinWorld -> chargen gate -> guestSpawn beside owner | FIXED 09-10 |
| Owner flips party -> private | WorldClosed, 5 s grace, guests switched home | OK |
| Leave / kick / ban | terminal codes; SUPERSEDED for a second tab | OK |
| Save / Load / quicksave | refused at StateManager while Joined; menu items hidden | OK |

## 2. Movement and travel

| Action | MP path | Status |
|---|---|---|
| Walk/run/sneak/jump | input frame 30 Hz -> avatar on peer -> authoritative pose back; reconciliation | OK |
| Stance (weapon/spell drawn) | input bits 4-5 -> avatar; pose bit 4 -> puppets | FIXED 09-10 (avatar never drew) |
| Look pitch | input pitch -> avatar pitchChange | FIXED 09-10 |
| Doors, load doors | client cell change -> PlayerCellChange -> avatar follow-teleport; door state relayed | OK |
| Silt strider / boat / guild guide | cell change + time skip request + fare from shared purse | OK |
| Mark/Recall/Intervention/scripted PositionCell | cell change; far-travel limiter is a signal only | OK |
| Levitate / Water Walk / Slowfall / Fortify Speed | PlayerActiveSpells -> avatar | FIXED 09-11 |
| Swimming, drowning, falling | avatar physics; peer-authored bars | OK |
| Followers through doors | peer moves followers with the avatar; exterior key -> teleport arg | FIXED 09-10 |

## 3. Combat

| Action | MP path | Status |
|---|---|---|
| Melee vs NPC | client swing cancelled; avatar swings on peer (stance, use bit) | FIXED 09-10 |
| Ranged | avatar fires; ammo reconciled via inventory; a missed arrow (and any runtime item the world creates near an avatar: death drops, scripted items) is named by the peer as a world placement, so it can be picked up on every screen | FIXED 09-11 (was: peer-local, arrows unrecoverable) |
| Blocking, armor, difficulty | peer engine, avatar treated as player for scaling | OK |
| Spell at NPC (touch/target) | client casts; hit on puppet recorded -> CombatSpellHit -> holder applies record | OK |
| Self-cast / potion / scroll | PlayerActiveSpells -> avatar (spell stance = Nothing on avatar) | FIXED 09-11 |
| Cast-on-strike, charge | avatar strike on peer; charge: client both ways, peer lowers | FIXED 09-11 |
| Summons | effect reaches avatar, peer summons; local copy suppressed while a holder exists | FIXED 09-11 |
| NPC/creature aggression at players | engageCombat treats avatars as players | FIXED 09-11 |
| NPC retaliation when hit | actorAttacked treats avatar attacker as player | FIXED 09-11 |
| Being hit: damage, disease, paralysis | peer bars -> SelfStats; AvatarEffectsBatch -> SelfSpells/SelfActiveSpells | FIXED 09-11 |
| Being dispelled by an NPC | owner-applied records are tracked by instance on the avatar; one that vanishes before the owner removed it (Dispel, absorb) is reported back as a removal and the owner's engine drops it | FIXED 09-11 |
| PvP | server veto (pvp rules) + avatar hit veto on the peer; a summon's blow is vetoed when its master is another player's avatar | FIXED 09-11 (summons bypassed pvp-off) |
| Death | death edge flushed; respawn plugin; avatar rebuilt; puppet rebuilt on other screens | FIXED 09-10 |
| Activating another player's body (alive or dead) | refused: no blank dialogue on a friend, no loot window on a fallen one (that copy is per-screen and unbacked); player-to-player exchange is drop + pickup | FIXED 09-11 |
| Kill credit / GetDeadCount | ActorDeath tally shared | OK (attribution logs only) |
| Companions fight beside you | siding-with on the peer | OK |
| Resting refused mid-fight | holder relays combat state; puppet carries Combat package | FIXED 09-11 |
| Trap / scripted damage | trap effects with duration now mirror; zero-duration and MWScript writes lost | GAP (narrow) |

## 4. Character state

| Action | MP path | Status |
|---|---|---|
| hp/mp/ft | peer-authored while driving; client may raise (heal); magicka client both ways | FIXED 09-11 (free casting) |
| Attributes/skills/level, training, level-up | client diff -> doc -> AvatarState | OK |
| Skill use from cancelled swings | skill use runs before the Lua cancel | OK |
| Diseases (caught) | AvatarEffectsBatch -> doc.spells + owner | FIXED 09-11 |
| Vampirism / lycanthropy | spell list / appearance; werewolf form set on rebuilt bodies | FIXED 09-11 (looked human) |
| Bounty | live per session; shared crime = party record on every avatar | FIXED 09-11 (host hunted) |
| Faction rank/expulsion | routed like the journal | OK |

## 5. Inventory and world objects

| Action | MP path | Status |
|---|---|---|
| Pick up / two players race | ObjectTakeRequest first-wins, tombstone, refusal shown | OK |
| Loot in the last 2 s before a disconnect/kick | inventory snapshot is 2 s diffed; the acquisition ledger is a timing hint, not state; the rejoin restore never confiscates surplus, so the client's local copy wins on rejoin | OK (bounded loss window ≤ 2 s, by design) |
| Drop | ObjectSpawn, netId, refused reasons incl. cell_full | FIXED 09-10 (no cell_full line) |
| Containers, merchants' stock and gold | canonical on first open; gold deltas; 24 h gold restock; item restock from `origin` on cell reset | OK |
| Levelled item lists (containers, world) | container contents canonical on first open; a world-placed levelled item ref rolls per engine (rare, cosmetic) | OK |
| Item condition / charge / soul | per-field merge: charge client, condition raise client, soul peer | FIXED 09-11 |
| Repair / recharge / soul trap | see above | FIXED 09-11 |
| Quest items never deplete | container rule | OK |
| Theft (owned items in the world) | client-side crime detection; bounty relays; the take itself is a normal ObjectTakeRequest | OK |
| Pickpocket | the Container window on a live actor rides the live-container path (canonical on open, diff on close); the stolen item leaves the NPC on every engine; the detection roll stays the thief's client's | FIXED 09-11 (was: local to the thief; the mark kept it for everyone else) |
| Scripted enable/disable of refs | ObjectEnabled persisted | OK |
| Locks, lockpicking, script Lock/Unlock | lockWatch relay, persisted | OK |
| Trap disarm state | not in the cell doc | GAP (harmless while trap damage is discarded) |
| Cell resets | server sweep; clients handed restored truth; named runtime actors are dropped with the doc and removed on every engine (the peer re-rolls and re-names) | OK |
| Dynamic records (alchemy, enchant, spellmaking) | RecordsSync chunked; toNet/toLocal at every seam | OK |

## 6. NPC behaviour (the peer as holder)

| Behaviour | MP path | Status |
|---|---|---|
| Wander/idle AI, pathing | peer engine; poses 10 Hz relayed; puppets steer | OK |
| Posture while fighting | actor pose bits 4/5 | FIXED 09-11 |
| Seeing a friend swing | the pose stream's use bit: its release plays the weapon's attack animation on the puppet (animation only -- a real `use` would run this engine's hit chain on the local player) | FIXED 09-11 (was: a friend fought as a statue with a weapon out) |
| Greetings, idle voice | puppets greet with AI off | FIXED 09-11 |
| Dialogue (one at a time) | dialogue lock; refusal names the holder | OK |
| Persuasion (bribe/taunt/admire) | lock holder relays disposition | FIXED 09-11 |
| Taunt -> fight; resist arrest -> fight | lock holder claims combat; holder starts it | FIXED 09-11 |
| Follow / Escort (recruit, escort quests) | companion.lua -> ActorAI claim -> holder; replayed to a new peer; carried through doors | FIXED 09-10/11 |
| Dialogue-started AiTravel | companion.lua reports; lock holder claim | FIXED 09-11 |
| Dialogue-started AiWander / AiActivate | not relayed; the holder's copy keeps its own package (cosmetic: an NPC told to stand still by a dialogue keeps wandering elsewhere) | OK (cosmetic) |
| Guards: crime pursuit, arrest dialogue | registry bounty; AiPursue reaches; PlayerArrest to owner | FIXED 09-11 |
| Assault / murder as crimes | commitCrime/actorKilled accept avatars; PlayerCrime to owner | FIXED 09-11 |
| Death, loot, corpse | ActorDeath, corpse container canonical | OK |
| Content-placed NPCs/creatures | content RefNum, addressable everywhere | OK |
| Runtime-spawned actors (levelled-list creatures, PlaceAtPC/PlaceAtMe, script spawns) | the holder names each one through the object-sync path (actor=true); clients build it from the record and puppet it; the actor stream and events address it by net id (contentFile -2 on the wire); clients suppress their own rolls/spawns once any holder is known | FIXED 09-11 (engine + protocol). Live: the native peer against retail data named `scrib`, `kwama forager`, `scrib` in `-2,-7` within 60 ms of its grant, no drops; the client half is proven by s107 under the native-peer harness: two browser clients built the same three named creatures with matching net ids |
| Replayed one-shot quest encounters | spawned on the peer beside the avatar | FIXED 09-11 |

## 7. Quests and scripts

| Mechanism | MP path | Status |
|---|---|---|
| Journal | shared per instance; guests borrow the host's | OK |
| Topics learned | shared with the journal | OK |
| Globals (quest gates) | peer's write wins within the driving window; dialogue-result names client-owned | OK |
| Member variables on cell scripts | MemberVarUpdate relay | OK |
| Faction standing, bounty | routed to the campaign | OK |
| OnDeath / GetDeadCount | shared tally | OK |
| Scripted PlaceAt / PositionCell of NPCs | see runtime-spawned actors | GAP |
| Scripted AddItem/RemoveItem on NPCs | runs on every engine identically (deterministic) | OK (by construction) |
| Scripted Disable/SetDelete of a named runtime actor | holder sees it gone -> ObjectDelete by net id; holder loss purges the cell's named actors | FIXED 09-11 |
| Scripted PositionCell/SetPos of an NPC | runs on every engine; holder's poses/ActorCellChange win | OK |
| ForceGreeting | client-side dialogue, no lock taken | OK (two players may both be forced; harmless) |
| Companion share (follower inventory) | the Companion window is watched like Barter: canonical on open, one diff on close, applied into the live actor's inventory on every engine (the peer's copy fights with it) | FIXED 09-11 (was: local to the giver's screen) |
| StartScript/StopScript | runs per engine; globals reconcile | OK |

## 8. World

| Mechanism | MP path | Status |
|---|---|---|
| Clock, time scale, rest/wait | server clock; rest policy (owner/anyone/off); refusals told | OK |
| Weather | WorldWeather authority | OK |
| Map exploration | shared when enabled | OK |

## 9. Hardening (security / performance)

| Concern | Where | Status |
|---|---|---|
| Forged peer-only events (AvatarStats/ItemStates/Effects, PlayerArrest/Crime) | world-peer-only gates, tested | OK |
| Non-holder actor claims (follow/escort/travel/combat/disposition) | bounded to self / lock holder; follower cap 8 | OK |
| Client effect floods | PlayerActiveSpells budget 40 ops / 5 s | OK |
| LSER node ceiling | RecordsSync chunked; cell frame caps | OK |
| Per-IP cap for households | default 8; IP_CAP transient | FIXED 09-11 |
| Report spam | per reporter+target cooldown | FIXED 09-10 |
