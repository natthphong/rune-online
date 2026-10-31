import "@fontsource/cinzel/700.css";
import "./style.css";
import * as THREE from "three";
import { Callbacks, Client, type Room } from "@colyseus/sdk";
import {
  Msg, type ChangeMapEvent, type ChatEvent, type DieEvent, type ExpEvent, type HealEvent, type HitEvent, type HotkeysEvent, type InvEvent,
  type CardAckEvent, type CardListEvent, type ItemGetEvent, type LevelUpEvent, type NoticeEvent, type ShopEvent, type StatUpAck, type StatusEvent, type TakeItemEvent,
  type ScListEvent, type SkillCancelEvent, type SkillCastEvent, type SkillDelayEvent, type SkillFailEvent, type SkillUseEvent, type SkillsEvent, PET_SCALE,
} from "../../shared/protocol.ts";
import { SKILLS, SKILL_USE, skillElement, skillHits, skillLv } from "../../shared/rules/skill.ts";
import { clearPending, initSkills, pendingSkill, skillState, resetSkills, setSkillOwner, setSkills, skillDelay, updateSkillShades } from "./ui/skills.ts";
import { SkillFx, castBar, clearSkillOverlays, endCastBar, shout, updateSkillOverlays } from "./skillFx.ts";
import { skillFx2 } from "./skillFx2.ts";
import { findPath, type GameMap } from "../../shared/map.ts";
import { newMotion, patchMotion, setWalkGoal, stepMotion, walkGoal, type Motion } from "./motion.ts";
import { FIELD, MAP_INFO, WARPS, buildMap, isMapName, roomOf, type MapName } from "../../shared/maps.ts";
import { ART_STANDIN } from "../../shared/mobart.ts";
import { makeDoorGlow, makePortal, tickPortals } from "./portal.ts";
import { SEAL } from "../../shared/content/f1/stair.ts";
import { lookOf } from "./themes.ts";
import { resumeNavi, takeNavi } from "./navi.ts";
import { autoOn, setAuto } from "./autoplay.ts";
import { MOB_BY_ID, type JobKey, type Mob, type StatKey } from "../../shared/rules/data.ts";
import { playerStatus } from "../../shared/rules/status.ts";
import { ITEMS, gearOf } from "../../shared/rules/items.ts";
import { addFloor, addNpc, clearThings, nearestFloor, npcSeeUnits, pickThing, removeThing, updateThings } from "./worldItems.ts";
import { cardAck, closeShop, getInventory, initItems, openCardList, openShop, setHotkeys, setInventory, setWeight } from "./ui/items.ts";
import { AnimSprite, drawStill, preloadLook } from "./animSprite.ts";
import { preloadMap } from "./preload.ts";
import { buildWorld, heightAt, setSeeThrough, tickWorld } from "./world.ts";
import { play, setMusicMap } from "./audio.ts";
import { SERVER } from "./config.ts";
import { api, session } from "./api.ts";
import { initScreens, openLogin, openSelect, show } from "./ui/screens.ts";
import type { CharacterSummary, Look } from "../../shared/look.ts";
import { Fx } from "./fx.ts";
import { StatusFx } from "./statusFx.ts";
import { clearStatusList, setStatusList } from "./ui/statusIcons.ts";
import { setPopObstacles, spawnPop, updatePops } from "./ui/damage.ts";
import { bindBoss } from "./ui/boss.ts";
import { applyI18n, bindLangSelects, t as tr } from "./i18n.ts"; // aliased: `t` is a local name in places
import { banner, drawMinimap, initHud, log, logExpLoss, setMinimapMap, settings, showDeath, tooltip, updateBasicInfo, updateStatusWindow, type Dot, type MeView } from "./ui/hud.ts";
import { bindDialog, dialogOpen, resetDialog } from "./ui/dialog.ts";
import { bindQuests, onQuestLog, questStateOf, resetQuests, stopNavi, updateQuestUi } from "./ui/quests.ts";
import { bindAutoUi, stopAuto } from "./ui/auto.ts";
import { bindPets, resetPets, isLegendaryPet, petAura } from "./pets.ts";
import { bindPetUi, resetPetUi, petCatchActive, petCatchCancel, petCatchPick } from "./ui/pet.ts";
import { bindDuel, duelFoe, handleDuelInput, resetDuel } from "./ui/duel.ts"; // 1v1 duel (2.4.0)
import { bindParty, handleChatInput, openMenu, partyDots, partyMemberByName, resetParty, setPartyMap, unbindParty } from "./ui/party.ts";
import { bindEmotions, resetEmotions, updateEmotions } from "./ui/emotion.ts";

const BACKDROP_SEED = 1337; // login-screen world; replaced if the server's seed differs

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const labels = $("labels");
const popLayer = $("pops");
applyI18n(); bindLangSelects(); // static markup (data-i18n) + the language selectors; t() for text built in code

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#9fc7e8");
scene.fog = new THREE.Fog("#9fc7e8", 30, 60);
const hemi = new THREE.HemisphereLight("#ffffff", "#5a6b3a", 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff4dc", 1.6);
sun.position.set(-20, 40, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -24;
sun.shadow.camera.right = sun.shadow.camera.top = 24;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);
const fx = new Fx(scene);
const skillFx = new SkillFx(scene); // casting circles and skill effects (skillFx.ts)
const statusFx = new StatusFx(scene); // what a unit's synced status options (opt1 / opt2) look like: tints, stars, Z's ... (statusFx.ts)

// RO camera: fixed pitch, right-drag rotates yaw, wheel zooms.
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
const CAM_DEFAULT = { yaw: 0, pitch: 0.85, dist: 22 };
const cam = { ...CAM_DEFAULT, target: new THREE.Vector3(32, 0, 32) };
function placeCamera() {
  const { yaw, pitch, dist, target } = cam;
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);
}
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ---------- world ----------
let map: GameMap | undefined;
let mapKey = "";
let mapName: MapName = FIELD;
let musicCheckAt = 0;
let world: THREE.Group | undefined;
let ground: THREE.Mesh | undefined;
const worldCache = new Map<string, { map: GameMap; group: THREE.Group; ground: THREE.Mesh }>();
function loadMap(seed: number, name: MapName = FIELD) {
  if (`${name}:${seed}` === mapKey) return;
  if (world) scene.remove(world); // stays in worldCache (below) so a warp back to it skips the ~300 ms terrain + shader build
  mapKey = `${name}:${seed}`; mapName = name; setPartyMap(name);
  setMusicMap(MAP_INFO[name].music);
  let cached = worldCache.get(mapKey);
  if (cached) worldCache.delete(mapKey);
  else {
    const gm = buildMap(name, seed); // shared/maps.ts: each field from its theme + the seed, Hearthmoor from its layout
    cached = { map: gm, ...buildWorld(gm) };
  }
  worldCache.set(mapKey, cached); // most recently used last
  for (const [k, v] of worldCache) { // keep the current map + 2 more; dispose the least recently used
    if (worldCache.size <= 3) break;
    worldCache.delete(k);
    v.group.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  }
  map = cached.map;
  world = cached.group; ground = cached.ground;
  for (const old of world.children.filter((c) => c.name === "warp")) world.remove(old); // portals are rebuilt below (portal.ts drops motes of unloaded maps)
  // the theme's sky, fog and light (themes.ts): the woods are dim and green, the highlands bright, the mire murky
  const look = lookOf(map.theme);
  (scene.background as THREE.Color).set(look.sky);
  (scene.fog as THREE.Fog).color.set(look.fog); (scene.fog as THREE.Fog).near = look.fogNear; (scene.fog as THREE.Fog).far = look.fogFar;
  hemi.color.set(look.hemiSky); hemi.groundColor.set(look.hemiGround); hemi.intensity = look.hemi;
  sun.color.set(look.sunColor); sun.intensity = look.sun;
  // warp portals (npc/re/warps): a light column on each warp cell of this map (portal.ts); a scripted door (the sealed stair) is
  // drawn by its own prop instead
  for (const p of WARPS.filter((wp) => wp.map === name && !wp.npc)) world.add(makePortal(p.x, p.y, heightAt(map, p.x, p.y)));
  doorMap = name;
  refreshDoors();
  scene.add(world);
  setMinimapMap(map, MAP_INFO[name].title, WARPS.filter((wp) => wp.map === name));
}
/** W01 r2: a scripted door (the sealed stair) glows faintly once it is open for this character (quest 1018 done, f1_seal). */
let doorMap: MapName | undefined;
function refreshDoors() {
  const w = world, m = map;
  if (!w || !m) return;
  for (const old of w.children.filter((c) => c.name === "door")) w.remove(old);
  if (!doorMap || questStateOf(SEAL) !== 2) return;
  for (const p of WARPS.filter((wp) => wp.map === doorMap && wp.npc)) {
    const g = makeDoorGlow(p.x, p.y, heightAt(m, p.x, p.y));
    g.name = "door";
    w.add(g);
  }
}
onQuestLog(refreshDoors);
loadMap(BACKDROP_SEED);

