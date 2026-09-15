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

## 0. Live evidence (native peer + two browser clients, retail data, 2026-09-11/12)

Full sweep on the rebuilt stack (2026-09-14, 108 scenarios): 105 PASS, 1 SKIP by design (s43 needs a GPU box), 0 FAIL -- the entire live suite green, including the whole drop-in flow (join,
guest loot/skills/journal, kick, refused-at-the-door, join-from-launcher, leader-level scaling, and a helper
healing a friend). The harness now swallows a stray CDP timeout at process level, so one navigating page can no
longer abort the run (a sweep died at s60b before that fix).
s57 awaits its rewrite), 2 FAIL (s42, s51) that both PASS on a clean rerun -- they ran while 40 dead scenarios' gateway
worlds and 14 of their peers were still alive (the harness SIGTERMed the gateway and SIGKILLed it mid-drain; worlds
do not exit on TERM, peers ignore it). Fixed the same night: the gateway runs in its own process group and the harness
kills the group. Effective: 98/98 that can run here.

FULL SWEEP 2026-09-12 05:26-07:40 on the engine baked from `5a0b9e3d`: 85 scenarios, 80 PASS,
3 SKIP by design (s43 host-load, s57, s63), 2 that failed in the sweep and pass alone (s42 crowded
cell under host load, s47 a gateway port collision). An earlier sweep the same night found and
fixed the rejoin-hold drag-back (s110) and two mirror races (s97/s100).

