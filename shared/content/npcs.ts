// Every NPC of every map (rAthena: the npc/*.txt lines). A room spawns the rows of its own map; kind "shop" opens the shop
// list (its `shop` stock), kind "script" runs `script` for the clicking player (server/src/script.ts). A row with a `trigger`
// area runs `onTouch` (or `script`) for whoever walks in. Server-only: the client gets name / sprite / position through the
// room state (invisible FAKE_NPC rows, sprite "", and floating ones, map "-", never reach it), never the scripts.
import { GRANDMASTER, GRANDMASTER_QUESTINFO, REBIRTH, grandmaster, rebirth } from "./f1/jobs2.ts";
import { TOWN_CELLS } from "../town.ts";
import type { NpcDef } from "./api.ts";
import petsJson from "../data/pets.json" with { type: "json" };
import { ITEMS, SHOP_ITEMS } from "../rules/items.ts";
import { itemNamed } from "../rules/quest.ts";
import { NPC, SPOT } from "./f1/chapter1.ts";
import { GUIDE_QUESTINFO, guideLio, guideLioTouch } from "./f1/guide.ts";
import { MERCHANT_QUESTINFO, miraMerchant, miraTouch } from "./f1/merchant.ts";
import { RANGER_QUESTINFO, rangerVessa, rangerVessaTouch } from "./f1/ranger.ts";
import { HERBALIST_QUESTINFO, herbalistTamsin, herbalistTamsinTouch } from "./f1/herbalist.ts";
import { WARDEN_QUESTINFO, wardenOrrin, wardenOrrinTouch } from "./f1/warden.ts";
import { KEEPER_QUESTINFO, PET_NPC, PET_SPOT, keeperWren } from "./f1/pets.ts";
import { DRILLMASTER_QUESTINFO, GARR_QUESTINFO, HEARTHKEEPER_QUESTINFO, PELLA_QUESTINFO, TOWN_NPC, TOWN_SPOT, armsStock, drillmaster, garr, hearthkeeper, merrit, pella, toolStock } from "./f1/town.ts";
import { FIELD_THEMES, MIRE, MIRE_ASCENT, TOWN } from "../maps.ts";
import { BRANN_ORE_SHOP, ORES, forgemasterBrann } from "./f1/smith.ts";
import { sealedStair } from "./f1/stair.ts";
import { oldLookout } from "./f1/lookout.ts";
import { CAMP, MASTERS, MASTER_QUESTINFO, jobMaster } from "./f1/jobs.ts";
import { CRYSTAL1, NPC2, SPOT2 } from "./f2/chapter2.ts";
import { ascentStair, warpCrystal } from "./f2/ascent.ts";
import { SENTINEL_QUESTINFO, lamplighterIsolde, sentinelCorwin, sentinelCorwinTouch } from "./f2/lanternrest.ts";

// W01: every row names its map through its SPOT (f1/chapter1.ts), TOWN_SPOT (f1/town.ts) or CAMP (f1/jobs.ts, the guild row).

/** 2.4.0: what Tilda sells for pets (rAthena's pet shop stock): every taming item, pet food and accessory of pets.json (never the eggs). */
export const PET_STOCK = [...new Set(petsJson.flatMap((p) => [p.tameItem, p.foodItem, p.equipItem]).filter((id) => id > 0))];