// ---------- entities (players + monsters share one shape) ----------
type Entity = {
  id: string; isMonster: boolean; mob?: Mob; name: string; shadow: THREE.Mesh;
  obj: THREE.Object3D; // what moves in the world: the actor's billboard
  view: AnimSprite; speed: number;
  pos: THREE.Vector3; target: THREE.Vector2; motion: Motion; dir: number; moving: boolean; dead: boolean; sitting: boolean; hp: number; maxHp: number;
  pet?: boolean; // 2.4.0: a hatched pet (state.pets): a monster sprite at PET_SCALE that follows its owner; never a target
  boss: number; // monsters: 0 ordinary, 1 boss, 2 MVP (Monster.boss, server/src/boss.ts)
  label?: HTMLDivElement; bar: HTMLDivElement; bubble?: { el: HTMLDivElement; until: number };
};
const entities = new Map<string, Entity>();
const pickables: THREE.Object3D[] = [];
const SHADOW_SQUASH = new THREE.Vector3(0.78, 1, 0.45); // x across the body, z along the view: boots-wide oval
const shadowGeo = new THREE.CircleGeometry(0.32, 20).rotateX(-Math.PI / 2);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false });

const MOB_HEIGHT: Record<string, number> = { Small: 0.85, Medium: 1.15, Large: 1.7 };
/** Bosses are drawn larger than their size class (data size stays rAthena's: it drives size_fix damage): mini-bosses x1.45, MVPs x1.35 on top of Large. */
const BOSS_SCALE: Record<string, number> = { Boss: 1.45, Mvp: 1.35 };

/** Player look from synced state (empty strings = nothing worn in that slot). */
const lookOfState = (s: any): Look => ({ gender: s.gender === "F" ? "F" : "M", hair: s.hair, style: s.style ?? 0, outfit: s.outfit || "novice",
  weapon: s.weapon || null, shield: s.shield || null, headgear: s.headgear || null, garment: s.garment || null });

function addEntity(id: string, s: any, isMonster: boolean, isMe: boolean, isPet = false) {
  const def = isMonster || isPet ? MOB_BY_ID.get(s.mobId) : undefined;
  const view = def ? new AnimSprite({ body: `mob_${def.id}`, fallback: `mob_${def.id}`, standin: def.id in ART_STANDIN ? `mob_${ART_STANDIN[def.id]}` : undefined, height: (MOB_HEIGHT[def.size] ?? 1.1) * (BOSS_SCALE[def.bossType] ?? 1) * (isPet ? PET_SCALE : 1) })
    : new AnimSprite({ look: lookOfState(s), height: 1.5 });
  const obj: THREE.Object3D = view.object;
  obj.userData.entityId = id;
  const at = drawnAt(s);
  obj.position.set(at.x, map ? heightAt(map, at.x, at.y) : 0, at.y); // start in place, not sliding in from the origin
  if (isMonster) pickables.push(obj);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  scene.add(obj, shadow);
  if (isPet && def && isLegendaryPet(def.id)) shadow.add(petAura()); // 2.4.0 legendary pet: a gold glow rides under it (pets.ts)
  let label: HTMLDivElement | undefined;
  const boss: number = isMonster ? s.boss ?? 0 : 0;
  if (!isMonster || boss) { // RO shows monster names only on hover (tooltip); a boss / MVP keeps a coloured tag
    label = document.createElement("div");
    label.className = isPet ? (def && isLegendaryPet(def.id) ? "label pet legendary" : "label pet") : isMe ? "label me" : boss ? `label ${boss === 2 ? "mvp" : "boss"}` : "label";
    label.textContent = isPet ? s.name : def ? def.name : s.name;
    labels.append(label);
  }
  const bar = document.createElement("div");
  bar.className = isMonster ? (boss ? `mob-life ${boss === 2 ? "mvp" : "boss"}` : "mob-life") : "ent-bar"; // mob-life: ui/combat.css (the classic magenta monster gauge)
  bar.append(document.createElement("i"));
  labels.append(bar);
  // HP: a monster's is in the synced state; a player's reaches only its owner (Msg.status, onStatus), so others' stay 0
  const hp = isMonster ? s.hp : isMe ? own?.hp ?? 0 : 0, maxHp = isMonster ? s.maxHp : isMe ? own?.maxHp ?? 0 : 0;
  const e: Entity = {
    id, isMonster, pet: isPet, mob: def, name: isPet ? s.name : def ? def.name : s.name, obj, view, speed: 0, shadow, pos: obj.position.clone(), target: new THREE.Vector2(at.x, at.y), motion: newMotion(at.x, at.y, performance.now()),
    dir: s.dir, moving: s.moving, dead: s.dead, sitting: !!s.sitting, hp, maxHp, label, bar, boss,
  };
  entities.set(id, e);
  statusFx.set(id, s.opt ?? "");
  return e;
}
function removeEntity(id: string) {
  const e = entities.get(id);
  if (!e) return;
  statusFx.drop(id);
  scene.remove(e.obj, e.shadow);
  const i = pickables.indexOf(e.obj);
  if (i >= 0) pickables.splice(i, 1);
  e.view.dispose();
  e.label?.remove();
  e.bar.remove();
  e.bubble?.el.remove();
  entities.delete(id);
  if (attackTarget === id) attackTarget = undefined;
}
function clearEntities() { for (const id of [...entities.keys()]) removeEntity(id); }
/** Where a unit is drawn: its cell (x / y, which the server changes only when a step completes) plus how far it has come into
 *  the cell it is stepping into (sx / sy), so walking stays smooth between cells. */
function drawnAt(s: any) { return { x: s.x + (s.sx ?? 0), y: s.y + (s.sy ?? 0) }; }
/** The cell a walking unit goes to after the one it is stepping into (motion.ts runs on toward it until the next patch): for
 *  the local player the server's own path search toward the cell it asked for, for anyone else (and for the server's
 *  walks: walking in to attack or pick up) straight on. */
function afterCell(e: Entity, s: any) {
  return (nx: number, ny: number) => {
    const g = e.id === room?.sessionId ? walkGoal() : undefined;
    if (g && nx === g.x && ny === g.y) return undefined; // the walk ends there
    // trusted only while the server's step is the one that path takes (not a walk of its own, a stale goal or a blocked cell)
    const on = g && map ? findPath(map, s.x, s.y, g.x, g.y)[0] : undefined;
    const p = on && on.x === nx && on.y === ny ? findPath(map!, nx, ny, g!.x, g!.y)[0] : undefined;
    return p ?? { x: 2 * nx - s.x, y: 2 * ny - s.y };
  };
}
function sync(e: Entity, s: any) {
  const at = drawnAt(s), now = performance.now();
  // teleports (respawn) snap instead of sliding across the map
  if (Math.hypot(at.x - e.target.x, at.y - e.target.y) > 4) { e.pos.set(at.x, e.pos.y, at.y); e.motion = newMotion(at.x, at.y, now); }
  e.target.set(at.x, at.y);
  patchMotion(e.motion, s.x, s.y, s.sx ?? 0, s.sy ?? 0, s.dir, !!s.moving, now, afterCell(e, s));
  e.dir = s.dir; e.moving = s.moving; e.sitting = !!s.sitting;
  statusFx.set(e.id, s.opt ?? ""); // B14: stun / poison / freeze ... shown on the unit
  if (e.isMonster) { e.hp = s.hp; e.maxHp = s.maxHp; } // players' HP isn't synced (my own comes with Msg.status)
  if (e.pet) { if (e.name !== s.name) { e.name = s.name; if (e.label) e.label.textContent = s.name; } } // a rename
  else if (!e.isMonster) e.view.setLook(lookOfState(s)); // gear changes show immediately
  if (e.dead !== s.dead) {
    e.dead = s.dead;
    if (e.id === room?.sessionId) showDeath(e.dead);
  }
}
/** C09 party hook: is another player's HP bar drawn? rAthena sends a player's HP to others only through its party
 *  (clif_party_hp, PARTY_AREA_WOS), its battleground (clif_bg_hp) and view_hpmeter GMs (clif_update_hp clif.cpp:3539-3546,
 *  clif_getareachar_pc 5010-5014). No parties yet, so nobody: the party module will answer true for members and fill their
 *  e.hp / e.maxHp from its own HP message. */
