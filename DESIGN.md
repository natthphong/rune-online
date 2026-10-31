# Runebound Legacy — design direction

RO-like 2.5D web MMO (internal id `ro`: folder, DB schema, stack `game-ro`). **Original IP**: no Ragnarok names, sprites, maps, music or item/monster names
(Gravity owns them). Borrow the *feel* and the *systems*, never the content.

## Why players stay for months (the RO loop, kept)
1. **Click-to-move, click-to-attack, 2.5D**: rotatable 3D maps + painted 2D sprite characters and monsters with
   frame animation in 8 directions (body per job, dyed hair, gear layers) — the RO look. Readable, cozy, nostalgic.
0. **Setting: a 100-floor tower.** Each floor = rest town + hunting fields + dungeon + 2 bosses (dungeon boss + floor
   guardian); floors unlock by level; clearing floor 100 opens quests outside the tower. Build floor 1 to "finished"
   quality first, then template it per floor.
2. **Job tree with a real choice at each tier**: Novice → 6 first jobs → 2 advanced each. Stat points
   (STR/AGI/VIT/INT/DEX/LUK) + skill points = endless "build" theorycrafting.
3. **Card system**: every monster has a very rare card (≈0.01–0.05%) that slots into gear and changes builds.
   It's the main driver of long-term grinding and of the player market.
4. **Player economy**: vending (sit and sell in town), trading, zeny sinks (refine with break chance).
5. **Social**: parties with EXP share, guilds with emblem, chat bubbles, emotes, a crowded town square.
6. **Scheduled spectacle**: field/MVP bosses on respawn timers (server-wide announcement + first-hit/MVP reward),
   weekly guild castle siege (the "wow" moment).

## Our twist (what makes it new, not a clone)
- **Living world events** instead of static fields: a map's state changes on a timer (blood moon = elite spawns,
  harvest festival = bonus drops) announced server-wide.
- **Short sessions also count**: 10-minute "rift" instances for 1–3 players with a daily reward, so people
  without 4 hours still progress.
