// The API an NPC script is written against: rAthena's script commands (doc/script_commands.txt) as methods of `s`, with
// the same names and the same behaviour (server/src/script.ts runs them, one script per player at a time, server-side).
// Porting an rAthena NPC is mechanical:
//
//   mes "[Lio]"; mes "Hello!"; next;          await s.next() after s.mes("[Lio]", "Hello!")
//   switch (select("A:B")) { case 1: ... }    switch (await s.select("A", "B")) { case 1: ... }
//   if (countitem(909) >= 10) { delitem 909,10; ... }   if (s.countitem("Gel Bead") >= 10) { s.delitem("Gel Bead", 10); ... }
//   close;  close2;  end;                     await s.close();  await s.close2();  s.end();
//   set f1_guide, 1;  Zeny += 100;            s.set("f1_guide", 1);  s.set("Zeny", s.get("Zeny") + 100);
//   emotion ET_SURPRISE;                      s.emotion(ET.SURPRISE)   (ET_* / BC_* / CALLSHOP from shared/rules/script.ts)
//   npctalk "Hi!", "", bc_self;               s.npctalk("Hi!", "", BC.SELF)
//   percentheal 100,0;  heal 50,0;            s.percentheal(100, 0);  s.heal(50, 0);
//   close2; callshop "shop_x",1; end;         await s.close2(); s.callshop("shop_x", CALLSHOP.BUY); s.end();
//   OnTouch:  (an NPC with a trigger area)    NpcDef.trigger + NpcDef.onTouch (runs like a click, see NpcDef)
//
// Rules of the road (same as rAthena): a dialog needs a button before it can end (`close` / `close2` / `close3`; a script
// that just returns closes the window for you); `close`, `close3`, `end`, a cancelled `select` and anything that ends the
// session (death, logout, the 60 s idle timeout) unwind the script by throwing — never catch errors inside a script.
// Game-state commands (getitem, setquest, getexp ...) apply at once and are saved through the character's write chain.
import type { QuestCheckType } from "../rules/quest.ts";
import type { JobKey } from "../rules/data.ts";
import type { EquipSlot } from "../rules/items.ts";
import type { CallshopOption, CutinType, QMark, QType } from "../rules/script.ts";

/** An item by id or by our item name (shared/data/items.json; a name shared by two rows means the lower id). */
export type ItemRef = number | string;

/** One player's running NPC script (rAthena: the script_state attached to the player, sd->st / sd->npc_id). */
export interface Script {
  /** The NPC running the script (strnpcinfo). */
  readonly npc: { readonly id: string; readonly name: string };

  // ---- dialog (buildin_mes / next / close / close2 / close3 / clear / end / select / prompt / cutin) ----
  /** Append lines to the dialog window, opening it (clif_scriptmes). ^RRGGBB colours, <NAVI>..</NAVI> and <ITEM>..</ITEM>
   *  links work like in RO. */
  mes(...lines: string[]): void;
  /** Show Next and wait for it; the next mes starts a new page. Without an open dialog it does nothing (rAthena warns). */
  next(): Promise<void>;
  /** Show Close; the script ends when the player clicks it. */
  close(): Promise<never>;
  /** Show Close; the window closes on the click and the script goes on (no dialog any more). */
  close2(): Promise<void>;
  /** close + the cutin is cleared on the click. */
  close3(): Promise<never>;
  /** Clear the dialog text and go on (clif_scriptclear). */
  clear(): void;
  /** Stop the script now. */
  end(): never;
  /** Menu: options are arguments, "A:B" groups count as several, empty ones are hidden but numbered. Returns the 1-based
   *  index (also in @menu). Cancel ends the script. */
  select(...options: string[]): Promise<number>;
  /** Like select, but Cancel returns 255 and the script goes on. */
  prompt(...options: string[]): Promise<number>;
  /** Show an illustration (client/public/art/cutin/<image>.png) at a screen position (CUTIN.*); "" + CUTIN.CLEAR clears. */
  cutin(image: string, type: CutinType): void;

  // ---- the NPC in the world (buildin_emotion / buildin_npctalk) ----
  /** emotion <e>{,<target>}: an emotion bubble (ET.*) over the NPC, or over `target` (a game id: playerattached() or an NPC id),
   *  seen by the players around it. An unknown emotion is refused (script warning). */
  emotion(type: number, target?: string): void;
  /** npctalk "<message>"{,"<NPC id>",<flag>{,<color>}}: the NPC (or the NPC `npc`, "" = this one) says a line over its head and
   *  in the chat log, to BC.AREA (default) / BC.SELF (the attached player) / BC.MAP / BC.ALL; colour 0xRRGGBB, white by default. */
  npctalk(message: string, npc?: string, flag?: number, color?: number): void;
  /** playerattached(): the game id of the attached player (an emotion target). */
  playerattached(): string;