const partyHp = (e: Entity) => {
  const m = partyMemberByName(e.name); // 2.3.0: Msg.party / partyUpdate (ui/party.ts) carry the members' HP
  if (!m || !m.online || m.maxHp <= 0) return false;
  e.hp = m.hp; e.maxHp = m.maxHp;
  return true;
};

// ---------- network ----------
let room: Room | undefined;
let me: any; // my Player in the synced state: only what everyone sees (look, name, job, base level, position)
let own: StatusEvent | undefined; // Msg.status: my own stats / points / EXP / HP / SP (the owner alone gets them)
let attackTarget: string | undefined;
let joinedAt = 0;

let leaving = false; // true while we close the room ourselves (char select / logout)

let playing: CharacterSummary | undefined; // the character in game (a map change rejoins with it)
async function startGame(c: CharacterSummary, to: MapName = isMapName(c.map) ? c.map : FIELD) {
  playing = c;
  if (c.look) preloadLook(c.look);
  preloadMap(to); // monster sheets download while the room joins; neighbouring maps' follow at idle time
  const r = await new Client(SERVER).joinOrCreate(roomOf(to), { token: session.token, charId: c.id });
  room = r;
  enterWorld(r);
}

/** clif_changemap (C08): the character now stands on another map; fade out, leave this map's room, join that map's room. */
async function changeMap(r: Room, m: ChangeMapEvent) {
  if (!isMapName(m.map) || !playing || room !== r) return;
  const fade = document.getElementById("map-fade") ?? Object.assign(document.body.appendChild(document.createElement("div")), { id: "map-fade" });
  Object.assign(fade.style, { position: "fixed", inset: "0", background: "#000", opacity: "0", transition: "opacity 0.18s", pointerEvents: "none", zIndex: "50" });
  requestAnimationFrame(() => { fade.style.opacity = "1"; });
  leaving = true;
  play("sfx", "portal_warp", 0.6);
  // a cross-map auto-walk / auto-play goes on in the next room (navi.ts plans over the warp graph)
  const carry = { navi: takeNavi(), auto: autoOn() };
  preloadMap(m.map); // the next map's monster sheets download while the screen fades and the old room closes
  const left = r.leave().catch(() => {}); // closes in parallel with the fade instead of after it
  await new Promise((res) => setTimeout(res, 190));
  leaveWorld();
  await left;
  leaving = false;
  try {
    await startGame(playing, m.map);
    if (carry.navi) resumeNavi(carry.navi);
    if (carry.auto) setAuto(true, true);
  }
  catch { openSelect().catch(() => openLogin("Disconnected from server.")); }
  finally { fade.style.opacity = "0"; }
}

function enterWorld(r: Room) {
  show(null);
  $("hud").hidden = false;
  joinedAt = performance.now();
  Object.assign(cam, CAM_DEFAULT);
  const cb = Callbacks.get(r);
  const reload = () => loadMap(r.state.seed, isMapName(r.state.map) ? r.state.map : FIELD);
  cb.listen("seed", reload);
  cb.listen("map", (m: string) => {
    reload();
    if (!isMapName(m)) return;
    banner(MAP_INFO[m].title, MAP_INFO[m].sub);
    log("system", tr(MAP_INFO[m].town ? "game.welcome_town" : "game.welcome_field", { map: MAP_INFO[m].title }));
  });
  r.onMessage(Msg.changeMap, (m: ChangeMapEvent) => { changeMap(r, m); });
  for (const coll of ["players", "monsters", "pets"] as const) {
    // 2.4.0: r.state may not be decoded yet when this runs, so do NOT test state.pets here (that skipped every pet); Callbacks defers
    cb.onAdd(coll, (s: any, key: unknown) => {
      const id = String(key), isMe = id === r.sessionId;
      const e = addEntity(id, s, coll === "monsters", isMe, coll === "pets");
      if (coll === "monsters" && s.boss && !s.dead && performance.now() - joinedAt > 1500) play("sfx", "boss_spawn", 0.6); // C07: a boss (re)appears
      if (isMe) { me = s; cam.target.set(s.x, 0, s.y); }
      else if (coll === "players" && performance.now() - joinedAt > 1500) log("system", tr("game.entered", { name: s.name }));
      cb.onChange(s, () => sync(e, s));
    });
    cb.onRemove(coll, (s: any, key: unknown) => {
      if (coll === "players" && String(key) !== r.sessionId) log("system", tr("game.left", { name: s.name }));
      removeEntity(String(key));
    });
  }
  r.onMessage(Msg.chat, (m: ChatEvent) => showChat(m));
  r.onMessage(Msg.hit, (m: HitEvent) => onHit(m));
  r.onMessage(Msg.die, (m: DieEvent) => onDie(m));
  r.onMessage(Msg.levelUp, (m: LevelUpEvent) => onLevelUp(m));
  r.onMessage(Msg.exp, (m: ExpEvent) => onExp(m));
  r.onMessage(Msg.status, (m: StatusEvent) => onStatus(m));
  r.onMessage(Msg.scList, (m: ScListEvent) => setStatusList(m)); // B14: my status icons (clif_status_change)
  // clif_statusupack: Msg.status already re-synced the window; a refusal says why (the classic client's "Insufficient status points" line)
  r.onMessage(Msg.statUpAck, (m: StatUpAck) => { if (!m.ok) log("system", tr("game.stat_fail")); });
  r.onMessage(Msg.takeItem, (m: TakeItemEvent) => entities.get(m.id)?.view.action("pickup")); // clif_takeitem: someone nearby (or I) picks up
  cb.onAdd("floor", (f: any, key: unknown) => addFloor(scene, labels, String(key), f.itemId, f.x, f.y, map ? heightAt(map, f.x, f.y) : 0));
  cb.onRemove("floor", (_f: any, key: unknown) => removeThing(scene, String(key)));
  cb.onAdd("npcs", (n: any, key: unknown) => { if (n.kind === "tomb" && performance.now() - joinedAt > 1500) play("sfx", "tomb_appear", 0.6); }); // C07: a tomb shows up
  cb.onAdd("npcs", (n: any, key: unknown) => addNpc(scene, labels, String(key), n.name, n.sprite, n.x, n.y, map ? heightAt(map, n.x, n.y) : 0));
  r.onMessage(Msg.inv, (m: InvEvent) => setInventory(m));
  r.onMessage(Msg.cardList, (m: CardListEvent) => openCardList(m)); // ZC_ITEMCOMPOSITION_LIST: the pieces a card fits
  r.onMessage(Msg.cardAck, (m: CardAckEvent) => cardAck(m)); // ZC_ACK_ITEMCOMPOSITION
  r.onMessage(Msg.hotkeys, (m: HotkeysEvent) => setHotkeys(m.keys, m.rowShift));
  r.onMessage(Msg.shop, (m: ShopEvent) => openShop(m));
  r.onMessage(Msg.shopClose, () => closeShop());
  r.onMessage(Msg.notice, (m: NoticeEvent) => { log("system", m.text); play("sfx", "error", 0.5); });
  r.onMessage(Msg.itemGet, (m: ItemGetEvent) => {
    const it = ITEMS.get(m.itemId);
    log("exp", tr("game.obtained", { name: it?.name ?? tr("game.item"), n: m.amount > 1 ? ` ×${m.amount}` : "" })); // the pickup motion is Msg.takeItem
    play("sfx", "ui_open", 0.5);
  });
  r.onMessage(Msg.heal, (m: HealEvent) => {
    const e = entities.get(m.id);
    if (!e) return;
    if (m.hp) spawnPop(popLayer, popUnit(e), `+${m.hp}`, "heal");
    if (m.id === r.sessionId) play("sfx", "levelup", 0.35);
  });
  // skills (ui/skills.ts window + targeting, skillFx.ts cast bars and effects)
  r.onMessage(Msg.skills, (m: SkillsEvent) => setSkills(m));
  r.onMessage(Msg.skillFail, (m: SkillFailEvent) => { log("system", m.text); play("sfx", "error", 0.5); });
  r.onMessage(Msg.skillDelay, (m: SkillDelayEvent) => skillDelay(m));
  r.onMessage(Msg.skillCast, (m: SkillCastEvent) => onSkillCast(m));
  r.onMessage(Msg.skillCancel, (m: SkillCancelEvent) => { endCastBar(m.src); skillFx.stopCast(m.src); });
  r.onMessage(Msg.skillUse, (m: SkillUseEvent) => onSkillUse(m));
  bindDialog(r, camera); // NPC dialog / menu / cutin (ui/dialog.ts); the camera lets a new dialog stay off the player and the NPC
  bindQuests(r); // quest log, tracker, NPC marks, reward feed, auto-navigation (ui/quests.ts)
  bindAutoUi(r); // C12 auto quest / auto battle (autoplay.ts): ordinary intents only
  bindParty(r); // party / friends / whispers (ui/party.ts)
  bindDuel(r); // duel challenge popup / strip / commands (ui/duel.ts)
  bindPetUi(r); // 2.4.0 pet window, egg list, taming cursor (ui/pet.ts)
  bindPets(r, { entity: (id) => { const e = entities.get(id); return e && { pos: e.pos, name: e.name }; }, camera, fx }); // pet emotions, notices, taming result (pets.ts)
  setPartyMap(mapName);
  bindEmotions(r); // NPC scripts in the world: emotion bubbles and npctalk lines (ui/emotion.ts)
  bindBoss(r, { entity: (id) => { const e = entities.get(id); return e && { pos: e.pos, name: e.name }; }, me: () => r.sessionId, fx }); // MVP effect, rewards, announcements (ui/boss.ts)
  r.onLeave((code: number) => {
    if (leaving) return;
    leaveWorld();
    if (code === 4001) { session.clear(); openLogin("This account logged in somewhere else."); }
    else openSelect().catch(() => openLogin("Disconnected from server."));
  });
  setTimeout(() => { // fresh characters: point them at their 48 starting stat points
    if (room === r && own && own.statPoints >= 20) { log("system", tr("game.points_hint", { n: own.statPoints })); }
  }, 600);
}

