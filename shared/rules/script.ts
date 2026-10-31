// NPC dialog rules, re-implemented from rAthena (behaviour, not code):
//   src/map/script.cpp  buildin_mes / next / close / close2 / close3 / clear / menu / select / prompt / cutin,
//                       menu_countoptions (option groups "A:B", empty options), the @menu index,
//                       buildin_emotion / npctalk / heal / percentheal / isequipped / callshop
//   src/map/npc.cpp     npc_scriptcont (what a Next / menu / Close answer does in each script state), npc_click,
//                       npc_touch_areanpc / npc_touch_area_allnpc / npc_event_sub (OnTouch areas and the event queue)
//   src/map/clif.cpp    clif_parse_NpcSelectMenu (a choice must be 1..npc_menu or 255 = cancel), clif_cutin positions
//   src/map/pc.cpp      pc_percentheal; status.cpp status_percent_change / status_heal (the HP / SP arithmetic)
//   src/config/secure.hpp  SECURE_NPCTIMEOUT: an idle dialog is closed after 60 s (npc_secure_timeout_timer)
// The script runner (server/src/script.ts) applies these; NPC scripts (shared/content) are written against
// shared/content/api.ts with the same command names as rAthena's script language.

/** script_state->state values that matter for a player-attached dialog (script.hpp e_script_state). */
export type ScriptState = "RUN" | "STOP" | "RERUNLINE" | "CLOSE" | "END";

/** npc_scriptcont (npc.cpp:2292): the state after a Next / menu answer (closing = false) or a Close click (closing = true).
 *  closing: CLOSE -> END (close / close3), STOP -> RUN (close2 continues), anything else -> END;
 *  not closing: STOP -> RUN (next), RERUNLINE stays (the menu / select line re-runs with the choice), anything else -> END. */
export function scriptCont(state: ScriptState, closing: boolean): ScriptState {
  if (closing) return state === "STOP" ? "RUN" : "END";
  if (state === "STOP") return "RUN";
  if (state === "RERUNLINE") return "RERUNLINE";
  return "END";
}

/** menu_countoptions (script.cpp:5051): options in one menu argument ("A:B" = two, empty parts between ':' are skipped but
 *  numbered). count = shown options counted, stopping at the max_count-th one (0 = count all); total = how many indexes the
 *  argument used up to that point (each ':' and the argument itself add one), i.e. the running @menu. */
export function menuCountOptions(str: string, maxCount = 0, total = 0) {
  let count = 0, i = 0;
  total++;
  while (str[i] === ":") { i++; total++; }
  while (i < str.length) {
    count++;
    if (--maxCount === 0) break;
    while (i < str.length && str[i] !== ":") i++;
    while (str[i] === ":") { i++; total++; }
  }
  return { count, total };
}

/** What buildin_select / buildin_prompt send (ZC_MENU_LIST, script.cpp:5240): the arguments joined with ':' (a separator only
 *  once an option exists), and npc_menu = the number of options. The client shows the non-empty parts in order. */
export function menuBuild(args: readonly string[]) {
  let text = "", npcMenu = 0;
  for (const a of args) {
    if (npcMenu > 0) text += ":";
    text += a;
    npcMenu += menuCountOptions(a).count;
  }
  return { text, npcMenu, shown: text.split(":").filter((o) => o !== "") };
}

/** The index buildin_select / prompt return (and store in @menu) for the `choice`-th shown option (script.cpp:5284-5293):
 *  consistent with grouped and empty options, e.g. select("A::B", "", "C") -> A 1, B 3, C 5. */
export function menuSelect(args: readonly string[], choice: number) {
  let left = choice, menu = 0;
  for (const a of args) {
    const r = menuCountOptions(a, left, menu);
    menu = r.total;
    left -= r.count;
    if (left <= 0) break;
  }
  return menu;
}

/** CZ_CHOOSE_MENU answer value meaning Cancel (clif_parse_NpcSelectMenu). */
export const MENU_CANCEL = 255;
/** clif_parse_NpcSelectMenu (clif.cpp:13319): a uint8 choice in 1..npc_menu, or 255; anything else is a forged answer
 *  (rAthena kicks the player). */
export const menuChoiceValid = (choice: unknown, npcMenu: number) =>
  Number.isInteger(choice) && (choice as number) >= 1 && (choice as number) <= 255 && ((choice as number) <= npcMenu || choice === MENU_CANCEL);

