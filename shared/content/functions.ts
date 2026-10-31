// Shared script functions (rAthena: npc/other/Global_Functions.txt, called with callfunc "F_..."). Plain functions over
// the Script API, usable from any NPC script.
import type { QuestInfoView, Script } from "./api.ts";
import { QUEST_INFO } from "./quest_db.ts";
import { tasksDone, type TaskView } from "./tasks.ts";

/** checkweight over every reward item of quest `id` at once (buildin_checkweight with several pairs). */
export function canCarryRewards(s: Script, id: number): boolean {
  const items = QUEST_INFO.get(id)?.RewardItems ?? [];
  if (!items.length) return true;
  const [first, ...rest] = items;
  return s.checkweight(first.Item, first.Count, ...rest.flatMap((r) => [r.Item, r.Count]));
}

/** Pay the rewards listed in quest `id`'s Info (what the quest window promised): getexp, Zeny, getitem. */
export function questReward(s: Script, id: number) {
  const r = QUEST_INFO.get(id);
  if (!r) return;
  if (r.RewardEXP || r.RewardJEXP) s.getexp(r.RewardEXP ?? 0, r.RewardJEXP ?? 0);
  if (r.RewardZeny) s.set("Zeny", s.get("Zeny") + r.RewardZeny);
  for (const it of r.RewardItems ?? []) s.getitem(it.Item, it.Count);
}

/** The character as quest tasks read it (shared/content/tasks.ts), from a script or a questinfo condition. */
export const taskView = (v: QuestInfoView): TaskView => ({
  statusPoint: v.get("StatusPoint"), baseLevel: v.get("BaseLevel"), hp: v.get("Hp"), maxHp: v.get("MaxHp"),
  countitem: (item) => v.countitem(item), isequipped: (item) => v.isequipped(item),
  jobLevel: v.get("JobLevel"), skillLv: (key) => v.getskilllv(key),
});

/** Every task of quest `id` (Info.Tasks) is done: what the reporting NPC checks before completing it. */
export const questTasksDone = (v: QuestInfoView, id: number) => tasksDone(QUEST_INFO.get(id)?.Tasks, taskView(v));

/** The quest is held and its kill objectives are complete and every item of Info.Items is carried and every task is done:
 *  ready to report (quest_check HUNTING == 2 + countitem + the tasks). */
export function questReady(v: QuestInfoView, id: number): boolean {
  if (v.isbegin_quest(id) !== 1 || v.checkquest(id, "HUNTING") !== 2) return false;
  for (const it of QUEST_INFO.get(id)?.Items ?? []) if (v.countitem(it.Item) < it.Count) return false;
  return questTasksDone(v, id);
}