function leaveWorld() {
  room = undefined; me = undefined; own = undefined; attackTarget = undefined;
  resetDuel(); // the duel ends with the room
  if (leaving) unbindParty(); else resetParty(); // a map change keeps the party list, logout / char select forgets it
  resetPetUi(); resetPets();
  bindAutoUi(undefined); resetDialog(); resetQuests(); resetEmotions(); resetSkills(); clearSkillOverlays(); clearStatusList();
  $("w-options").hidden = true;
  clearEntities();
  clearThings(scene);
  showDeath(false);
  tooltip(null);
  $("hud").hidden = true;
  $("chat-log").innerHTML = "";
}

/** Close the room ourselves, then go to character select or (logout) the login screen. */
async function exitGame(logout: boolean) {
  const r = room;
  leaving = true;
  leaveWorld();
  await r?.leave().catch(() => {});
  leaving = false;
  if (logout) { await api.logout(); session.clear(); openLogin(); }
  else await openSelect();
}

/** My character as the HUD reads it (hud.ts MeView): the public unit fields from the synced state and my own numbers from
 *  Msg.status. Undefined until both arrived. */
function myView(): MeView | undefined {
  if (!me || !own) return undefined;
  return { name: me.name, job: me.job, x: me.x, y: me.y, dead: me.dead, ...own };
}
/** Msg.status (clif_updatestatus & co., owner only): keep my numbers; my own HP bar reads them too. */
function onStatus(m: StatusEvent) {
  own = m;
  setWeight(m.weight, m.maxWeight);
  const e = room && entities.get(room.sessionId);
  if (e) { e.hp = m.hp; e.maxHp = m.maxHp; }
}

/** Status as the server computes it: stats + worn gear from the last inventory snapshot. */
function myStatus(v: MeView) {
  const worn = getInventory().items.flatMap((st) => { const item = st.equip && ITEMS.get(st.itemId); return item ? [{ item, refine: st.refine, cards: st.cards }] : []; });
  return playerStatus({ job: v.job as JobKey, level: v.level, jobLevel: v.jobLevel, ...gearOf(worn), // same gearOf as the server's Inventory.gear()
    stats: { str: v.str, agi: v.agi, vit: v.vit, int: v.int, dex: v.dex, luk: v.luk } });
}

// Alt held = show the names of every item on the ground (like the original's item-name toggle)
let altDown = false;
addEventListener("keydown", (e) => { if (e.key === "Alt") altDown = true; });
addEventListener("keyup", (e) => { if (e.key === "Alt") altDown = false; });
addEventListener("blur", () => { altDown = false; });

initItems({
  use: (uid) => room?.send(Msg.useItem, { uid }),
  equip: (uid) => room?.send(Msg.equip, { uid }),
  unequip: (uid) => room?.send(Msg.unequip, { uid }),
  buy: (npc, items) => room?.send(Msg.shopBuy, { npc, items }),
  sell: (npc, items) => room?.send(Msg.shopSell, { npc, items }),
  hotkeys: (m) => room?.send(Msg.hotkeys, m),
  sit: () => room?.send(Msg.sit), // a sit slot on the shortcut bar = the Insert key
  preview: (cv) => { if (me) void drawStill(cv, lookOfState(me)); },
  quit: () => room?.send(Msg.shopQuit, {}), // CZ_NPC_TRADE_QUIT
  insertCard: (card, equip) => room?.send(Msg.insertCard, { card, equip }), // CZ_REQ_ITEMCOMPOSITION
  log: (text) => log("system", text),
});

initSkills({
  skillUp: (id) => room?.send(Msg.skillUp, { id }), // CZ_UPGRADE_SKILLLEVEL
  use: (id, lv, t) => { // CZ_USE_SKILL (unit / self) or CZ_USE_SKILL_TOGROUND (cell); the server walks into range itself
    if (!room) return;
    room.send(Msg.useSkill, { id, lv, ...(t?.unit ? { target: t.unit } : {}), ...(t?.x !== undefined ? { x: t.x, y: t.y } : {}) });
    if (t?.unit && entities.get(t.unit)?.isMonster) attackTarget = t.unit;
  },
  log: (text) => log("system", text),
});

// dev-only console handle: __ro.me / __ro.room (stripped from production builds)
if (import.meta.env.DEV) (window as any).__ro = { get me() { return me; }, get own() { return own; }, get room() { return room; } };

initHud({
  onRespawn: () => room?.send(Msg.respawn),
  onLogout: () => exitGame(true),
  onCharSelect: () => exitGame(false),
  onResetCamera: () => Object.assign(cam, CAM_DEFAULT),
  onStatUp: (k: StatKey) => room?.send(Msg.statUp, { stat: k }),
});

