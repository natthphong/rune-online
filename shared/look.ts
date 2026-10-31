// Character appearance, RO style: a body sprite per gender + job outfit (the job decides the clothes, like the
// original), a dyeable hairstyle, plus layers for worn gear. Sheets: public/sprites/anim (client/src/animSprite.ts).
// Server validates creation choices against these lists.
export const GENDERS = ["M", "F"] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABEL: Record<Gender, string> = { M: "Male", F: "Female" };
/** Hair dyes (index stored in characters.hair_color); applied by multiplying the grey hair mask. */
export const HAIR_COLORS = ["#7a4a2a", "#3a2a24", "#f2cf72", "#e0543e", "#ff9ec4", "#5b8ff0", "#59c27a", "#e9e6f2", "#b07ae0"] as const;
export const HAIR_LABEL = ["Chestnut", "Raven", "Golden", "Crimson", "Blossom", "Azure", "Fern", "Silver", "Violet"] as const;

/** Hair styles (index stored in characters.hairdo). 0 = the hair painted on the body sheets; the others are overlay
 *  strips `sprites/hairdo_<key>.png` (client/src/animSprite.ts) drawn on the head anchor and dyed like the hair. */
export const HAIR_STYLES = [
  { key: "", label: "Classic" }, { key: "ponytail", label: "Ponytail" }, { key: "twintails", label: "Twin Tails" },
  { key: "long", label: "Long" }, { key: "topknot", label: "Topknot" }, { key: "braid", label: "Braid" },
] as const;

/** What a character looks like. Built from the character + equipped items (visualsOf). */
export type Look = {
  gender: Gender; hair: number; outfit: string;
  style?: number; // hair style, index into HAIR_STYLES (absent = 0)
  weapon?: string | null; // attack animation family ("blade"); null = bare hands
  shield?: string | null; headgear?: string | null; garment?: string | null; // gear layer sheet keys
};

/** Job -> outfit body (`sprites/anim/pc_<G>_<outfit>_<walk|misc|blade|fist>`), like the job's own sprite in the original
 *  (one body per job class and gender). Only outfits drawn for BOTH genders and all four sheets are listed
 *  (shared/rules/look.test.ts checks the files); every other job wears the Novice outfit until its art exists. */
export const JOB_OUTFITS: Record<string, string> = { Swordman: "swordman" };
export const SHEETS = ["walk", "misc", "blade", "fist"] as const;
/** 2.5.0: the 2nd jobs and the transcendent line wear their first job's body recoloured until their own art exists: the hue
 *  turns by `OUTFIT_TINT[job]` degrees (clothes only: hair and skin keep their colours, client/src/animSprite.ts tintSheet), and a
 *  transcendent job adds "b" = brighter, more saturated cloth. Written into Look.outfit as `<body>@<hue>[b]`. */
export const OUTFIT_BASE: Record<string, string> = {
  Knight: "Swordman", Crusader: "Swordman", Lord_Knight: "Swordman", Paladin: "Swordman", Swordman_High: "Swordman",
  Wizard: "Mage", Sage: "Mage", High_Wizard: "Mage", Professor: "Mage", Mage_High: "Mage",
  Hunter: "Archer", Bard: "Archer", Dancer: "Archer", Sniper: "Archer", Clown: "Archer", Gypsy: "Archer", Archer_High: "Archer",
  Priest: "Acolyte", Monk: "Acolyte", High_Priest: "Acolyte", Champion: "Acolyte", Acolyte_High: "Acolyte",
  Blacksmith: "Merchant", Alchemist: "Merchant", Whitesmith: "Merchant", Creator: "Merchant", Merchant_High: "Merchant",
  Assassin: "Thief", Rogue: "Thief", Assassin_Cross: "Thief", Stalker: "Thief", Thief_High: "Thief", Novice_High: "Novice",
};
export const OUTFIT_TINT: Record<string, number> = {
  Knight: 210, Crusader: 40, Wizard: 260, Sage: 150, Hunter: 100, Bard: 300, Dancer: 330, Priest: 180, Monk: 20,
  Blacksmith: 340, Alchemist: 120, Assassin: 270, Rogue: 160,
};
const TRANS_OF: Record<string, string> = {
  Lord_Knight: "Knight", Paladin: "Crusader", High_Wizard: "Wizard", Professor: "Sage", Sniper: "Hunter", Clown: "Bard", Gypsy: "Dancer",
  High_Priest: "Priest", Champion: "Monk", Whitesmith: "Blacksmith", Creator: "Alchemist", Assassin_Cross: "Assassin", Stalker: "Rogue",
};
export const outfitOf = (job: string): string => {
  const base = OUTFIT_BASE[job];
  if (!base) return JOB_OUTFITS[job] ?? "novice";
  const plain = TRANS_OF[job] ?? job, trans = job in TRANS_OF || job.endsWith("_High");
  return `${outfitOf(base)}@${OUTFIT_TINT[plain] ?? 0}${trans ? "b" : ""}`;
};
/** Look.outfit -> the body sheet key and the tint (hue degrees, brighter). */
export function outfitParts(outfit: string): { body: string; hue: number; bright: boolean } {
  const m = outfit.match(/^([^@]+)@(\d+)(b?)$/);
  return m ? { body: m[1], hue: Number(m[2]), bright: m[3] === "b" } : { body: outfit, hue: 0, bright: false };
}

// equipment -> layer. Weapons by sub type -> attack animation family; armour by item id (only items with a layer sprite).
const WEAPON_FAMILY: Record<string, string> = {}; // every other weapon uses the one-handed slash until more attack sheets exist
/** 2.5.0: knuckles and katars are fought with the bare-hand (fist) sheet; every other new weapon type (Whip, Book, Musical, ...) uses the slash. */
const BARE_HAND_WEAPONS = new Set(["Knuckle", "Katar"]);
const GEAR_LAYER: Record<number, { slot: "shield" | "headgear" | "garment"; key: string }> = {
  2101: { slot: "shield", key: "guard" }, // Guard
  2220: { slot: "headgear", key: "hat" }, // Hat
  2501: { slot: "garment", key: "hood" }, // Hood
};

/** Layers shown for the worn items. `worn` = equipped item ids + their sub types. */
export function visualsOf(worn: { id: number; type: string; subType: string | null }[]) {
  const v = { weapon: null as string | null, shield: null as string | null, headgear: null as string | null, garment: null as string | null };
  for (const it of worn) {
    if (it.type === "Weapon") v.weapon = BARE_HAND_WEAPONS.has(it.subType ?? "") ? null : WEAPON_FAMILY[it.subType ?? ""] ?? "blade";
    const g = GEAR_LAYER[it.id];
    if (g) v[g.slot] = g.key;
  }
  return v;
}

export const MAX_SLOTS = 9; // 3 pages x 3, like the original character select
export const NAME_RE = /^[\p{L}\p{N}_ ]{2,16}$/u;
export const USERNAME_RE = /^[a-z0-9_]{4,24}$/;

/** Account + character payloads of the HTTP API (server/src/api.ts). */
export type CharacterSummary = {
  id: number; slot: number; name: string; job: string; level: number; jobLevel: number; exp: number; jobExp: number;
  str: number; agi: number; vit: number; int: number; dex: number; luk: number;
  hp: number; maxHp: number; sp: number; maxSp: number; gender: Gender; hair: number; style: number;
  look: Look; // incl. worn gear, for previews
  /** The map the character stands on (char.last_map): the client joins that map's room. */
  map?: string;
};
export type LoginResponse = { token: string; username: string };