Run locally under `wasm-build/Dockerfile.harness-peer` with `OMW_SIM_PEER_BIN` set, on the
engine built from the same tree. PASS: s22 (death seen by the other player), s67 (avatar
swing), s77 (death -> respawn), s31 (shared container), s32 (doors), s58 (melee forward),
s59 (spell forward), s78 (crime pursuit), s79 (pickup race), s51 (NPC combat), s107 (runtime
creatures named once, built on both clients), s108 (trade both ways, one inventory at every
step), s109 (two players kill a peer-named wild creature -- FAILED first: every client rolled
a private ghost of each creature near the spawn before the spawn gate was down; fixed the
same day, engine default + Lua), s110 (a provoked wild creature's blows reach the player: peer
avatar damage -> SelfStats, no hit injection on the victim), s111 (two players loot the same kill:
canonical corpse, one take wins, by net id), s112 (a client heal sticks against the peer's bars --
FAILED twice first: the heal was reset before it was reported, then the avatar's stat write
threw in a pcall), s113 (a cast costs magicka and a potion restores it -- FAILED first: an echoed
report refilled the bar), s114 (a recruited NPC follows the player on the OTHER player's
screen -- FAILED first: companion.lua was never on an NPC), s115 (a conjurer's Summon Scamp
stands on both screens as one net actor: owner active spell -> avatar -> peer summons -> named),
s116 (a spell at another player: parked on the puppet, forwarded, applied to the avatar, bars
back), s117 (a companion comes indoors with you through a load door and your friend finds
you both there), s118 (a fight INDOORS: the peer holds the room as an anchor -- the first scenario
to run the server's own peer lifecycle, `managedPeer`; a hand-spawned peer never anchors a room), s119 (the peer is killed; the server notices,
restarts it, re-anchors the cell and a fight resolves under the new one), s120 (two players two
cells apart: one peer, two anchors, both fights resolve), s121 (a level-up's new maximum reaches the
avatar and a heal fills the new pool -- FAILED first: the base was thrown away while the peer ruled), s122 (a
far teleport STICKS -- FAILED 3/3 first: a state sample from before the jump, delivered after the
region-load stall, dragged the player back to where they left; every fast travel, Recall and door had
this window), s123 (an escort quest: the NPC leads ~450 units, waits for its charge, continues;
arrives on both screens), s124 ("AITravel" from a dialogue: the NPC walks 2900 units to where it was
sent, on both screens), s125 (theft: an owned bottle taken in the shop with the owner there;
the granted take runs the engine's ActionTake, the bounty rises, and the party shares it), s126 (the guard catches you: the peer's guard
reaches the avatar, PlayerArrest travels, the arrest dialogue opens on the wanted player's client), s127 (a GUEST takes their loot home: joins a
friend's world with retail data, picks up what the host dropped, is sent home when the host closes up, and
still has it), s128 (a guest FIGHTS in a friend's world: through the real door, the host's gateway
world spawns its own peer -- managedPeer now reaches gateway worlds via the shared config -- and host
and guest kill the same NPC together), s129 (the host's TAB CLOSES: the guest plays on through
the 90 s grace, then is sent home as owner_left and lands joined in their own world), s130 (the host is INDOORS when the friend joins: the guest lands
in the same room beside them, and the room is simulated for both), s137 (REST REFUSED MID-FIGHT with the peer's
creature: the engine's own canRest verdict flips to enemies-nearby on the owner's screen), s138 (an ARCHER kills the peer's
creature with real arrows from the avatar -- see §3 for the three faults it found), s140 (the host goes SOLO while the friend
is mid-reboot into their world: the refused dial goes home with a reason instead of the sign-in-again modal), s141 (the host
SENDS ONE GUEST HOME without blocking: told, dropped, the other guest stays, the friendship stands and they come back on the
next invite; the guest's UI knew whose world it was visiting), s142 (JOIN FROM THE LAUNCHER: a cold boot that dials the
friend's world directly lands beside the host as a guest, and the host going solo still sends them home), s143 (the world
rolls its levelled creatures at the HOST's level beside a level-1 helper far from the host), s131 (a guest DIES while visiting: respawns at the host world's
respawn point, health back, still a guest the host can see, not sent home), s132 (what a guest LEARNS comes home --
FAILED first: the host world flushed the trained skill to the shared players.db, then the guest's home world wrote its
pre-visit copy back over it on the return; the logout release in connection.ts had never fired on an ordinary
disconnect (its roster guard still saw the leaving session itself), fixed the same day, PASS), s133 (the leader walks
into a building and the friend follows through the same door: both in the same interior, each seeing the other, the
room held by the world peer), s134 (the guest's TAB DIES mid-visit: the loot taken before the drop is on their character
when they boot at home, they rejoin the friend -- still party -- as a guest with it in hand, and the host sees them
back; three worlds' caches of one character, in order), s135 (the host's CLOCK is the host's: `timeSkip` now defaults to
"owner", a guest's rest is refused and told, the host's clock stays, the guest's engine-advanced clock is handed back within
seconds instead of a shift ahead until the next periodic WorldTime, and the host's rest still moves time for both), s136 (a PARTY OF THREE: the host and two friends through the real door,
three names on every screen, a guest's chat reaches the host and the other guest, the two guests trade with each other
inside the host's world, and both land home when the host closes up), s139 (the host BLOCKS a guest who is already
inside -- FAILED first: the friends list was checked only at the door, so a blocked guest stayed until the host went
solo and evicted everyone; now ending the friendship, from either side, sends that one guest home with the reason
"unfriended" and the other guest stays; fixed the same day, PASS), s95 (play with friends -- FAILED first: every
join refused not_open, fixed the same day), s100 (invite across worlds), s102 (owner goes
solo), s61 (dialogue lock), s72 (merchant purse), s03 (chat), s10 (movement puppets), s20
(identity), s21 (rejoin), s80 (resume), s81 (reconnect), s70 (time), s48/s56 (world switch),
s30 (objects), s50 (combat), s52 (pvp off), s60/s60b (journal), s62 (quest vars), s71
(records), s73/s75 (topics), s69 (peer outage). s66 (PvP damage lands on the driving victim's avatar and the peer's bars reach the owner --
re-armed 09-11, PASS), s63 (rewritten on the friend path 09-12: a guest borrows the host's
journal, their deed lands in the host's log, and their own campaign is untouched at home -- PASS).
SKIP by design: s40/s42 (host-load guard). Anything below marked OK without a
scenario is a code trace only.

## 1. Session

| Action | MP path | Status |
|---|---|---|
| Sign in (password / SSO ticket) | launcher -> gateway -> world server SessionHello/Login | OK |
| Create character, chargen | private world `priv-<user>-<char>`; chargen sanctuary keeps the peer out of the cell | OK |
| First boot: sign in, upload your Morrowind, enter your world | launcher -> cloud/MP sign-in (one SSO) -> index.html locker mount -> upload wizard (attest, presigned PUT per file, verify) -> world re-opened (POST /worlds, create-or-join) -> engine dials. The world is opened BEFORE the upload and a never-joined world is discarded after 15 min, so the reseat is what makes a long first upload survivable | FIXED 09-14 (c00a6ea0 reseat; 03dfc403 unreadable file no longer strands the wizard; 9483b2bf cloud boot read a scrubbed fragment; directory preflight lacked PUT for filesystem lockers). Live: driven in the browser against a local gateway with the real Data Files plus a fabricated media tree (Sound/ Music/ Video/ Splash/ Fonts/, valid magics) -- world dir removed, wizard run, core files + four loose-media folders + the voice pack uploaded and server-verified (`locker.media_pack_verified`), `world.started` before the dial, engine booted and unpacked the voices. Prod: the two 09-14 sign-in failures and the 09-11 abandoned wizard were reconstructed from the edge log (see memory prod-signin-tracing); the page's own report now reaches the gateway (/clientlog routed + answered, levels inferred) |
| Resume after disconnect | resume ticket, same character, world snapshot re-sent; IP_CAP retried | FIXED 09-11 (IP_CAP was terminal RATE) |
| Rejoin after dying and closing the tab | doc has hp 0 (death flushes); restored at 10% health on both the client and the peer's avatar, where they fell | FIXED 09-11 (was: die again on arrival, second "has fallen", respawn loop) |
| Join a friend FROM THE LAUNCHER | GET /auth/friends-playing (locker Bearer): friends whose world is open to friends and occupied, the world they are IN; the character screen shows "Friends playing now -- Join as <last played>" and bootGame dials that world with our own as mphome. One boot instead of two full reloads | ADDED 09-13. Live: s142 (cold boot straight into the friend's world, lands beside the host, way home holds) |
| Join a friend (party) | joinFriend -> ownerWorld (occupied, LIVE mode from the world's /status) -> switch -> mayJoinWorld -> chargen gate -> guestSpawn beside owner | FIXED 09-11 (the 09-10 pre-switch mode check read a mode fixed at process start, so every join was refused as not_open; caught live by s95) |
| Owner flips party -> private | WorldClosed, 5 s grace, guests switched home | OK. Live: s102 |
| Owner's tab closes (no Solo flip) | owner_left, 90 s grace while guests keep playing, then owner_gone -> WorldClosed('owner_left') -> guests home | OK. Live: s129 |
| Leave / kick / ban | terminal codes; SUPERSEDED for a second tab | OK |
| Save / Load / quicksave | refused at StateManager while Joined; menu items hidden | OK |
| Return to your own world after it was reaped | revive-on-dial with the owner (still private); the auth ladder mints a fresh ticket when the parked resume token is gone with the reaped process | OK. Live: s57 (go help a friend, own world reaps, dial home revives it) |

## 2. Movement and travel

| Action | MP path | Status |
|---|---|---|
| Walk/run/sneak/jump | input frame 30 Hz -> avatar on peer -> authoritative pose back; reconciliation (per frame, see §3) | OK |
| Stance (weapon/spell drawn) | input bits 4-5 -> avatar; pose bit 4 -> puppets | FIXED 09-10 (avatar never drew) |
| Look pitch | input pitch -> avatar pitchChange | FIXED 09-10 |
| Doors, load doors | client cell change -> PlayerCellChange -> avatar follow-teleport; door state relayed | OK |
| Silt strider / boat / guild guide | cell change + time skip request + fare from shared purse | OK |
| Mark/Recall/Intervention/scripted PositionCell | cell change; far-travel limiter is a signal only | OK |
| Levitate / Water Walk / Slowfall / Fortify Speed | PlayerActiveSpells -> avatar | FIXED 09-11 |
| Swimming, drowning, falling | avatar physics; peer-authored bars | OK |
| Followers through doors | peer moves followers with the avatar; exterior key -> teleport arg | FIXED 09-10. Live: s117 |

## 3. Combat

| Action | MP path | Status |
|---|---|---|
| Melee vs NPC | client swing cancelled; avatar swings on peer (stance, use bit) WITH THE PLAYER'S WEAPON: the equipment push (MP_Equip) was handled only by puppet.lua, which the peer never attaches, so every avatar fought bare-handed; avatar.lua now applies it | FIXED 09-10 (swing), FIXED 09-13 (weapon in hand). Live: s138 |
| Ranged (the avatar looses) | the owner's stance/yaw/pitch/use ride the input tier; the avatar draws and releases on the peer, the arrow collides with the creature it holds, projectileHit rolls and damages natively. Three faults found on the way: no weapon in the avatar's hands (above), a quiver bound to a fabricated single arrow (equipment re-pushed after the doc reconciles; largest stack wins), and a held draw released at MINIMUM strength whenever the input stream stuttered (avatar.lua kept `use` only for the 0.35 s motion hold; a client at a few fps sends frames further apart) -- 1.6 damage per long-bow arrow became 18 | FIXED 09-13. Live: s138 (a stung scrib charges the archer; two arrows kill it) |
| Levelled lists scale to THE LEADER | the peer rolled every levelled creature against the NEAREST avatar, so a level-1 helper made the host's world level-1 wherever they stood. WorldMode now carries the owner's id; the peer sets mp.setPartyLevel from the owner's avatar doc, and mwmechanics/actors.cpp nearestAvatarLevel answers that everywhere (nearest avatar only when no owner is known: standalone). Each roll is logged on the peer ("levelled spawn X rolled at level N (party leader)") | FIXED 09-13. Live: s143 |
| Reconciliation under load | one correction per FRAME toward the newest peer pose; per-SAMPLE corrections multiplied the gain on a slow client into a runaway oscillation (26 -> 46 -> 81 -> 300 units after one swing, then a hard snap) | FIXED 09-13 |
| Baseline gate after a reconnect / direct boot | identity.reset() shut the gate on every tick outside Joined and only the first chargenstate flip reopened it: a new character's inventory, skills and level stopped uploading after any blip (and its mirror kept saying ready) | FIXED 09-13 |
| Ranged | avatar fires; ammo reconciled via inventory; a missed arrow (and any runtime item the world creates near an avatar: death drops, scripted items) is named by the peer as a world placement, so it can be picked up on every screen | FIXED 09-11 (was: peer-local, arrows unrecoverable) |
| Blocking, armor, difficulty | peer engine, avatar treated as player for scaling | OK |
| Heal / restore a FRIEND | RestoreHealth/Magicka/Fatigue on another player's puppet used to apply locally and revert, and the forward was gated behind PvP (off by default): a drop-in helper could not heal anyone. spelleffects.cpp now diverts beneficial restores to the owner like damage, tagged beneficial so combat.lua and the server let it cross the PvP veto (harm only); it lands on the wounded player's avatar | ADDED 09-14. Live: s144 (PvP off; a helper tops a wounded friend from 35 to 95) |
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
| Resting refused mid-fight | holder relays combat state; puppet carries Combat package; the engine's own verdict (World::canRest bit 4) is what the client reads | FIXED 09-11. Live: s137 (the peer's creature engages you; your engine says enemies nearby) |
| Trap / scripted damage | trap effects with duration now mirror; zero-duration and MWScript writes lost | GAP (narrow) |

## 4. Character state

| Action | MP path | Status |
|---|---|---|
| hp/mp/ft | peer-authored while driving; client may raise (heal); magicka client both ways. identity.lua measures the LOCAL change per frame and claims only the changed bars on top of the peer's last report (an echoed snapshot used to undo bites and refill casts; a heal was reset before the 4 Hz diff saw it) | FIXED 09-11 twice. Live: s112 (heal sticks), s113 (cast costs, potion restores) |
| Attributes/skills/level, training, level-up | client diff -> doc -> AvatarState -> avatar.lua mpAvatarStats; a level-up's new MAXIMUM health/magicka/fatigue is claimed by identity.lua and accepted server-side as a plausible base step (<=60, one per stat per 10 s), forwarded with the current preserved (was dropped while the peer ruled: the old pool stayed on the body that fights) (Self context: every stat setter is Self-gated, the global-script write threw inside a pcall and the avatar stayed a level-1 template with a template health pool) | FIXED 09-11 |
| Skill use from cancelled swings | skill use runs before the Lua cancel | OK |
| Diseases (caught) | AvatarEffectsBatch -> doc.spells + owner | FIXED 09-11 |
| Vampirism / lycanthropy | spell list / appearance; werewolf form set on rebuilt bodies | FIXED 09-11 (looked human) |
| Bounty | live per session; shared crime = party record on every avatar | FIXED 09-11 (host hunted) |
| Faction rank/expulsion | routed like the journal | OK |
| Attribute DAMAGE (Damage/Restore Attribute) | the attribute map carried .base only, so a curse was a relog away from cured; "<id>_damage" now rides in the same map, applied as damage by the restore and the avatar | FIXED 09-15. Live: s159 |
| What OTHERS see of your effects (Invisibility, Chameleon, Light) | the effect op went to the peer alone; every client now gets it and keeps the visible part for the puppet; the server replays each player's live set to a late joiner | FIXED 09-15. Live: s156. Unit: avatarstats.test.ts |
| Posture on other screens (run/sneak/jump/weapon/spell) | the avatar stream dropped the flag bits; forwarded, puppets mirror | FIXED 09-14. Live: s145 |
| Potions and scrolls on a peer-ruled body | UseItem heals the client; MP_AvatarRestore mirrors the raise; the scroll is consumed | ADDED 09-14. Live: s146 |
| Two potions of one kind | the peer removed BY RECORD so the first expiry cancelled the second; one instance per removal now | FIXED 09-14. Live: s152 |
| Over-encumbered on every screen | the avatar carries the declared pack, so both engines apply the weight | ADDED 09-14. Live: s151 |
| Sleep heals | mp.restHours (the wait dialog's exact loop); the raise mirrors like a potion | ADDED 09-14. Live: s150 (PASS run14; run15 regression under investigation) |
| Levitate / torch / fall damage / drowning on the ruling body | levitation climbs (look up + walk); the avatar dispels; s147 fall and s149 drowning still OPEN: the peer's avatar reports breath=-1 forever (updateDrowning never runs for it; probe now prints range/AI gates) | OPEN 09-15. Live: s147 s148 s149 |
| A player-made record (potion, enchanted ring) after a relog | the inventory declaration went out raw; mapped through the registry now, and the restore waits for RecordsSync | FIXED 09-14. Live: s153 |
| Chargen sanctuary cells | the peer spawned a frozen avatar in the Census office and pinned the new character to the deck; no avatar there now | FIXED 09-14. Live: s155 |

## 5. Inventory and world objects

| Action | MP path | Status |
|---|---|---|
| Pick up / two players race | ObjectTakeRequest first-wins, tombstone, refusal shown | OK. Live: s79 |
| Loot in the last 2 s before a disconnect/kick | inventory snapshot is 2 s diffed; the acquisition ledger is a timing hint, not state; the rejoin restore never confiscates surplus, so the client's local copy wins on rejoin | OK (bounded loss window ≤ 2 s, by design) |
| Drop | ObjectSpawn, netId, refused reasons incl. cell_full | FIXED 09-10 (no cell_full line) |
| Containers, merchants' stock and gold | canonical on first open; gold deltas; 24 h gold restock; item restock from `origin` on cell reset | OK |
| Levelled item lists (containers, world) | container contents canonical on first open; a world-placed levelled item ref rolls per engine (rare, cosmetic) | OK |
| Item condition / charge / soul | per-field merge: charge client, condition raise client, soul peer | FIXED 09-11 |
| Repair / recharge / soul trap | see above | FIXED 09-11 |
| Quest items never deplete | container rule | OK |
| Quest item carried out by a GUEST | loot writes to the guest's charId (by design: guests keep loot, quests stay with the host), so a guest who pockets the host's Dwemer puzzle box and goes home takes the host's quest with it; nothing flags it, nothing asks. Remedy today: the host asks the friend to drop it before leaving | GAP (design; a "leave quest loot behind" prompt on WorldClosed is the smallest fix) |
| Theft (owned items in the world) | client-side crime detection; bounty relays; the take itself is a normal ObjectTakeRequest | OK. Live: s125 |
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
| Follow / Escort (recruit, escort quests) | companion.lua -> ActorAI claim -> holder; replayed to a new peer; carried through doors. companion.lua was listed on two lines (NPC, CREATURE) and the engine keeps the last: NO NPC carried it until 09-12 -- every claim below was creature-only | FIXED 09-10/11, REALLY FIXED 09-12. Live: s114 |
| Dialogue-started AiTravel | companion.lua reports; lock holder claim (see the two-lines note above: dead on NPCs until 09-12) | FIXED 09-11/12. Live: s124 (travel), s123 (escort) |
| Dialogue-started AiWander / AiActivate | not relayed; the holder's copy keeps its own package (cosmetic: an NPC told to stand still by a dialogue keeps wandering elsewhere) | OK (cosmetic) |
| Guards: crime pursuit, arrest dialogue | registry bounty; AiPursue reaches; PlayerArrest to owner | FIXED 09-11. Live: s78 (pursuit), s126 (arrest dialogue opens) |
| Assault / murder as crimes | commitCrime/actorKilled accept avatars; PlayerCrime to owner | FIXED 09-11 |
| Death, loot, corpse | ActorDeath, corpse container canonical | OK. Live: s111 (loot the kill) |
| Content-placed NPCs/creatures | content RefNum, addressable everywhere | OK |
| Runtime-spawned actors (levelled-list creatures, PlaceAtPC/PlaceAtMe, script spawns) | the holder names each one through the object-sync path (actor=true); clients build it from the record and puppet it; the actor stream and events address it by net id (contentFile -2 on the wire); clients suppress their own rolls/spawns once any holder is known | FIXED 09-11 (engine + protocol). Live: the native peer against retail data named `scrib`, `kwama forager`, `scrib` in `-2,-7` within 60 ms of its grant, no drops; the client half is proven by s107 under the native-peer harness: two browser clients built the same three named creatures with matching net ids |
| Replayed one-shot quest encounters | spawned on the peer beside the avatar | FIXED 09-11 |

## 7. Quests and scripts

| Mechanism | MP path | Status |
|---|---|---|
| Journal | shared per instance; guests borrow the host's | OK. Live: s63 (friend path, retail) |
| Quest globals on the SIMULATOR and a GUEST | both were seeded from their own doc (the peer's empty one, the guest's home campaign) and a human's write never reached the peer live; seeded from the campaign doc, human writes relayed to the peer | FIXED 09-15. Unit: questpeer.test.ts |
| A lock a SCRIPT sets | only watched for 4 s after an activation; the 1 Hz cell poll carries lock state now | FIXED 09-15. Live: s158 |
| Guest loot goes home | inventory diffs write to the GUEST's charId; the home world restores it | Live: s127 (a vanilla item) -- FAILED first, twice, for real: (1) the first dial went out before the cell load and a slow retail load killed the session as BAD_PROTO; (2) the reboot into the friend's world wrote start=Seyda+Neen and the boot reader did not decode the '+', so the engine died at new game and the page sat at the loading screen forever. GAP: a record MINTED in the host's world (an enchanted item, a potion the host brewed) is a per-world record id; the guest's home world has no definition for it and the restore drops it silently. Fix needs record definitions to travel with the character doc |
| Topics learned | shared with the journal | OK |
| Globals (quest gates) | peer's write wins within the driving window; dialogue-result names client-owned | OK |
| Member variables on cell scripts | MemberVarUpdate relay | OK |
| Faction standing, bounty | routed to the campaign | OK |
| Host sends a guest home (kick) | WorldKick (owner/admin only) -> closeToGuest('kicked'): that one guest gets WorldClosed + the 5 s drop, the friendship and the open door stand (they can come back), the other guests stay. UI: "send home" on a guest's row for the host; the guest's panel says "Visiting <host>'s world" with a Leave button (WorldMode now carries the host's character name and isOwner) | ADDED 09-13. Live: s141 |
| A kicked guest STAYS out; the host's invite lets them back | kickedUntil (10 min) on the world, cleared by invited(); the refused dial says "you were sent home" and goes home with the reason across the reload | FIXED 09-14. Live: s141 (rewritten). Unit: flipworld.test.ts |
| A returning guest lands beside the host | the rejoin restore re-asserted the stored far spot for 8 s over the invite teleport; the invite releases the hold | FIXED 09-14. Live: s154 |
| The owner's grace vs an empty world | onWorldEmpty respected the 90 s grace; newcomers refused only while the owner is absent in grace | FIXED 09-14. Unit: ownerleft.test.ts |
| One character in TWO worlds | two processes flushed one doc last-writer-wins; the presence row arbitrates and the older session is SUPERSEDED on the next heartbeat | FIXED 09-15. Unit: onecharacteroneworld.test.ts |
| Delete a character while it is a GUEST elsewhere | the guest's world wrote the doc back at its next flush; erase leaves a tombstone every process honours | FIXED 09-15. Unit: staledoc.test.ts |
| Rolling restart after a mode flip | the observed party mode became the boot mode (chargen gate, no revert, bots public); restarts use the boot mode | FIXED 09-15. Unit: worlds.test.ts |
| Drop, then disconnect before the inventory diff | the doc still held the dropped item; the drop debits the doc in the same op | FIXED 09-15. Unit: provenance.test.ts |
| An item dropped across a cell border | cell state went out for the entered cell only; entry yields the 3x3 | FIXED 09-15. Unit: holderhears.test.ts |
| Host blocks / unfriends a guest mid-session | Social.friendshipEnded -> closeToGuest: WorldClosed(unfriended) + kick after 5 s; the other guests stay; either side ending it sends the GUEST home, the owner never moves | FIXED 09-13 (was: door-only check, the blocked guest stayed). Live: s139 |
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
| Clock, time scale, rest/wait | server clock; rest policy defaults to OWNER (the host leads; standalone stacks have no owner and admit anyone); refusals told, and the refused player's adopted hours are handed back at once | FIXED 09-12 (default was anyone: a guest could fast-forward the host's game). Live: s135, s70 |
| Weather | WorldWeather authority | OK |
| Map exploration | shared when enabled | OK |

## 9. Hardening (security / performance)

| Concern | Where | Status |
|---|---|---|
| Forged peer-only events (AvatarStats/ItemStates/Effects, PlayerArrest/Crime) | world-peer-only gates, tested | OK |
| Non-holder actor claims (follow/escort/travel/combat/disposition) | bounded to self / lock holder; follower cap 8 | OK |
| A companion across the player's RELOG | the claim named a session id and the peer dropped the follow when it left; claims carry the character and are rebound on the returning session's first cell change | FIXED 09-15. Unit: actor.test.ts |
| The dead stay dead across a PEER restart | the client replayed deaths by the wire key against a table keyed by object id (matched nothing) and the holder never got the cell record; both fixed, the holder kills recorded corpses for real | FIXED 09-15. Live: s157 |
| The holder HEARS its far cells (doors, locks, placed objects) | relays were gated on the peer's avatar neighbourhood; a holder hears every relay for a cell it holds and asks for the record at grant | FIXED 09-15. Unit: holderhears.test.ts |
| Scripted enable/disable ping-pong | two engines disagreeing on a global flipped a ref forever; the peer's write wins for the driving window | FIXED 09-15. Unit: holderhears.test.ts |
| Client effect floods | PlayerActiveSpells budget 40 ops / 5 s | OK |
| LSER node ceiling | RecordsSync chunked; cell frame caps | OK |
| Per-IP cap for households | default 8; IP_CAP transient | FIXED 09-11 |
| Report spam | per reporter+target cooldown | FIXED 09-10 |