// ---------- combat feedback ----------
// The server sends `hit` when the swing starts (clif_damage): the attacker animates at once, timed so its blow frame lands
// `amotion` ms later, when the server applies the damage (battle_delay_damage) and the number, hit sound and the target's
// flinch (for its dmotion) appear — the classic client's ZC_NOTIFY_ACT handling (attack ACT scaled to attackMT, damage
// shown and ACTION_HURT played at tick + attackMT).
function onHit(m: HitEvent) {
  const from = entities.get(m.from), to0 = entities.get(m.to);
  const mine = m.from === room?.sessionId, onMe = m.to === room?.sessionId;
  if (mine || onMe) { play("sfx", "swing", mine ? 0.6 : 0.3); engage(mine ? m.to : m.from); }
  if (from && to0) {
    from.view.face(Math.atan2(to0.pos.x - from.pos.x, to0.pos.z - from.pos.z));
    if (!(m.skill && SKILLS.get(m.skill)?.type === "Magic")) from.view.action("attack", m.amotion / 1000); // spells: the cast pose (onSkillUse)
  }
  setTimeout(() => landHit(m, mine, onMe), Math.max(0, m.amotion));
}
function landHit(m: HitEvent, mine: boolean, onMe: boolean) {
  const to = entities.get(m.to), from = entities.get(m.from);
  if (!to) return;
  if (from?.isMonster && from.dead) return; // a monster's swing dies with it (MapRoom.landDamage drops it too): no hit after the MVP line
  if ((mine || onMe) && m.miss) play("sfx", "miss", mine ? 0.6 : 0.3);
  if ((mine || onMe) && !m.miss) play("sfx", m.crit ? "crit" : "hit");
  // the number pops on the struck unit's own head (ui/damage.ts places it from that unit's drawn sprite) and drifts off it
  // away from the attacker (right when the blow comes from straight above or below on screen, the classic's default);
  // colours as in the classic client: red on any player, white on monsters, yellow for a critical on a monster
  const away = from ? awayOnScreen(to, from) : undefined, side = away && away.x < -0.25 ? -1 : 1;
  const kind = !to.isMonster ? "taken" : m.crit ? "crit" : "dealt", div = Math.max(1, m.div ?? 1), sk = m.skill ? SKILLS.get(m.skill) : undefined;
  if (m.lucky) spawnPop(popLayer, popUnit(to), "Lucky", "lucky");
  else if (m.miss) spawnPop(popLayer, popUnit(to), "Miss", "miss");
  else if (div > 1) { // a multi-hit skill: every hit deals the same (DAMAGE_DIV_FIX), shown one number per hit like the classic client
    const per = Math.floor(m.dmg / div);
    for (let i = 0; i < div; i++) setTimeout(() => spawnPop(popLayer, popUnit(to), String(i === div - 1 ? m.dmg - per * (div - 1) : per), kind, side), i * 130);
  } else spawnPop(popLayer, popUnit(to), String(m.dmg), kind, side);
  if (mine) log("battle", m.miss ? (sk ? tr("battle.miss_skill", { to: to.name, skill: sk.name }) : tr("battle.miss", { to: to.name })) : (sk ? tr("battle.hit_skill", { skill: sk.name, to: to.name, dmg: m.dmg }) : tr("battle.hit", { to: to.name, dmg: m.dmg })) + (div > 1 ? ` (${tr("battle.hits", { n: div })})` : "") + (m.crit ? ` (${tr("battle.crit")})` : "") + ".");
  if (onMe) log("battle-bad", m.lucky ? tr("battle.lucky", { from: from?.name ?? tr("game.something") }) : m.miss ? tr("battle.missed_you", { from: from?.name ?? tr("game.something") }) : tr("battle.hit_you", { from: from?.name ?? tr("game.something"), dmg: m.dmg }));
  if (!m.miss) {
    // hit confirmation on the blow frame: a spark where the weapon meets the body, and the target flinches away from it
    fx.impact(contactPoint(to, from), camera, m.crit && to.isMonster ? "crit" : to.isMonster ? "hit" : "hurt");
    to.view.action("hit", m.dmotion / 1000, away);
  }
  if ((from?.isMonster || from?.pet) && !from.dead) from.obj.position.lerp(to.pos, 0.12); // the blow: monsters lunge a little
}
/** What a pop is anchored to: the unit's DRAWN position (the sprite, not the network position it eases toward) and the
 *  top of its standing pose as drawn (a squat slime's head is lower than its size class says, and the taller frame of
 *  a swing in progress must not lift the number off it). */
const popUnit = (e: Entity) => ({ id: e.id, at: e.obj.position, height: e.view.standTop() });
// the other drawn units, so a number over a unit that overlaps another on screen climbs above the higher head
setPopObstacles(() => { const l: ReturnType<typeof popUnit>[] = []; for (const e of entities.values()) if (!e.dead) l.push(popUnit(e)); return l; });
const camUp = new THREE.Vector3(), hitAt = new THREE.Vector3(), scrA = new THREE.Vector3(), scrB = new THREE.Vector3();
/** Where a blow meets the target: the middle of its sprite (sprites face the camera, so "up" is the camera's up),
 *  moved toward the attacker by up to 0.3 world units, at the edge of the body facing it. */
function contactPoint(to: Entity, from: Entity | undefined) {
  camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  hitAt.copy(to.obj.position).addScaledVector(camUp, to.view.standTop() * 0.5);
  if (from) {
    const dx = from.obj.position.x - to.obj.position.x, dz = from.obj.position.z - to.obj.position.z, d = Math.hypot(dx, dz);
    if (d > 0.01) { const s = Math.min(0.3, d * 0.45) / d; hitAt.x += dx * s; hitAt.z += dz * s; }
  }
  return hitAt;
}
/** Unit screen direction (x right, y up) from the attacker to the target: the way the target is knocked. */
function awayOnScreen(to: Entity, from: Entity) {
  scrA.copy(to.obj.position).project(camera); scrB.copy(from.obj.position).project(camera);
  const x = (scrA.x - scrB.x) * innerWidth, y = (scrA.y - scrB.y) * innerHeight, d = Math.hypot(x, y);
  return d > 1 ? { x: x / d, y: y / d } : undefined;
}

// Units you fight (you hit them or they hit you) stay "engaged" for a few seconds after the last blow either way.
const fighting = new Map<string, number>();
function engage(id: string) { fighting.set(id, performance.now() + 3000); }

// Every unit is an upright sprite sorted by depth, so a monster one cell behind your character (north, on the default
// camera) vanishes behind it, its HP bar and ring landing on your body — the classic client has the same overlap. Fade
// a player's sprite while it hides a good part of your target or of a unit you are fighting, the way world.ts thins
// props in front of you, so you can always see who is being hit.
/** A sprite on screen: its feet (fx, fy), pixels per world unit at its depth, and the box around its drawn pixels. */
type ScreenBox = { fx: number; fy: number; ppu: number; x0: number; x1: number; y0: number; y1: number; depth: number };
const boxA: ScreenBox = { fx: 0, fy: 0, ppu: 0, x0: 0, x1: 0, y0: 0, y1: 0, depth: 0 }, boxB: ScreenBox = { ...boxA };
const camFwd = new THREE.Vector3();
function screenBox(e: Entity, out: ScreenBox) {
  const b = e.view.bounds();
  if (!b || !e.obj.visible) return false;
  out.depth = tmp.copy(e.obj.position).sub(camera.position).dot(camFwd);
  if (out.depth <= 0.1) return false;
  out.ppu = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * out.depth); // sprites face the camera
  tmp.copy(e.obj.position).project(camera);
  out.fx = (tmp.x * 0.5 + 0.5) * innerWidth; out.fy = (-tmp.y * 0.5 + 0.5) * innerHeight;
  out.x0 = out.fx + b.l * out.ppu; out.x1 = out.fx + b.r * out.ppu; out.y0 = out.fy - b.t * out.ppu; out.y1 = out.fy - b.b * out.ppu;
  return true;
}
/** Share of `back`'s drawn pixels that `front`'s drawn pixels cover on screen, sampled on a grid over back's box
 *  (a weapon swinging across a target hides little of it; a head in front of it hides most). */
function coverage(front: Entity, f: ScreenBox, back: Entity, b: ScreenBox) {
  if (f.x1 <= b.x0 || f.x0 >= b.x1 || f.y1 <= b.y0 || f.y0 >= b.y1) return 0;
  const N = 12;
  let solid = 0, hidden = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const sx = b.x0 + ((i + 0.5) / N) * (b.x1 - b.x0), sy = b.y0 + ((j + 0.5) / N) * (b.y1 - b.y0);
    if (!back.view.solidAt((sx - b.fx) / b.ppu, (b.fy - sy) / b.ppu)) continue;
    solid++;
    if (front.view.solidAt((sx - f.fx) / f.ppu, (f.fy - sy) / f.ppu)) hidden++;
  }
  return solid ? hidden / solid : 0;
}
/** The units in your fight, most important first: your target, then the units you hit or that hit you in the last
 *  3 s, nearest first. Props in front of them are cleared too (world.ts setSeeThrough), and so are player sprites. */
