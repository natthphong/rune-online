// Character appearance, RO style paper doll: a HEADLESS body per gender + job outfit (the job decides the clothes), a head per
// hair style (face + dyeable hair), plus sprites for the worn weapon / headgear / garment / shield, all pinned to the body's
// per-frame anchors (client/src/paperdoll.ts; sprites in public/sprites/pd, built by tools/art/pd_build.py).
// Server validates creation choices against these lists.
export const GENDERS = ["M", "F"] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABEL: Record<Gender, string> = { M: "Male", F: "Female" };
/** Hair dyes (index stored in characters.hair_color); applied by multiplying the grey hair mask. */
export const HAIR_COLORS = ["#7a4a2a", "#3a2a24", "#f2cf72", "#e0543e", "#ff9ec4", "#5b8ff0", "#59c27a", "#e9e6f2", "#b07ae0"] as const;
export const HAIR_LABEL = ["Chestnut", "Raven", "Golden", "Crimson", "Blossom", "Azure", "Fern", "Silver", "Violet"] as const;

/** Hair styles (index stored in characters.hairdo). Each is a head sprite per gender, `sprites/pd/head_<G>_<key>` (key "" =
 *  "classic"): the face and the hair are one sprite, dyed through its hair mask. */
export const HAIR_STYLES = [
  { key: "", label: "Classic" }, { key: "ponytail", label: "Ponytail" }, { key: "twintails", label: "Twin Tails" },
  { key: "long", label: "Long" }, { key: "topknot", label: "Topknot" }, { key: "braid", label: "Braid" },
] as const;

/** What a character looks like. Built from the character + equipped items (visualsOf). */
export type Look = {
  gender: Gender; hair: number; outfit: string;
  style?: number; // hair style, index into HAIR_STYLES (absent = 0)
  weapon?: string | null; // weapon sprite key ("sword", "bow", ...: WEAPON_SPRITE); null = bare hands
  shield?: string | null; headgear?: string | null; garment?: string | null; // gear layer sheet keys
  job?: string; // rAthena job key: picks the body (pdBodyOf)
};

/** `Player.outfit` / `Look.outfit`: the public outfit string of a job, `<body>` or `<body>@<hue>[b]` (kept for the synced state and
 *  the job bots; the client draws from Look.job through pdBodyOf, which shares the tables below). */
export const JOB_OUTFITS: Record<string, string> = { Swordman: "swordman" };
/** 2.5.0: the 2nd jobs and the transcendent line wear their first job's body recoloured until their own art exists: the hue
 *  turns by `OUTFIT_TINT[job]` degrees (cloth only: client/src/paperdoll.ts tintBody; the head is a separate sprite, so no face
 *  can change colour), and a transcendent job adds "b" = brighter, more saturated cloth. */
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

/** PAPER DOLL (client/src/paperdoll.ts): the headless body a job wears. Every first job has its own outfit; a 2nd / transcendent
 *  job wears its first job's body with the cloth turned by OUTFIT_TINT degrees until it has art of its own. */
export const PD_BODY: Record<string, string> = {
  Novice: "novice", Swordman: "swordman", Archer: "archer", Mage: "mage", Acolyte: "acolyte", Thief: "thief", Merchant: "merchant",
};
/** Bodies whose art is complete for BOTH genders and has passed tools/art/pd_check.py. shared/rules/paperdoll.test.ts checks every
 *  file a shipped body needs (and that every starting job is shipped); a job missing here would wear the Fledgling's body. */
export const PD_SHIPPED: readonly string[] = ["novice", "swordman", "archer", "mage", "acolyte", "thief", "merchant"];
export function pdBodyOf(job: string): { body: string; hue: number; bright: boolean } {
  const base = OUTFIT_BASE[job];
  if (!base) return { body: PD_BODY[job] ?? "novice", hue: 0, bright: false };
  const plain = TRANS_OF[job] ?? job;
  return { body: PD_BODY[base] ?? "novice", hue: OUTFIT_TINT[plain] ?? 0, bright: job in TRANS_OF || job.endsWith("_High") };
}

// equipment -> what is drawn. Weapon: the sprite of its family (`sprites/pd/weapon_<key>`, held on the body's hand anchor; the old
// sheets only read it as "armed"); an item id may get a sprite of its own in WEAPON_ITEM. Armour by item id.
const WEAPON_SPRITE: Record<string, string> = {
  Dagger: "dagger", "1hSword": "sword", "2hSword": "sword", "1hSpear": "sword", "2hSpear": "sword", "1hAxe": "axe", "2hAxe": "axe",
  Mace: "mace", Staff: "rod", "2hStaff": "rod", Bow: "bow", Book: "mace", Whip: "sword", Musical: "bow",
};
const WEAPON_ITEM: Record<number, string> = { 1201: "knife" }; // the Fledgling's Knife
/** 2.5.0: knuckles and katars are fought with bare hands (no weapon sprite). */
const BARE_HAND_WEAPONS = new Set(["Knuckle", "Katar"]);
/** The weapon a starting job holds in the Make Character preview (shared/rules/jobstart.ts kit). */
export const START_WEAPON: Record<string, string> = { Novice: "knife", Swordman: "sword", Archer: "bow", Mage: "rod", Acolyte: "mace", Thief: "dagger", Merchant: "axe" };
const GEAR_LAYER: Record<number, { slot: "shield" | "headgear" | "garment"; key: string }> = {
  2101: { slot: "shield", key: "guard" }, // Guard
  2220: { slot: "headgear", key: "hat" }, // Hat
  2501: { slot: "garment", key: "hood" }, // Hood
};

/** Layers shown for the worn items. `worn` = equipped item ids + their sub types. */
export function visualsOf(worn: { id: number; type: string; subType: string | null }[]) {
  const v = { weapon: null as string | null, shield: null as string | null, headgear: null as string | null, garment: null as string | null };
  for (const it of worn) {
    if (it.type === "Weapon") v.weapon = BARE_HAND_WEAPONS.has(it.subType ?? "") ? null : WEAPON_ITEM[it.id] ?? WEAPON_SPRITE[it.subType ?? ""] ?? "sword";
    const g = GEAR_LAYER[it.id];
    if (g) v[g.slot] = g.key;
  }
  return v;
}

/** The job a new character may start as (Make Character's job cards, POST /api/characters `job`): the Fledgling (the default, the
 *  old path) or a first job. The skills and the weapon each one starts with are shared/rules/jobstart.ts (server only). */
export const START_JOBS = ["Novice", "Swordman", "Archer", "Mage", "Acolyte", "Thief", "Merchant"] as const;
export type StartJob = (typeof START_JOBS)[number];
export const isStartJob = (j: unknown): j is StartJob => (START_JOBS as readonly unknown[]).includes(j);
/** The POST /api/characters request of the Make Character screen: the screen and the `create` bot both build it here. */
export type CreateDraft = { slot: number; name: string; gender: string; hair: number; style?: number; job?: string };
export const createRequest = (d: CreateDraft) => ({
  method: "POST" as const, path: "/characters",
  body: { slot: d.slot, name: d.name, gender: d.gender, hair: d.hair, ...(d.style === undefined ? {} : { style: d.style }), ...(d.job && d.job !== "Novice" ? { job: d.job } : {}) },
});
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