  // ---- the character ----
  /** strcharinfo(0): the character's name. */
  strcharinfo(type: 0): string;
  /** A variable: "@name" temporary (until logout), a plain name permanent (char_reg_num), or a character param:
   *  Zeny, BaseLevel, JobLevel, BaseExp, JobExp, StatusPoint, SkillPoint, Hp, MaxHp, Sp, MaxSp, Weight, MaxWeight, Class / BaseJob
   *  (the job id: Job_Novice 0, Job_Swordman 1 ... Job_Thief 6, shared/content/functions.ts JOB). Unset = 0. */
  get(name: string): number;
  /** Set a variable (0 deletes a permanent one, like rAthena) or Zeny (pc_setparam SP_ZENY). */
  set(name: string, value: number): void;
  /** countitem: how many the inventory holds (equipped pieces included). */
  countitem(item: ItemRef): number;
  /** checkweight(item, amount {, item, amount ...}): true when all of them fit at once (weight, stack size, free slots). */
  checkweight(item: ItemRef, amount: number, ...more: (ItemRef | number)[]): boolean;
  /** getitem: add to the inventory; false (and the player is told) when it doesn't fit, like clif_additem's fail. */
  getitem(item: ItemRef, amount: number): boolean;
  /** delitem: remove; when the player has fewer, the dialog closes and the script ends (buildin_delitem). */
  delitem(item: ItemRef, amount: number): void;
  /** getexp: Base / Job EXP through pc_gainexp (level ups included), shown as a quest reward. */
  getexp(base: number, job: number): void;
  /** heal <hp>,<sp>: heal by those amounts (capped at the max; the player sees the numbers); a negative amount is damage and can
   *  kill. Nothing for a dead character. */
  heal(hp: number, sp: number): void;
  /** percentheal <hp>,<sp>: heal by that percent of MaxHP / MaxSP (no numbers shown); negative = lose that percent of the max,
   *  never below 1 HP except at -100 (kills). Rates are capped to +-100. */
  percentheal(hp: number, sp: number): void;
  /** isequipped(<item>{,<item>...}): true when every listed item is worn. */
  isequipped(...items: ItemRef[]): boolean;
  // ---- refining (script.cpp getequip* / successrefitem / failedrefitem; a part is a worn slot: "weapon", "armor", "headTop" ...) ----
  /** getequipisequiped(<part>): something is worn there. */
  getequipisequiped(part: EquipSlot): boolean;
  /** getequipisenableref(<part>): the worn piece can be refined at all (item_db Refineable). */
  getequipisenableref(part: EquipSlot): boolean;
  /** getequiprefinerycnt(<part>): the piece's +N (0 when nothing is worn). */
  getequiprefinerycnt(part: EquipSlot): number;
  /** getequipweaponlv(<part>): the weapon level of the worn piece (0 when it is no weapon). */
  getequipweaponlv(part: EquipSlot): number;
  /** getequiparmorlv(<part>): the armor level (0 when it is no armor). */
  getequiparmorlv(part: EquipSlot): number;
  /** getequipid(<part>): the worn item's id, 0 when nothing is worn. */
  getequipid(part: EquipSlot): number;
  /** getequipname(<part>): the worn item's name as the bag shows it ("+4 Double Sturdy Knife [3]"), "" when nothing is worn. */
  getequipname(part: EquipSlot): string;
  /** getequippercentrefinery(<part>): the chance, in percent, that the next refine succeeds (0 = can't be refined). */
  getequippercentrefinery(part: EquipSlot): number;
  /** getequiprefinecost(<part>, <REFINE_COST.ZENY | REFINE_COST.MATERIAL_ID>): the zeny fee / the ore's item id of the next refine. */
  getequiprefinecost(part: EquipSlot, info: 0 | 1): number;
  /** successrefitem(<part>): the piece gets +1 (saved at once); its status and look are recalculated. Returns the new level. */
  successrefitem(part: EquipSlot): number;
  /** failedrefitem(<part>): the piece is destroyed (removed with its cards). */
  failedrefitem(part: EquipSlot): void;

