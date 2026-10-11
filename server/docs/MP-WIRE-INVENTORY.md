# Client to server wire inventory

Generated from the client Lua (`mp.sendEvent('Name', ...)`), the server routing (`src/`), and the server tests that send the event (`test/`). Counts are a grep, not a proof: `tests_sending` counts test files that send the name, not assertions on the result. A row with `tests_sending=0` or `routed=0` is a gap.

| Message | Routed in server | Test files that send it |
|---|---|---|
| ActorAI | 1 | 4 |
| ActorCellChange | 1 | 1 |
| ActorDeath | 1 | 3 |
| ActorDisposition | 1 | 2 |
| ActorEffects | 1 | 1 |
| ActorEquip | 1 | 1 |
| ActorRevive | 1 | 1 |
| ActorSay | 1 | 1 |
| ActorSnapshot | 2 | 1 |
| ActorStatsDynamic | 1 | 1 |
| AvatarEffectsBatch | 1 | 1 |
| AvatarItemStatesBatch | 1 | 1 |
| AvatarSkillUse | 1 | 1 |
| AvatarStatsBatch | 1 | 1 |
| ChargenComplete | 7 | 5 |
| ChatSend | 2 | 25 |
| CombatCast | 1 | 2 |
| CombatHit | 3 | 2 |
| CombatSpellHit | 3 | 1 |
| ContainerOpRequest | 1 | 4 |
| ContainerOpen | 1 | 6 |
| CrimeUpdate | 3 | 4 |
| DialogueLock | 2 | 5 |
| FactionUpdate | 1 | 2 |
| GlobalScriptsUpdate | 1 | 1 |
| GlobalVarUpdate | 2 | 3 |
| JournalEntry | 1 | 3 |
| MemberVarUpdate | 2 | 1 |
| ObjectDelete | 1 | 2 |
| ObjectLock | 1 | 1 |
| ObjectSpawnRequest | 3 | 10 |
| ObjectTakeRequest | 1 | 2 |
| PlayerActiveSpells | 2 | 2 |
| PlayerArrest | 1 | 2 |
| PlayerAttributes | 1 | 5 |
| PlayerCellChange | 6 | 1 |
| PlayerCrime | 1 | 1 |
| PlayerDeath | 2 | 4 |
| PlayerEquipment | 1 | 1 |
| PlayerInventory | 2 | 9 |
| PlayerItemAcquired | 3 | 2 |
| PlayerLeaving | 2 | 2 |
| PlayerLevel | 1 | 5 |
| PlayerMark | 1 | 1 |
| PlayerSkills | 1 | 3 |
| PlayerSpellbook | 1 | 4 |
| PlayerStatsDynamic | 2 | 4 |
| PlayerTalkedTo | 1 | 1 |
| RecordCreate | 2 | 2 |
| ResyncRequest | 1 | 6 |
| SetAvailability | 1 | 1 |
| SetWorldMode | 2 | 2 |
| TopicsLearned | 1 | 1 |
| WorldMapExplored | 1 | 1 |
| WorldRegionChange | 2 | 1 |
| WorldTimeRequest | 2 | 3 |
| WorldWeather | 2 | 1 |

Totals: 57 client to server messages; 0 unrouted; 0 with no test that sends them.