function fightUnits(now: number) {
  const watched: Entity[] = [];
  const tgt = attackTarget ? entities.get(attackTarget) : undefined;
  if (tgt && !tgt.dead) watched.push(tgt);
  for (const [id, until] of fighting) {
    const e = entities.get(id);
    if (now > until || !e) fighting.delete(id);
    else if (e !== tgt && !e.dead) watched.push(e);
  }
  const self = room ? entities.get(room.sessionId) : undefined;
  if (self && watched.length > 2) {
    const d = (e: Entity) => e.obj.position.distanceToSquared(self.obj.position);
    watched.splice(tgt ? 1 : 0, Infinity, ...watched.slice(tgt ? 1 : 0).sort((a, b) => d(a) - d(b)));
  }
  return watched;
}
function updateSeeThrough(watched: Entity[]) {
  camera.getWorldDirection(camFwd);
  for (const p of entities.values()) {
    if (p.isMonster || p.pet) continue;
    let hides = false;
    const share = p.view.seeThrough ? 0.2 : 0.35; // hysteresis: every animation frame covers a little more or less
    if (watched.length && screenBox(p, boxA)) {
      for (const w of watched) {
        if (w === p || !screenBox(w, boxB) || boxB.depth < boxA.depth + 0.3) continue; // only units behind this one
        if (coverage(p, boxA, w, boxB) > share) { hides = true; break; }
      }
    }
    p.view.setSeeThrough(hides);
  }
}
function onDie(m: DieEvent) {
  const e = entities.get(m.id);
  if (!e) return;
  if (attackTarget === m.id) attackTarget = undefined;
  if (e.isMonster && m.killer === room?.sessionId) {
    play("sfx", "mob_die");
    log("battle", tr("battle.defeated", { name: e.name }));
  }
  if (m.id === room?.sessionId) {
    play("sfx", "player_die");
    log("battle-bad", tr("battle.killed_by", { name: entities.get(m.killer ?? "")?.name ?? tr("game.something") }));
  }
}
function onExp(m: ExpEvent) {
  if (m.lost) { logExpLoss(m.base, m.job); return; }
  const e = room && entities.get(room.sessionId);
  const parts = [m.base > 0 && `${m.base} Base`, m.job > 0 && `${m.job} Job`].filter(Boolean) as string[];
  if (!parts.length) return;
  if (e) spawnPop(popLayer, popUnit(e), `+${parts.join(" / +")} EXP`, "exp");
  log("exp", tr("game.gained", { what: parts.join(tr("game.and")) }));
}
/** clif_misceffect NOTIFYEFFECT_BASE/JOB_LEVEL_UP: only players within area_size get it, and it is just the effect — no chat
 *  line about anyone else. My own banner reads the new level from Msg.status, which the server sends just before. */
function onLevelUp(m: LevelUpEvent) {
  const e = entities.get(m.id);
  if (!e) return;
  fx.levelUp(e.pos);
  e.view.action("cheer");
  if (m.id !== room?.sessionId) return;
  const what = m.kind === "base" ? "Base" : "Job", level = own ? (m.kind === "base" ? own.level : own.jobLevel) : undefined;
  play("sfx", "levelup");
  banner(tr("game.level_up", { what }), level ? tr("game.level_n", { what, n: level }) : "");
  if (level) log("system", tr("game.congrats", { what, n: level }));
}

// ---------- skills: casting and effects (server events; the window and targeting are ui/skills.ts) ----------
/** clif_skillcasting: the caster turns to its target, a casting circle opens under it and the cast bar fills over castMs. */
function onSkillCast(m: SkillCastEvent) {
  const src = entities.get(m.src), s = SKILLS.get(m.id);
  if (!src || !s) return;
  const tgt = m.target ? entities.get(m.target) : undefined;
  if (tgt && tgt !== src) src.view.face(Math.atan2(tgt.pos.x - src.pos.x, tgt.pos.z - src.pos.z));
  else if (m.x !== undefined && m.y !== undefined) src.view.face(Math.atan2(m.x - src.pos.x, m.y - src.pos.z));
  if (m.castMs > 0) {
    castBar(labels, m.src, m.castMs);
    skillFx.cast(m.src, src.obj.position, skillElement(s, m.lv) ?? "Neutral", m.castMs);
    if (m.src === room?.sessionId) play("sfx", "ui_open", 0.35);
  }
}
/** The skill goes off (clif_skill_nodamage / poseffect / the start of clif_skill_damage): name shout, motion, the effect. The
 *  damage numbers come with the Msg.hit that follows (HitEvent.skill). */
function onSkillUse(m: SkillUseEvent) {
  const src = entities.get(m.src), s = SKILLS.get(m.id);
  endCastBar(m.src); skillFx.stopCast(m.src);
  if (!src || !s) return;
  shout(labels, m.src, s.name);
  src.view.action(s.type === "Magic" ? "cheer" : "attack", 0.35);
  const ele = skillElement(s, m.lv), tgt = m.target ? entities.get(m.target) : undefined;
  const cell = m.x !== undefined && m.y !== undefined && map ? new THREE.Vector3(m.x, heightAt(map, m.x, m.y), m.y) : undefined;
  const splash = skillLv(s.splash, m.lv);
  if (src.pet) { // 2.4.0 a legendary pet's fire breath (server/src/pets.ts breath, petskillattack): a fire burst on the target + its splash
    if (tgt) { skillFx.strike(tgt.obj.position, ele ?? "Fire", true); skillFx.ground(tgt.obj.position, ele ?? "Fire", splash || 2); }
    return;
  }
  // 2.5.0: the 2nd-job skill kinds (skillFx2.ts)
  if (skillFx2(skillFx, s, m, src, tgt, cell, ele, splash, (t, text) => spawnPop(popLayer, popUnit(t as Entity), text, "heal"))) {
    if (m.src === room?.sessionId || m.target === room?.sessionId) play("sfx", "swing", 0.4);
    return;
  }
  switch (s.key) {
    case "AL_HEAL":
      if (tgt) { skillFx.heal(tgt.obj.position); if (m.heal) spawnPop(popLayer, popUnit(tgt), `+${m.heal}`, "heal"); }
      break;
    case "SM_MAGNUM": skillFx.ground(src.obj.position, ele ?? "Fire", splash || 2); break;
    case "AC_SHOWER": if (cell) skillFx.ground(cell, ele, splash || 1, true); break;
    case "AC_DOUBLE": if (tgt) skillFx.shot(src.obj.position, tgt.obj.position, ele, skillHits(s, m.lv)); break;
    case "MC_MAMMONITE": if (tgt) skillFx.strike(tgt.obj.position, ele, true); break;
    default:
      if (SKILL_USE[s.key]?.kind === "status") { // B14: a buff / cure lights its target like a heal, a debuff or curse strikes it dark
        if (s.target === "Attack") { if (tgt) skillFx.strike(tgt.obj.position, "Dark"); } else skillFx.heal((tgt ?? src).obj.position);
      } else if (s.type === "Magic" && tgt) skillFx.bolts(tgt.obj.position, ele, skillHits(s, m.lv));
      else if (tgt) skillFx.strike(tgt.obj.position, ele);
      else if (cell) skillFx.ground(cell, ele, splash || 1);
  }
  if (m.src === room?.sessionId || m.target === room?.sessionId) play("sfx", s.key === "AL_HEAL" ? "levelup" : "swing", 0.4);
}
/** A player under the cursor (support skills): the unit whose sprite column (feet to head on screen) is nearest the click,
 *  within 26 px. */