export const NPCS: NpcDef[] = [
  { id: NPC.guide, name: "Guide Lio", sprite: "npc_guide", ...SPOT.guide, kind: "script", script: guideLio,
    trigger: { x: 3, y: 3 }, onTouch: guideLioTouch, questinfo: GUIDE_QUESTINFO },
  { id: NPC.merchant, name: "Mira the Merchant", sprite: "npc_merchant", ...SPOT.merchant, kind: "script", script: miraMerchant,
    trigger: { x: 3, y: 3 }, onTouch: miraTouch, questinfo: MERCHANT_QUESTINFO },
  // Mira's wares: a floating shop (rAthena "-	shop	f1_mira_shop	-1,501:-1,...") that her script opens with callshop
  { id: NPC.miraShop, map: "-", name: "Mira's Wares", sprite: "", x: 0, y: 0, kind: "shop", shop: SHOP_ITEMS },
  { id: NPC.ranger, name: "Ranger Vessa", sprite: "npc_ranger", ...SPOT.ranger, kind: "script", script: rangerVessa,
    trigger: { x: 4, y: 4 }, onTouch: rangerVessaTouch, questinfo: RANGER_QUESTINFO },
  // the old lookout: an invisible trigger area without an OnTouch label, so walking in runs its script (npc_touch_areanpc)
  { id: NPC.lookout, name: "The Old Lookout", sprite: "", ...SPOT.lookout, kind: "script", script: oldLookout, trigger: { x: 2, y: 2 } },
  { id: NPC.herbalist, name: "Herbalist Tamsin", sprite: "npc_herbalist", ...SPOT.herbalist, kind: "script", script: herbalistTamsin,
    trigger: { x: 4, y: 4 }, onTouch: herbalistTamsinTouch, questinfo: HERBALIST_QUESTINFO },
  { id: NPC.warden, name: "Warden Orrin", sprite: "npc_warden", ...SPOT.warden, kind: "script", script: wardenOrrin,
    trigger: { x: 5, y: 5 }, onTouch: wardenOrrinTouch, questinfo: WARDEN_QUESTINFO },
  // W01/W03: the stair down under the Sunken Mire's old keep, an invisible OnTouch area on the stair cell: sealed until Warden Orrin's
  // "The Wardens' Seal" is done, then it warps into the Mirefall Catacombs (f1/stair.ts; shared/maps.ts WARPS lists it as a door)
  { id: "f1_stair", map: MIRE, name: "The Sealed Stair", sprite: "", ...FIELD_THEMES[MIRE].stair!, kind: "script", script: sealedStair, trigger: { x: 1, y: 1 } },
  // 2.5.0 floor 2: the Ascent Stair beside it (up to Lanternrest, f2/ascent.ts), Lanternrest's people and the two warp crystals
  { id: NPC2.ascent, name: "The Ascent Stair", sprite: "", ...MIRE_ASCENT, kind: "script", script: ascentStair, trigger: { x: 1, y: 1 } },
  { id: NPC2.keeper, name: "Lamplighter Isolde", sprite: "npc_herbalist", ...SPOT2.keeper, kind: "script", script: lamplighterIsolde },
  { id: NPC2.sentinel, name: "Sentinel Corwin", sprite: "npc_warden", ...SPOT2.sentinel, kind: "script", script: sentinelCorwin,
    trigger: { x: 4, y: 4 }, onTouch: sentinelCorwinTouch, questinfo: SENTINEL_QUESTINFO },
  { id: NPC2.shop, name: "Marrow's Provisions", sprite: "npc_merchant", ...SPOT2.shop, kind: "shop",
    shop: [...toolStock(SHOP_ITEMS.map((id) => ITEMS.get(id)!)), ...armsStock(SHOP_ITEMS.map((id) => ITEMS.get(id)!))] },
  // the warp crystals (npc_tomb is the stand-in sprite until a crystal is drawn)
  { id: NPC2.crystal, name: "Warp Crystal", sprite: "npc_tomb", ...SPOT2.crystal, kind: "script", script: warpCrystal("f2") },
  { id: NPC2.crystal1, map: CRYSTAL1.map, name: "Warp Crystal", sprite: "npc_tomb", x: CRYSTAL1.x, y: CRYSTAL1.y, kind: "script", script: warpCrystal("f1") },
  // Hearthmoor (C08): the save point, services and townsfolk
  { id: TOWN_NPC.hearthkeeper, map: TOWN, name: "Hearthkeeper Bren", sprite: "npc_merchant", ...TOWN_SPOT.hearthkeeper, kind: "script", script: hearthkeeper, questinfo: HEARTHKEEPER_QUESTINFO },
  // C08 r1: Hearthmoor's services and townsfolk (f1/town.ts); the shops sell Mira's field stock split by type (rAthena shop NPCs)
  { id: TOWN_NPC.tools, map: TOWN, name: "Tilda's Sundries", sprite: "npc_herbalist", ...TOWN_SPOT.tools, kind: "shop", shop: [...toolStock(SHOP_ITEMS.map((id) => ITEMS.get(id)!)), ...PET_STOCK.filter((id) => !toolStock(SHOP_ITEMS.map((i) => ITEMS.get(i)!)).includes(id))] },
  { id: TOWN_NPC.arms, map: TOWN, name: "Garrow's Arms", sprite: "npc_warden", ...TOWN_SPOT.arms, kind: "shop", shop: armsStock(SHOP_ITEMS.map((id) => ITEMS.get(id)!)) },
  // the refiner next to the smithy (f1/smith.ts) and his floating ore shop (callshop)
  { id: TOWN_NPC.refiner, map: TOWN, name: "Forgemaster Brann", sprite: "npc_warden", ...TOWN_SPOT.refiner, kind: "script", script: forgemasterBrann },
  { id: BRANN_ORE_SHOP, map: "-", name: "Brann's Ore", sprite: "", x: 0, y: 0, kind: "shop", shop: ORES.map((n) => itemNamed(n)!.id) },
  { id: TOWN_NPC.drillmaster, map: TOWN, name: "Drillmaster Kessa", sprite: "npc_ranger", ...TOWN_SPOT.drillmaster, kind: "script", script: drillmaster, questinfo: DRILLMASTER_QUESTINFO },
  { id: TOWN_NPC.pella, map: TOWN, name: "Pella the Cook", sprite: "npc_merchant", ...TOWN_SPOT.pella, kind: "script", script: pella, questinfo: PELLA_QUESTINFO },
  { id: TOWN_NPC.garr, map: TOWN, name: "Woodcutter Garr", sprite: "npc_warden", ...TOWN_SPOT.garr, kind: "script", script: garr, questinfo: GARR_QUESTINFO },
  { id: TOWN_NPC.merrit, map: TOWN, name: "Old Merrit", sprite: "npc_guide", ...TOWN_SPOT.merrit, kind: "script", script: merrit },
  // 2.4.0: Keeper Wren, the beast keeper (f1/pets.ts), and her floating pet supply shop (callshop)
  { id: PET_NPC.keeper, name: "Keeper Wren", sprite: "npc_herbalist", ...PET_SPOT.keeper, kind: "script", script: keeperWren, questinfo: KEEPER_QUESTINFO },
  { id: PET_NPC.shop, map: "-", name: "Wren's Pet Supplies", sprite: "", x: 0, y: 0, kind: "shop", shop: PET_STOCK },
  // C04: the six first-job masters in Hearthmoor's guild row (f1/jobs.ts CAMP)
  ...MASTERS.map((m): NpcDef => ({ id: m.npc, map: TOWN, name: m.name, sprite: m.sprite, ...CAMP[m.job], kind: "script", script: jobMaster(m), questinfo: MASTER_QUESTINFO })),
  // 2.5.0: the Guild Grandmaster (f1/jobs2.ts): first job -> second job
  { id: GRANDMASTER.npc, map: TOWN, name: GRANDMASTER.name, sprite: GRANDMASTER.sprite, ...TOWN_CELLS.grandmaster, kind: "script", script: grandmaster, questinfo: GRANDMASTER_QUESTINFO },
  { id: REBIRTH.npc, map: TOWN, name: REBIRTH.name, sprite: REBIRTH.sprite, ...TOWN_CELLS.rebirth, kind: "script", script: rebirth }, // 2.5.0 rebirth
];

export const npcsOn = (map: string) => NPCS.filter((n) => n.map === map);
export const NPC_BY_ID = new Map(NPCS.map((n) => [n.id, n]));
/** FAKE_NPC (sprite "") or floating (map "-"): rAthena's class-less NPCs, usable from anywhere (npc_checknear, class_ < 0). */
export const npcClassless = (n: Pick<NpcDef, "sprite" | "map">) => !n.sprite || n.map === "-";
