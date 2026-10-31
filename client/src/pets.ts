// Pets (2.4.0) on the client: the words RO uses for hunger / intimacy, the pet unit helpers main.ts draws with, and the room's pet
// messages that are not a window (emotion bubbles, system lines, the taming result). A pet is a unit of state.pets drawn with its
// species' monster sprite at PET_SCALE; the server owns everything (server/src/pets.ts), contract in shared/protocol.ts "Pets (2.4.0)".
import type { Room } from "@colyseus/sdk";
import * as THREE from "three";
import { Msg, PET_HUNGRY, type PetCatchResultEvent, type PetEmoteEvent, type PetNoticeEvent } from "../../shared/protocol.ts";
import { ET } from "../../shared/rules/script.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import { ART_STANDIN } from "../../shared/mobart.ts";
import { log } from "./ui/hud.ts";
import { showEmotion } from "./ui/emotion.ts";
import { play } from "./audio.ts";
import type { Fx } from "./fx.ts";
import petsJson from "../../shared/data/pets.json";
import { t } from "./i18n.ts";

/** rAthena pet.cpp / clif: hunger bands (PET_HUNGRY_*) and intimacy bands (PET_INTIMATE_*), worded like the classic client. */
export function hungerWord(h: number) { return t(h <= 10 ? "pet.h_very" : h <= PET_HUNGRY ? "pet.h_hungry" : h <= 75 ? "pet.neutral" : h <= 90 ? "pet.h_satisfied" : "pet.h_stuffed"); }
export function intimacyWord(i: number) { return t(i < 100 ? "pet.i_awkward" : i < 250 ? "pet.i_shy" : i < 750 ? "pet.neutral" : i < 910 ? "pet.i_cordial" : "pet.i_loyal"); }
export const kindLabel = (k: string) => t(`pet.kind_${k}`);

/** A pet's sprite sheet key (the species' monster art, or its stand-in). */
export function petSheet(mobId: number) {
  return `mob_${mobId in ART_STANDIN ? (ART_STANDIN as Record<number, number>)[mobId] : mobId}`;
}
export const petSpecies = (mobId: number) => MOB_BY_ID.get(mobId);

// ---------- 2.4.0 legendary pets (pets.json rarity "legendary"): gold name label, a soft gold aura under the pet, a window badge ----------
const LEGENDARY_MOBS = new Set((petsJson as { mobId: number; rarity?: string }[]).filter((p) => p.rarity === "legendary").map((p) => p.mobId));
export const isLegendaryPet = (mobId: number) => LEGENDARY_MOBS.has(mobId);
let auraGeo: THREE.CircleGeometry | undefined, auraMat: THREE.MeshBasicMaterial | undefined;
/** A flat gold glow (radial gradient disc) to hang under a legendary pet's shadow; its opacity breathes slowly (one shared material). */
export function petAura(): THREE.Mesh {
  if (!auraGeo || !auraMat) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 128;
    const g = cv.getContext("2d")!, grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,226,120,0.95)"); grad.addColorStop(0.45, "rgba(255,180,60,0.55)"); grad.addColorStop(1, "rgba(255,140,30,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    auraGeo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2); // flat on the ground like the shadow it hangs under
    auraMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
  }
  const m = new THREE.Mesh(auraGeo, auraMat);
  m.scale.setScalar(1.35); m.position.y = 0.004; m.renderOrder = -1;
  m.onBeforeRender = () => { auraMat!.opacity = 0.42 + 0.18 * Math.sin(performance.now() / 650); };
  return m;
}

/** What main.ts lets this module see of the world. */
export type PetView = { entity(id: string): { pos: THREE.Vector3; name: string } | undefined; camera: THREE.Camera; fx: Fx };

let room: Room | undefined, view: PetView | undefined, timer = 0;
let picked: string | undefined; // the monster my last taming click went to (the result event does not name it)
export const notePick = (id: string | undefined) => { picked = id; };

export function bindPets(r: Room, v: PetView) {
  resetPets();
  room = r; view = v;
  r.onMessage(Msg.petEmote, (m: PetEmoteEvent) => showEmotion(m.id, m.emote));
  r.onMessage(Msg.petNotice, (m: PetNoticeEvent) => log("system", m.text));
  r.onMessage(Msg.petCatchResult, (m: PetCatchResultEvent) => {
    const name = petSpecies(m.mobId)?.name ?? "monster";
    log("system", m.ok ? t("pet.tamed", { name }) : t("pet.slipped", { name }));
    const e = picked ? v.entity(picked) : undefined;
    picked = undefined;
    if (e) { if (m.ok) v.fx.levelUp(e.pos); else v.fx.impact(e.pos, v.camera, "hurt"); }
    play("sfx", m.ok ? "levelup" : "error", 0.5);
  });
  // a hungry pet (state.pets[].hungry) now and then shows the hungry emotion over itself, like clif_pet_emotion
  timer = window.setInterval(() => {
    const pets = (r.state as any)?.pets;
    pets?.forEach?.((p: any, key: string) => { if (p.hungry && Math.random() < 0.7) showEmotion(String(key), ET.HUNGRY); });
  }, 7000);
}
export function resetPets() { clearInterval(timer); timer = 0; room = undefined; view = undefined; picked = undefined; }