function pickPlayer(x: number, y: number, dead = false) {
  let best: Entity | undefined, bd = 26;
  for (const e of entities.values()) {
    if (e.isMonster || e.pet || !!e.dead !== dead) continue; // 2.5.0: Resurrection picks the dead
    tmp.copy(e.obj.position).project(camera);
    const fx0 = (tmp.x * 0.5 + 0.5) * innerWidth, fy = (-tmp.y * 0.5 + 0.5) * innerHeight;
    tmp.copy(e.obj.position).setY(e.obj.position.y + e.view.standTop()).project(camera);
    const hy = (-tmp.y * 0.5 + 0.5) * innerHeight;
    const dy = y < hy ? hy - y : y > fy ? y - fy : 0, d = Math.hypot(x - fx0, dy);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
/** The click that finishes an armed skill: an enemy for attack skills, a player (or yourself) / a unit for support skills,
 *  a cell for ground skills. A click that finds nothing keeps the skill armed. */
function useArmedSkill(cx: number, cy: number) {
  const p = pendingSkill(), s = p && SKILLS.get(p.id);
  if (!p || !s || !room || !ground || !map) return;
  const g = (() => { pickMonster(cx, cy); return ray.intersectObject(ground!)[0]; })();
  if (s.target === "Ground") {
    if (!g) return;
    const x = Math.round(g.point.x), y = Math.round(g.point.z);
    clearPending();
    room.send(Msg.useSkill, { id: p.id, lv: p.lv, x, y });
    fx.markClick(new THREE.Vector3(x, heightAt(map, x, y), y));
    return;
  }
  const mob = pickMonster(cx, cy) ?? (g ? nearestMonster(g.point.x, g.point.z, 1.0) : undefined);
  const pc = s.target === "Support" ? pickPlayer(cx, cy, s.key === "ALL_RESURRECTION") : undefined;
  const foeHit = s.target === "Attack" && duelFoe() ? pickPlayer(cx, cy) : undefined; // duel: the opponent is a valid enemy
  const t = s.target === "Support" ? pc ?? mob : foeHit && foeHit.id === duelFoe() ? foeHit : mob; // no duel: foeHit and duelFoe() are both undefined
  if (!t) { log("system", tr(s.target === "Support" ? "game.click_player" : "game.click_monster")); return; }
  clearPending();
  room.send(Msg.useSkill, { id: p.id, lv: p.lv, target: t.id });
  setWalkGoal(); // out of range, the server walks in to it
  if (t.isMonster) attackTarget = t.id;
  play("sfx", "click", 0.35);
}

// ---------- chat ----------
function showChat(m: ChatEvent) {
  log(m.id === room?.sessionId ? "self" : "chat", m.text, m.name);
  const e = entities.get(m.id);
  if (e) {
    e.bubble?.el.remove();
    const el = document.createElement("div");
    el.className = "bubble";
    el.textContent = m.text;
    labels.append(el);
    e.bubble = { el, until: performance.now() + 5000 };
  }
}
const chatInput = $<HTMLInputElement>("chat-input");
$<HTMLFormElement>("chat-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (text && !handleDuelInput(text) && !handleChatInput(text)) room?.send(Msg.chat, { text });
  chatInput.value = "";
  chatInput.blur();
});
addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && document.activeElement !== chatInput && room) { chatInput.focus(); ev.preventDefault(); }
  if (ev.key === "Insert" && document.activeElement !== chatInput && room) { room.send(Msg.sit); ev.preventDefault(); }
});

// ---------- input: click monster = attack, click ground = walk, right drag = rotate, wheel = zoom ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let dragging = false;
let hoveredThing: string | undefined;
let hovered: Entity | undefined;

function pickMonster(x: number, y: number) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  for (const hit of ray.intersectObjects(pickables)) {
    const e = entities.get(hit.object.userData.entityId);
    if (e && !e.dead) return e;
  }
  return undefined;
}

function nearestMonster(x: number, z: number, within: number) {
  let best: Entity | undefined, bd = within;
  for (const e of entities.values()) {
    if (!e.isMonster || e.dead) continue;
    const d = Math.hypot(e.obj.position.x - x, e.obj.position.z - z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// dev console / browser tests; extends the __ro handle above (assigning a new object here used to drop me/room)
if (import.meta.env.DEV) Object.assign((window as any).__ro, { mockPet: (mobId: number, name = "Pet") => addEntity("petmock", { mobId, name, x: me.x - 1, y: me.y + 1, sx: 0, sy: 0, dir: 0, moving: false, dead: false }, false, false, true) }); // pet unit without a 2.4.0 server
if (import.meta.env.DEV) Object.assign((window as any).__ro, { entities, pickMonster, camera, spawnPop, skills: skillState, skillDefs: SKILLS, skillUse: SKILL_USE });

const hitG = (e: PointerEvent) => (ray.setFromCamera(ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera), ground ? ray.intersectObject(ground)[0] : undefined);
let rightDown: { x: number; y: number; t: number } | undefined;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 2) { if (pendingSkill()) clearPending(); petCatchCancel(); dragging = true; rightDown = { x: e.clientX, y: e.clientY, t: performance.now() }; canvas.setPointerCapture(e.pointerId); return; }
  if (e.button !== 0 || !room || !ground || !map || me?.dead) return;
  if (e.shiftKey) { const p = pickPlayer(e.clientX, e.clientY); if (p && p.id !== room.sessionId) { openMenu(p.name, e.clientX, e.clientY); return; } } // Shift+click on a player: the same menu as a right-click
  if (petCatchActive()) { const t = pickMonster(e.clientX, e.clientY) ?? (hitG(e) ? nearestMonster(hitG(e)!.point.x, hitG(e)!.point.z, 1.0) : undefined); if (t) petCatchPick(t.id); else petCatchCancel(); return; } // 2.4.0: the taming cursor (ui/pet.ts)
  if (dialogOpen()) return; // an NPC window is open: no world clicks (the original disables mouse targeting)
  stopAuto("Auto off: you took over."); // a manual click ends auto-play (C12)
  if (pendingSkill()) { stopNavi(); useArmedSkill(e.clientX, e.clientY); return; } // a skill waits for its target (ui/skills.ts)
  stopNavi(); // any click takes over from auto-navigation
  const foeId = duelFoe(); // duel (2.4.0): clicking the opponent attacks it, nobody else is attackable
  if (foeId) {
    const f = pickPlayer(e.clientX, e.clientY);
    if (f && f.id === foeId) { attackTarget = f.id; setWalkGoal(); room.send(Msg.attack, { id: f.id }); return; }
  }
  const hit = (() => { const t = pickMonster(e.clientX, e.clientY); return { t, g: ray.intersectObject(ground)[0] }; })();
  // forgiving click: wandering monsters are small moving targets, so a ground click within
  // ~1 tile of a live monster counts as clicking it
  const target = hit.t ?? (hit.g ? nearestMonster(hit.g.point.x, hit.g.point.z, 1.0) : undefined);
  if (target) {
    attackTarget = target.id;
    setWalkGoal(); // the server walks in to it
    room.send(Msg.attack, { id: target.id });
    return;
  }
  const thing = pickThing(ray) ?? (hit.g ? nearestFloor(hit.g.point.x, hit.g.point.z, 0.8) : undefined);
  if (thing) {
    // NPC: the server opens it if within npc_checknear range (15 cells) and otherwise ignores the click; it never walks
    // and never stops the current walk/attack (npc_click), so the target ring stays. Items: walk there and pick up.
    if (thing.kind === "floor") { attackTarget = undefined; setWalkGoal(); }
    room.send(thing.kind === "npc" ? Msg.npc : Msg.pickup, { id: thing.id });
    play("sfx", "click", 0.35);
    return;
  }
  if (!hit.g) return;
  const x = Math.round(hit.g.point.x), y = Math.round(hit.g.point.z);
  attackTarget = undefined;
  room.send(Msg.move, { x, y });
  setWalkGoal({ x, y });
  play("sfx", "click", 0.35);
  fx.markClick(new THREE.Vector3(x, heightAt(map, x, y), y));
});
canvas.addEventListener("pointermove", (e) => {
  if (dragging) { cam.yaw -= e.movementX * 0.008; return; }
  hovered = room ? pickMonster(e.clientX, e.clientY) : undefined;
  hoveredThing = !hovered && room ? pickThing(ray)?.id : undefined;
  document.body.classList.toggle("attack-cursor", !!hovered);
  document.body.classList.toggle("talk-cursor", !!hoveredThing);
  if (hovered?.mob) {
    const d = hovered.mob;
    const tag = hovered.boss === 2 ? "[MVP] " : hovered.boss === 1 ? "[Boss] " : "";
    tooltip(`${tag}${d.name}  Lv ${d.level} · ${d.element} ${d.elementLevel} · ${d.race} · ${d.size}`, e.clientX, e.clientY, hovered.boss ? `mob ${hovered.boss === 2 ? "mvp" : "boss"}` : "mob");
  }
  else tooltip(null);
});
canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 2) return;
  dragging = false;
  // a right-click that did not drag the camera, on another player: Whisper / Invite to party / Add friend (ui/party.ts)
  if (rightDown && room && performance.now() - rightDown.t < 450 && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5) {
    const p = pickPlayer(e.clientX, e.clientY);
    if (p && p.id !== room.sessionId) openMenu(p.name, e.clientX, e.clientY);
  }
  rightDown = undefined;
});
canvas.addEventListener("pointerleave", () => { hovered = undefined; tooltip(null); document.body.classList.remove("attack-cursor"); });
canvas.addEventListener("wheel", (e) => { cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.02, 10, 40); }, { passive: true });