/** clif_cutin types (clif.cpp:2735): where the illustration goes. */
export const CUTIN = { BOTTOM_LEFT: 0, BOTTOM_MIDDLE: 1, BOTTOM_RIGHT: 2, MIDDLE_WINDOW: 3, MIDDLE: 4, CLEAR: 255 } as const;
export type CutinType = (typeof CUTIN)[keyof typeof CUTIN];
/** Cutin file names: plain lowercase words (client/public/art/cutin/<name>.png); "" clears. */
export const cutinNameValid = (name: string) => name === "" || /^[a-z0-9_]{1,40}$/.test(name);

/** e_questinfo_types (script.hpp:405): the icon over an NPC's head (showevent / questinfo). */
export const QTYPE = {
  QUEST: 0, QUEST2: 1, JOB: 2, JOB2: 3, EVENT: 4, EVENT2: 5, CLICKME: 6, DAILYQUEST: 7, EVENT3: 8, JOBQUEST: 9, JUMPING_BLOB: 10,
  NONE: 9999,
} as const;
export type QType = (typeof QTYPE)[keyof typeof QTYPE];
/** e_questinfo_markcolor (script.hpp:423): the minimap mark colour. */
export const QMARK = { NONE: 0, YELLOW: 1, GREEN: 2, PURPLE: 3 } as const;
export type QMark = (typeof QMARK)[keyof typeof QMARK];
/** buildin_showevent (script.cpp:21170, PACKETVER >= 20120410): an invalid icon (< 0, 7, > 8 but not NONE) shows nothing, an
 *  invalid colour falls back to QMARK_NONE. */
export function showeventArgs(icon: number, color: number = QMARK.NONE) {
  const c = color < QMARK.NONE || color > QMARK.PURPLE ? QMARK.NONE : color;
  const i = icon < 0 || (icon > 8 && icon !== QTYPE.NONE) || icon === 7 ? QTYPE.NONE : icon;
  return { icon: i, color: c };
}

/** src/config/secure.hpp: an open dialog waiting for Next / a menu choice ends after this long without an answer
 *  (pc_close_npc(sd, 1): a Close button replaces it and the script ends), checked every SECURE_NPCTIMEOUT_INTERVAL. */
export const NPC_SECURE_TIMEOUT_NEXT = 60_000;
export const NPC_SECURE_TIMEOUT_MENU = 60_000;
export const SECURE_NPCTIMEOUT_INTERVAL = 1000;

/** The script engine's view of a character variable name (script.cpp set_reg / pc_setreg): "@x" = temporary character
 *  variable (lost on logout), a plain name = permanent character variable (char_reg_num); ".@x" / "$x" / "#x" scopes are
 *  TS locals or not supported here. Names: letters, digits, '_' (rAthena: up to 32 characters). */
export function varScope(name: string): "temp" | "char" | null {
  if (/^@[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(name)) return "temp";
  if (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)) return "char";
  return null;
}

// ---------- emotion / npctalk (clif_emotion, ZC_NPC_CHAT) ----------

/** e_emotion_type (clif.hpp:263): the emotion numbers `emotion` takes (ET_SURPRISE is the "!" bubble, ET_QUESTION the "?"). */
export const ET = {
  SURPRISE: 0, QUESTION: 1, DELIGHT: 2, THROB: 3, SWEAT: 4, AHA: 5, FRET: 6, ANGER: 7, MONEY: 8, THINK: 9,
  SCISSOR: 10, ROCK: 11, WRAP: 12, FLAG: 13, BIGTHROB: 14, THANKS: 15, KEK: 16, SORRY: 17, SMILE: 18, PROFUSELY_SWEAT: 19,
  SCRATCH: 20, BEST: 21, STARE_ABOUT: 22, HUK: 23, O: 24, X: 25, HELP: 26, GO: 27, CRY: 28, KIK: 29,
  CHUP: 30, CHUPCHUP: 31, HNG: 32, OK: 33, CHAT_PROHIBIT: 34, INDONESIA_FLAG: 35, STARE: 36, HUNGRY: 37, COOL: 38, MERONG: 39,
  SHY: 40, GOODBOY: 41, SPTIME: 42, SEXY: 43, COMEON: 44, SLEEPY: 45, CONGRATULATION: 46, HPTIME: 47,
  SPARK: 52, CONFUSE: 53, OHNO: 54, HUM: 55, BLABLA: 56, OTL: 57, LUV: 65, OOPS: 76, PANIC: 79,
} as const;
/** ET_MAX (clif.hpp:353): one past the last emotion. */
export const ET_MAX = 88;
/** buildin_emotion (script.cpp:13818): ET_SURPRISE <= type < ET_MAX, anything else is refused with a warning. */
export const emotionValid = (type: unknown): type is number => Number.isInteger(type) && (type as number) >= ET.SURPRISE && (type as number) < ET_MAX;