- **No voice acting** (owner's call, 2026-10-21): sound effects only.

## Floor 1 — Chapter 1 "The Verdant Floor"
The first Main quest chain (quests 1001-1014 in `shared/content/quest_db.ts`, NPC scripts in `shared/content/f1/`, ids and spots
in `f1/chapter1.ts`). Every step keeps a next step on screen: the tracker shows it tagged `[Main]`, a "?" (or "!" for a new
offer) sits over the NPC the step needs, a tracker click auto-walks there and the dialog opens on arrival.

| # | Quest | Who / where | What the player does | Teaches |
|---|---|---|---|---|
| 1001 | Bloom Patrol | Guide Lio, Hearthmoor plaza (Puddleblooms on the Verdant Plains) | defeat 5 Puddleblooms | fighting, the tracker |
| 1002 | Gel Beads for the Plaza | Lio | bring 10 Gel Beads (quest-only drops while held) | loot, collect quests |
| 1003 | A Merchant's Thanks | Mira, plaza | talk to Mira: she gives a Hat | talking to NPCs |
| 1004 | Dressed for the Climb | Mira | wear the Hat (isequipped), show her | equipping (Alt+E) |
| 1005 | Tonics for the Watch | Mira (town) -> Ranger Vessa, watch post on the Verdant Plains | deliver the Supply Crate | deliveries |
| 1006 | Know Your Strength | Vessa | spend status points (Alt+A) | stats |
| 1007 | Embers in the Grass | Vessa | defeat 6 Fire-element monsters (Element filter) + bring 4 Ember Coals (quest-only drop) | elements |
| 1008 | The Old Lookout | ruins west of the post | walk into the area (OnTouch): tracks, a bramble (-40% HP) | exploring |
| 1009 | A Trail of Crushed Herbs | Herbalist Tamsin, lake shore on the plains | talk to Tamsin | |
| 1010 | Rest and Recover | Tamsin | drink her Herb Tea from the shortcut bar, sit (Insert) until HP is full | hotkeys, sitting |
| 1011 | Pests in the Herb Beds | Tamsin | defeat 5 Tumhogs + 2 Loamblooms (two objectives) | |
| 1012 | News for Lio | Lio | report | |
| 1013 | The Warden's Gate | Warden Orrin, Hearthmoor's south gate | talk to Orrin | |
| 1014 | Proven Climber | Orrin | reach Base Lv 8 (the level gate), show him: chapter complete | |
| 1016 | A Warm Hearth | Orrin -> Hearthkeeper Bren, Hearthmoor plaza | talk to Bren (save point, fireside heal) | towns, save point |
| 1017 | The Fledgling's Last Lesson | Drillmaster Kessa, Hearthmoor | reach Job Lv 10 + Basic Training Lv 9 (Alt+S), report | skill points |
| 1015 | A Calling | Kessa -> the guild row, south-east of Hearthmoor's plaza | pass a master's test: first job | job change |

Mira talks before she trades (Buy / Sell / Cancel, then her floating shop via callshop). Rewards are tuned on the Renewal exp
tables: a new character reaches Job Lv 10 (the Fledgling's last) during the last hunt and ends at Base Lv 8+ in about 20-30
minutes (`shared/rules/content.test.ts` pacing test). Hearthmoor is the floor's rest town
(`f1_town01`, C08, `f1/town.ts`): Hearthkeeper Bren (save point; heal free for Novices, 50 z otherwise), Tilda's Sundries (tonics,
feathers, arrows), Garrow's Arms (weapons, armour), Drillmaster Kessa (the skill-point lesson before "A Calling"), Old Merrit (hints),
and side work 1101 Dinner Bell (Pella -> Garr, talk) and 1102 Sootcaps in the Woodpile (Garr, 6 Sootcaps on the field).

## Floor 1 — the hub world (W01)
Hearthmoor (`f1_town01`, 57x57, W01 r2: `shared/town.ts`, drawn by `client/src/town.ts`) is the centre: a walled town with a
square cobbled plaza and fountain, four streets to four gates (a signpost at each names the field behind it and its level band),
and the town's people at their buildings' doors: Bren's hearth chapel on the plaza (the save point), the Hearth & Kettle inn
(Pella), Tilda's Sundries and Garrow's Arms on the west / east streets, Garr's woodpile up the north street, Drillmaster Kessa's
training yard at the plaza's south-west corner, the six job masters in the guild hall's courtyard south-east of the plaza, Mira
at her market stall, Warden Orrin inside the south gate. New characters start in the plaza inside Guide Lio's greeting area.
Each gate warps to a field (`shared/maps.ts`; one Colyseus room per map). Each field has its own theme (ground, props,
sky / fog / light, music), level band and species, in separate zones (`shared/data/spawns.txt`; normals per field):

| Map | Field | Size | Theme | Lv | Species (normals) |
|---|---|---|---|---|---|
| `f1_field01` (west) | Verdant Plains | 104x104 | grassland, ponds; Vessa's post, the old lookout ruin, Tamsin's lake, standing stones in the far west | 1-5 | Puddlebloom 16, Sootcap 15, Tumhog 19, Silkwrap 18 (68); mini-boss Moonwhisker |
| `f1_field02` (east) | Whisperwood | 104x104 | broadleaf + conifer woods, two lakes | 5-10 | Dartwing 13, Leafgrub 12, Dappleegg 9, Loambloom 10, Cinderpaw 14, Needlewasp 6 (64); mini-boss Barkmatron |
| `f1_field03` (north) | Cragrise Highlands | 108x108 | rocky ground, crags, pines, two tarns | 10-15 | Whirlpup 14, Mistfin 10, Rootgrin 9, Mosspaw 10, Cragcub 11, Chirpjack 10, Scorchtail 10 (74); mini-boss Galeskimmer |
| `f1_field04` (south) | Sunken Mire | 108x108 | black water, dead trees, a causeway, the ruined keep, the drowned chapel | 15-20 | Dustcoil 13, Gravewalker 12, Bogcap 12, Fenworm 11, Mirewhelk 11, Stridebeak 1 (rare) (60); mini-boss Croakwarden |

W01 r2 grew the fields from 72-76 cells, keeping each field's old content anchored to its gate (migration 016 moved saved
positions with it). Species whose own art is still being drawn (Bogcap, Fenworm, Mirewhelk, Dappleegg) are drawn with a
look-alike's sheets until theirs land (`shared/mobart.ts`). The Mire's keep holds the stair down (54,66) into the floor's
dungeon (below); once Warden Orrin's seal quest is done the stairwell glows for that character. Warden Orrin keeps the south
gate: chapter 1's level gate is his word, the gate itself is an ordinary warp.

## Floor 1 — the dungeon: the Mirefall Catacombs (W03)
Three cave levels under the Sunken Mire's keep (`f1_dun01..03`, `shared/maps.ts` DUNGEON_THEMES, generated by `shared/map.ts generateDungeon`):
solid rock carved into ragged chambers on fixed cells (spawn zones stay put whatever the world seed) linked by winding three-cell corridors,
stalagmites, a still pool in some side caves, torches on the walls. Drawn dark: walls are high terrain whose tops fade to black, the ground
is lit only in the torches' pools (baked into the terrain shade), flickering flames (`client/src/torch.ts`), bones and pebbles on the floor,
black fog, music `dungeon` (`boss` while a living MVP is within 16 cells).