// ---------- frame loop ----------
const tmp = new THREE.Vector3();
const clock = new THREE.Clock();
function place(el: HTMLElement, v: THREE.Vector3, dy = 0) {
  tmp.copy(v).project(camera);
  el.style.display = tmp.z < 1 ? "" : "none";
  el.style.left = `${(tmp.x * 0.5 + 0.5) * innerWidth}px`;
  el.style.top = `${(-tmp.y * 0.5 + 0.5) * innerHeight + dy}px`;
}
function ringAt(ring: THREE.Mesh, e: Entity | undefined) {
  ring.visible = !!e && !e.dead;
  if (e) ring.position.set(e.obj.position.x, e.pos.y + 0.04, e.obj.position.z);
}
let minimapAt = 0;
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta(), t = clock.elapsedTime, now = performance.now();
  if (!room) { // login screen: slow orbit over the backdrop world
    cam.yaw += dt * 0.08;
    cam.target.set(32, 1, 32);
    cam.dist = 30;
  }
  for (const [id, e] of entities) {
    // between the 20 Hz patches: dead reckoning along the step with corrections blended in (motion.ts)
    const lx = e.pos.x, lz = e.pos.z, mo = stepMotion(e.motion, dt, now);
    e.pos.x = mo.x; e.pos.z = mo.y;
    e.pos.y = map ? heightAt(map, e.pos.x, e.pos.z) : 0;
    const px = e.obj.position.x, pz = e.obj.position.z;
    // the sprite moves with e.pos; only an offset of its own (a monster's lunge) eases back
    e.obj.position.x += e.pos.x - lx; e.obj.position.z += e.pos.z - lz;
    e.obj.position.lerp(e.pos, 1 - Math.exp(-dt * 20));
    e.obj.position.y = e.pos.y;
    e.speed += ((dt > 0 ? Math.hypot(e.obj.position.x - px, e.obj.position.z - pz) / dt : 0) - e.speed) * Math.min(1, dt * 10);
    // a small tight ellipse right under the drawn feet (the sprite lags e.pos by the easing, so follow obj, not pos)
    e.shadow.position.set(e.obj.position.x, e.pos.y + 0.02, e.obj.position.z);
    e.shadow.scale.setScalar(THREE.MathUtils.clamp(e.view.height / 1.5, 0.6, 2)).multiply(SHADOW_SQUASH);
    if (e.moving) e.view.faceDir(e.dir);
    e.view.update(dt, cam.yaw, { moving: e.moving && e.speed > 0.3, dead: e.dead, sitting: e.sitting, speed: e.speed });
    e.shadow.visible = e.obj.visible && !(e.dead && e.isMonster);
    const isMe = id === room?.sessionId;
    if (isMe) cam.target.lerp(tmp.set(e.pos.x, e.pos.y + 0.6, e.pos.z), 1 - Math.exp(-dt * 8));
    if (e.label) {
      // a boss keeps its tag, so does the duel opponent; a dead monster's name goes with its gauge (the corpse fades a moment later)
      e.label.hidden = (e.dead && e.isMonster) || (!settings.showNames && !isMe && !e.boss && e.id !== duelFoe());
      e.label.classList.toggle("duel-foe", e.id === duelFoe());
      if (!e.label.hidden) place(e.label, e.pos, 6);
    }
    // HP bars: my own always; a monster's once hurt (monster_hp_bars_info); another player's only for a party member (partyHp)
    e.bar.hidden = e.dead || e.pet || (isMe ? e.maxHp <= 0 : e.isMonster ? e.hp >= e.maxHp : !partyHp(e));
    if (!e.bar.hidden) {
      // a monster's gauge hangs right under its drawn sprite (it follows lunges and stays put while the sprite flinches)
      place(e.bar, e.isMonster ? e.obj.position : e.pos, e.label && !e.label.hidden ? 21 : 6);
      (e.bar.firstChild as HTMLElement).style.transform = `scaleX(${e.hp / e.maxHp})`;
      if (e.isMonster) e.bar.classList.toggle("low", e.hp < e.maxHp * 0.25);
    }
    if (e.bubble) {
      if (now > e.bubble.until) { e.bubble.el.remove(); e.bubble = undefined; }
      else place(e.bubble.el, tmp.set(e.pos.x, e.pos.y + 1.7, e.pos.z));
    }
  }
  { // a pet's name never covers another unit's: hide it while it sits near a visible non-pet label (the owner's always wins).
    // Compares the left/top place() just wrote (labels are centred on that point) instead of reading layout every frame.
    const xy = (el: HTMLElement) => [parseFloat(el.style.left), parseFloat(el.style.top)];
    let others: number[][] | undefined;
    for (const e of entities.values()) {
      if (!e.pet || !e.label || e.label.hidden) continue;
      others ??= [...entities.values()].filter((o) => !o.pet && o.label && !o.label.hidden && o.label.style.display !== "none").map((o) => xy(o.label!));
      const [x, y] = xy(e.label);
      e.label.style.visibility = others.some(([ox, oy]) => Math.abs(ox - x) < 70 && Math.abs(oy - y) < 16) ? "hidden" : "";
    }
  }
  // the hovered monster died or left (a boss's death, a slave dying with it): its tooltip, cursor and ring go now, not on the next mouse move
  if (hovered && (hovered.dead || entities.get(hovered.id) !== hovered)) { hovered = undefined; tooltip(null); document.body.classList.remove("attack-cursor"); }
  ringAt(fx.target, attackTarget ? entities.get(attackTarget) : undefined);
  ringAt(fx.hover, hovered && hovered.id !== attackTarget ? hovered : undefined);
  fx.update(now);
  skillFx.update(now);
  statusFx.update(now, (id) => { const e = entities.get(id); return e && { sprite: e.obj as THREE.Sprite, at: e.obj.position, top: e.view.standTop(), hidden: !e.obj.visible || e.dead }; });
  updateSkillOverlays(now, (id) => { const e = entities.get(id); return e && tmp.set(e.obj.position.x, e.obj.position.y + e.view.standTop() + 0.15, e.obj.position.z); }, place);
  updateSkillShades(now);
  setSkillOwner(own, me?.job);
  tickWorld(t, camera, renderer.domElement.height);
  tickPortals(t);
  if (now >= musicCheckAt) { // W03: the boss track while a living MVP is near (within 16 cells), the map's own track otherwise
    musicCheckAt = now + 1000;
    let mvp = false;
    if (me) for (const e of entities.values()) if (e.boss === 2 && !e.dead && Math.max(Math.abs(e.pos.x - me.x), Math.abs(e.pos.z - me.y)) <= 16) { mvp = true; break; }
    setMusicMap(mvp ? "boss" : MAP_INFO[mapName].music);
  }
  updateThings(camera, cam.yaw, t, hoveredThing, altDown);
  updateQuestUi(camera, now); // quest marks over NPCs + auto-navigation steps
  updateEmotions(camera, now); // emotion / npctalk bubbles follow their unit
  // keep the shadow camera centred on the player
  sun.position.set(cam.target.x - 20, 40, cam.target.z + 10);
  sun.target.position.copy(cam.target);
  const view = myView();
  if (view) {
    updateBasicInfo(view);
    if (now - minimapAt > 100) { // 10 fps is plenty for the minimap
      minimapAt = now;
      const dots: Dot[] = [];
      for (const [id, e] of entities) if (!e.pet && (e.isMonster || id === room?.sessionId || !partyMemberByName(e.name)?.online)) dots.push({ x: e.pos.x, y: e.pos.z, self: id === room?.sessionId, mob: e.isMonster });
      for (const d of partyDots()) dots.push({ ...d, self: false, party: true });
      drawMinimap(dots, { x: view.x, y: view.y }, cam.yaw);
      updateStatusWindow(view, myStatus(view));
    }
  }
  placeCamera();
  const mine = room ? entities.get(room.sessionId) : undefined;
  const fight = fightUnits(now);
  const seeUnits = fight.slice(0, 3).map((e) => ({ at: e.obj.position, height: e.view.height }));
  if (mine) for (const n of npcSeeUnits(mine.obj.position, 20)) if (seeUnits.length < 6) seeUnits.push(n); // NPCs under a canopy stay visible
  setSeeThrough(camera, mine ? mine.obj.position : null, innerWidth / innerHeight, seeUnits); // trees clear for the fight and the NPCs, not just for you
  updateSeeThrough(fight);
  updatePops(camera, now);
  renderer.render(scene, camera);
});

// ---------- boot: saved session -> character select, otherwise login ----------
initScreens({ onStart: startGame });
if (session.token) openSelect().catch(() => openLogin("Server unreachable — try again in a moment."));
else openLogin();