/** e_broadcast_flags (clif.hpp:245) as npctalk's <flag> takes them. */
export const BC = { ALL: 0, MAP: 1, AREA: 2, SELF: 3 } as const;
/** Who an npctalk line reaches (buildin_npctalk, script.cpp:16193): bc_all -> ALL_CLIENT, bc_map -> ALL_SAMEMAP, bc_self -> SELF
 *  (the attached player), bc_area and anything else (the default) -> AREA around the NPC. */
export function npctalkTarget(flag: number = BC.AREA): "all" | "map" | "self" | "area" {
  switch (flag) {
    case BC.ALL: return "all";
    case BC.MAP: return "map";
    case BC.SELF: return "self";
    default: return "area";
  }
}
/** npctalk's default colour (0xFFFFFF) and the ZC_NPC_CHAT message size: CHAT_SIZE_MAX (255) less the terminator. */
export const NPCTALK_COLOR = 0xffffff;
export const CHAT_SIZE_MAX = 255;

// ---------- heal / percentheal (status_heal, pc_percentheal -> status_percent_change) ----------

/** What a script HP / SP change does to the character: the signed change of each and whether it kills. */
export type HpSpChange = { hp: number; sp: number; kill: boolean };
type HpSp = { hp: number; maxHp: number; sp: number; maxSp: number };

/** utils.hpp apply_rate on integers: `val * rate / 100`, or `val / 100 * rate` above 100000 (C integer division). */
const applyRate = (val: number, rate: number) => (rate === 100 ? val : val > 100000 ? Math.trunc(val / 100) * rate : Math.trunc((val * rate) / 100));

/** buildin_heal (script.cpp:6007) -> status_heal(sd, hp, sp, flag 1) (status.cpp:1803): nothing for a dead character (hp 0);
 *  a negative part is status_damage (which can kill), a positive part is capped at max - current. */
export function scriptHeal(c: HpSp, hp: number, sp: number): HpSpChange {
  if (c.hp <= 0) return { hp: 0, sp: 0, kill: false };
  let dhp = 0, dsp = 0, kill = false;
  if (hp < 0) { dhp = -Math.min(c.hp, -hp); kill = dhp === -c.hp; }
  else if (hp > 0) dhp = Math.min(hp, c.maxHp - c.hp);
  if (sp < 0) dsp = -Math.min(c.sp, -sp);
  else if (sp > 0) dsp = Math.min(sp, c.maxSp - c.sp);
  return { hp: dhp, sp: dsp, kill };
}

/** status_percent_change's amount for one part (status.cpp:1905): a positive rate is a percent of the CURRENT value, a negative one
 *  of the MAX; beyond +-99 it is all of it; a non-zero rate moves at least 1. */
function percentAmount(rate: number, cur: number, max: number) {
  let v = 0;
  if (rate > 99) v = cur;
  else if (rate > 0) v = applyRate(cur, rate);
  else if (rate < -99) v = max;
  else if (rate < 0) v = applyRate(max, -rate);
  if (rate && !v) v = 1;
  return v;
}

/** pc_percentheal (pc.cpp) with the RENEWAL / status-change exceptions left out: rates are capped to +-100; both >= 0 heal
 *  (status_percent_heal: that percent of the MAX, capped at max - current), both <= 0 damage (status_percent_damage: that percent of
 *  the MAX; only -100 HP may kill, otherwise at least 1 HP is left), mixed signs do each part on its own. A dead character gets
 *  nothing (status_heal / status_damage on hp 0). */