| Map | Level | Size | Lv | Species (chamber) | Stairs (warp -> arrival on the other side) |
|---|---|---|---|---|---|
| `f1_dun01` | B1 | 64x64 | 20-24 | Pilferbug (13,16)(13,44), Gravelpede (51,17)(31,31), Duskgnaw (50,45) | up (32,6) -> Mire (38,62); down (32,58) -> B2 (10,11) |
| `f1_dun02` | B2 | 68x68 | 23-27 | Duskgnaw (34,12)(14,57), Gloombat (57,14)(14,36), Rattlebones (36,36) | up (10,7) -> B1 (32,54); down (55,60) -> B3 (36,61) |
| `f1_dun03` | B3 | 72x72 | 26-30 | Rattlebones (13,52)(59,52)(58,28), Gloombat (14,28); **MVP Gloopking** at (36,14) in the paved hall | up (36,65) -> B2 (55,56) |

The way down: the stair (38,66) is a scripted door (an OnTouch NPC, `f1/stair.ts`; listed in WARPS with `npc` so navigation routes through
it). It stays sealed ("the way down is not open yet") until **1018 The Wardens' Seal** (Main): Warden Orrin offers it after Chapter 1 at
Base Lv 15, defeat 8 Dustcoils in the Mire, report: he sets the permanent `f1_seal` and the stair warps the climber to B1 (32,10). The
auto-hunt picks the catacombs from Lv 21 once the seal is done. Gloopking's line respawns 60-120 min after its death (delay1 3600000 +
up to delay2 3600000). The dungeon species' own art is still in the Codex queue: until it lands each one is drawn with a look-alike
species' sheets (`shared/mobart.ts` ART_STANDIN; Gloopking = a giant Puddlebloom). Bot: `pnpm --filter client dungeon`.

## Floor 1 — the field's roster, weapons and cards (C11)
16 species over the four fields (rows of `shared/data/mobs.json`, imported from rAthena by `FIELD_MOBS` in `tools/rathena/import.ts`, spawn lines in
`shared/data/spawns.txt`): Puddlebloom 1, Sootcap 2, Tumhog 3, Cinderpaw 3, Silkwrap 4 (immobile, passive), Dartwing 5, Leafgrub 6,
Loambloom 8, Whirlpup 12, Mistfin 13, Rootgrin 13 (immobile, aggressive, shoots 4 cells), Mosspaw 14, Chirpjack 15, Gravewalker 17
(aggressive, rare), Dustcoil 18, Stridebeak 25 (Large, rare). Every one drops its card at mob_db's rate (0.01-0.2%; `DROP_RATE` scales it).
Mira sells every low-level weapon type our jobs wield (Dagger, 1h/2h Sword, 1h/2h Spear, 1h/2h Axe, Mace, Staff, Bow); the slotted [3]/[4]
twins and the armor with a slot (Cotton Shirt, Guard, Sandals) are monster drops. A card is double-clicked in the bag: the server lists the
unequipped gear it fits (location overlap, free slot), the player picks one, the card is gone for good and shows as pips on the piece and
as a prefix / suffix in its name ("Double Sturdy Knife of Insight [4]"). Card scripts run after the worn pieces (`gearOf`). Not yet: status
effect cards (Mosspaw / Snake `bAddEff`), accessory cards (no accessory slots), slotted head / garment gear (Hat[1], Hood[1] drop from
Lv26+ monsters), weapon-family attack animations (every weapon still swings the blade).

## Milestones
- **M0 (done, template)**: 2.5D map, click-to-move with A*, multiplayer sync, chat + bubbles, Postgres save, deploy.
- **M1 (this commit)**: monsters with wander/retaliate AI, click-to-attack, damage numbers, HP bars,
  EXP/level-up with persistence, death/respawn, hit + level-up sound.
- **M1.5 (UI pass, done)**: RO-style UI modelled on roBrowser's layout (own CSS, no original textures):
  login screen over the live world, draggable Basic Info / minimap / Options windows, General+Battle chat tabs with
  battle log, RO damage numbers (shrink + arc, red taken, crit burst, Miss), hover tooltip + target/hover rings,
  sword cursor, level-up light pillar + banner, death notice with "Return to Save Point", forgiving monster clicks.
- **rAthena port**: the 10-MVP plan in `PLAN.md` supersedes M2–M5 below. MVP1 (Renewal rules engine, stats, Base/Job EXP,
  Status window, sit, key art) is done.
- **M2**: stats + Novice→first job change NPC, 3 skills per job, inventory + drops + equipment slots, real art
  (LPC layered sprites, Kenney nature/castle 3D for maps).
- **M3**: multiple maps + warp portals (one Colyseus room per map), town with NPCs, party system.
- **M4**: cards + refine, vending, guilds. **M5**: MVP bosses + guild siege, accounts/auth, anti-cheat hardening.

Design reference data (formulas, curves, drop rates) lives in `references/ro/rathena/db/re/*.yml` —
use it to sanity-check numbers, never copy the content.