  // ---- jobs and skills (C04) ----
  /** getskilllv("<skill key>"): the level the character can use the skill at (pc_checkskill; 0 = not learned / not in its tree). */
  getskilllv(skill: string): number;
  /** basicskillcheck(): conf basic_skill_check (Basic Skill levels gate actions and the job change). */
  basicskillcheck(): boolean;
  /** jobchange <job>: pc_jobchange to rAthena's job key (Swordman ...): job level 1, skills kept, the equipment sweep. false = refused. */
  jobchange(job: JobKey): boolean;
  /** resetlvl 1 (pc_resetlvl type 1, 2.5.0): base / job level 1, EXP 0, every skill and skill point gone, stats 1; a High Novice gets
   *  100 status points. Only type 1 is supported. */
  resetlvl(type: 1): void;
  // ---- moving the player (buildin_warp / buildin_savepoint) ----
  /** warp "<map>",<x>,<y>: pc_setpos there (another map = the client changes rooms). The dialog is over: the script ends. */
  warp(map: string, x: number, y: number): never;
  /** savepoint "<map>",<x>,<y>: pc_setsavepoint: where the character respawns (and a Homing Feather leads). */
  savepoint(map: string, x: number, y: number): void;

  // ---- shops (buildin_callshop) ----
  /** callshop "<shop NPC id>"{,<option>}: open that shop's window for the player as if it had been clicked (CALLSHOP.MENU = buy and
   *  sell, BUY = the buy list, SELL = the sell list). The shop is usually a floating one (map "-"), usable from anywhere once
   *  opened. false (and a script warning) when it is not a shop. */
  callshop(name: string, option?: CallshopOption): boolean;

  // ---- quests (rules/quest.ts; quest ids from shared/content/quest_db.ts) ----
  setquest(id: number): void;
  completequest(id: number): void;
  erasequest(id: number): void;
  changequest(id: number, id2: number): void;
  /** -1 not held; HAVEQUEST: state; PLAYTIME / HUNTING: see rules/quest.ts questCheck. */
  checkquest(id: number, type?: QuestCheckType): number;
  /** 0 not started, 1 held, 2 completed. */
  isbegin_quest(id: number): number;
  /** Put an icon over this NPC for this player (QTYPE.*, QMARK.* minimap colour). */
  showevent(icon: QType, color?: QMark): void;
}

/** What a questinfo condition may read (rAthena evaluates the condition as a script expression for the player). */
export type QuestInfoView = Pick<Script, "countitem" | "get" | "checkquest" | "isbegin_quest" | "strcharinfo" | "isequipped" | "getskilllv">;

/** questinfo (doc/script_commands.txt): the first entry whose condition holds is shown over the NPC (re-checked on quest,
 *  item, level and map changes, pc_show_questinfo); none = no icon. */
export type QuestInfo = { icon: QType; color?: QMark; condition?: (v: QuestInfoView) => boolean };

export type NpcScript = (s: Script) => Promise<void>;

/** One NPC on a map (rAthena: an npc line "map,x,y,dir<TAB>script<TAB>Name<TAB>sprite,{...}" or a shop line). */
export type NpcDef = {
  id: string; // stable key (room state + client), e.g. "npc_guide"; also the name callshop takes (rAthena's unique NPC name)
  /** shared/data/spawns.txt map name, e.g. "f1_field01"; "-" = a floating NPC on no map (a shop that only callshop opens). */
  map: string;
  name: string;
  /** client/public/sprites/<sprite>.png (3 views); "" = FAKE_NPC: invisible, never sent to clients, and like rAthena's class-less
   *  NPCs (class_ < 0) usable from anywhere (npc_checknear always passes). */
  sprite: string;
  x: number; y: number;
  kind: "shop" | "script";
  script?: NpcScript; // kind "script": runs on a click
  /** kind "shop": the stock, each item at its own Buy price (rAthena "<item>:-1"). */
  shop?: ItemRef[];
  /** TriggerX / TriggerY: walking into the cells x +-x, y +-y runs `onTouch` once per entry (OnTouch); without `onTouch` the NPC is
   *  clicked instead (npc_touch_areanpc). A player busy with another script gets it queued (MAX_EVENTQUEUE). */
  trigger?: { x: number; y: number };
  /** The OnTouch label: runs for the player who walked in, like a click (a dialog may open; npctalk / emotion need none). */
  onTouch?: NpcScript;
  questinfo?: QuestInfo[];
};