export function percentHeal(c: HpSp, hpRate: number, spRate: number): HpSpChange {
  const hr = Math.max(-100, Math.min(100, Math.trunc(hpRate))), sr = Math.max(-100, Math.min(100, Math.trunc(spRate)));
  if (c.hp <= 0) return { hp: 0, sp: 0, kill: false };
  // status_percent_heal(sd, hp, sp) = status_percent_change(-hp, -sp, flag 0): a percent of the max, then status_heal caps it
  const heal = (rate: number, cur: number, max: number) => Math.min(percentAmount(-rate, cur, max), max - cur);
  // status_percent_damage(sd, hp, sp, kill) = status_percent_change(hp, sp, flag kill ? 1 : 2); flag 2 keeps 1 HP
  const damageHp = (rate: number) => {
    let v = percentAmount(rate, c.hp, c.maxHp);
    if (rate !== -100 && v >= c.hp) v = c.hp - 1;
    return v;
  };
  let hp = 0, sp = 0;
  if (hr > 0) hp = heal(hr, c.hp, c.maxHp);
  else if (hr < 0) hp = -Math.min(c.hp, damageHp(hr));
  if (sr > 0) sp = heal(sr, c.sp, c.maxSp);
  else if (sr < 0) sp = -Math.min(c.sp, percentAmount(sr, c.sp, c.maxSp));
  return { hp, sp, kill: hr === -100 && -hp >= c.hp };
}

// ---------- isequipped / callshop ----------

/** buildin_isequipped (script.cpp:16777) for plain items (no cards yet): true when every listed item id (> 0) is worn; ids <= 0 are
 *  skipped. `worn` = the item ids of the equipped pieces (sd->equip_index). */
export function isequippedIds(worn: readonly number[], ids: readonly number[]): boolean {
  let ret: boolean | undefined;
  for (const id of ids) {
    if (!(id > 0)) continue;
    ret = (ret ?? true) && worn.includes(id);
    if (!ret) break;
  }
  return ret ?? false;
}

/** callshop's <option> (buildin_callshop, script.cpp:18172): 0 = the Buy / Sell / Cancel choice (clif_npcbuysell), 1 = the buy list
 *  (npc_buysellsel type 0), 2 = the sell list (type 1). Any other value is treated as 0. */
export const CALLSHOP = { MENU: 0, BUY: 1, SELL: 2 } as const;
export type CallshopOption = (typeof CALLSHOP)[keyof typeof CALLSHOP];
export const callshopOption = (o: unknown): CallshopOption => (o === 1 || o === 2 ? o : 0);

// ---------- OnTouch areas (npc_touch_areanpc / npc_touch_area_allnpc / npc_event_sub) ----------

/** MAX_EVENTQUEUE (map.hpp:73): OnTouch events a player can have queued while another script runs (more are dropped). */
export const MAX_EVENTQUEUE = 2;
/** npc_event_dequeue (npc.cpp:1176): a queued event runs this long after the running script ended (pc_addeventtimer 100). */
export const EVENTQUEUE_DELAY = 100;
/** The trigger area of an NPC: "TriggerX,TriggerY" cells in every direction from its cell (doc/script_commands.txt "TriggerX"). */
export type TouchArea = { x: number; y: number; xs: number; ys: number };
/** npc_touch_areanpc (npc.cpp:1896-1937): is the cell inside the area x-xs..x+xs, y-ys..y+ys? (No area when xs or ys < 0.) */
export const inTouchArea = (a: TouchArea, x: number, y: number) =>
  a.xs >= 0 && a.ys >= 0 && x >= a.x - a.xs && x <= a.x + a.xs && y >= a.y - a.ys && y <= a.y + a.ys;

/**
 * npc_touch_area_allnpc (npc.cpp:1958) for a player who has just entered cell (x, y), with OnTouch (not OnTouch_) semantics:
 *  - `inside` (sd->areanpc) first drops every NPC whose area no longer holds the cell;
 *  - each NPC whose area holds the cell and that is not in `inside` yet is added and its event fires (npc_ontouch2_event ->
 *    npc_event(..., 2)); an NPC the player was already inside of does nothing.
 * Returns the NPC ids whose OnTouch fires now, in map order. `inside` is updated in place.
 */
export function touchAreas(areas: readonly (TouchArea & { id: string })[], inside: Set<string>, x: number, y: number): string[] {
  for (const id of [...inside]) {
    const a = areas.find((n) => n.id === id);
    if (!a || !inTouchArea(a, x, y)) inside.delete(id);
  }
  const fire: string[] = [];
  for (const a of areas) {
    if (!inTouchArea(a, x, y) || inside.has(a.id)) continue;
    inside.add(a.id);
    fire.push(a.id);
  }
  return fire;
}
