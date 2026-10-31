// Quest tasks: the "do this" steps of our quests that are not kills (rAthena's quest_db only counts kills; its NPC scripts check
// everything else when you talk to them: Instructor Brade's isequipped(...) in npc/re/jobs/novice/novice.txt, the Academy staff's
// "drink the apple juice I gave you" countitem(531) check in academy.txt). A task names the same check, so the NPC script
// (functions.ts tasksDone), the questinfo "?" condition and the client's tracker / quest window all read one definition:
// the script decides, the others only display it.
import type { ItemRef } from "./api.ts";

export type QuestTask = { Text: string } & (
  | { StatusPoint: { Below: number } } // spend status points until fewer than Below are left (Alt+A)
  | { Equip: ItemRef } // wear the item (isequipped)
  | { Use: ItemRef } // use the item up (countitem == 0), e.g. from the shortcut bar
  | { HpFull: true } // HP back to MaxHP (sit down with Insert to recover twice as fast)
  | { Visit: { Map: string; X: number; Y: number } } // walk into a place: an OnTouch area completes the quest there
  | { BaseLevel: number } // reach this base level
  | { JobLevel: number } // reach this job level
  | { Skill: { Key: string; Level: number } } // learn a skill to this level (Alt+S; getskilllv), Key = rAthena's skill key
);

/** What a task check reads about the character (the server's script / questinfo view and the client's own snapshots). */
export type TaskView = {
  statusPoint: number; baseLevel: number; hp: number; maxHp: number;
  jobLevel?: number; skillLv?: (key: string) => number; // C04: JobLevel / Skill tasks (0 when a view doesn't know them)
  countitem: (item: ItemRef) => number;
  isequipped: (item: ItemRef) => boolean;
};

/** Progress of one task: have / need (shown "have/need" in the tracker) and done. A Visit is never done here: the place's OnTouch
 *  script completes the quest itself. */
export function taskProgress(t: QuestTask, v: TaskView): { have: number; need: number; done: boolean } {
  const flag = (done: boolean) => ({ have: done ? 1 : 0, need: 1, done });
  if ("StatusPoint" in t) return flag(v.statusPoint < t.StatusPoint.Below);
  if ("Equip" in t) return flag(v.isequipped(t.Equip));
  if ("Use" in t) return flag(v.countitem(t.Use) === 0);
  if ("HpFull" in t) return { have: v.hp, need: v.maxHp, done: v.maxHp > 0 && v.hp >= v.maxHp };
  if ("BaseLevel" in t) return { have: Math.min(v.baseLevel, t.BaseLevel), need: t.BaseLevel, done: v.baseLevel >= t.BaseLevel };
  if ("JobLevel" in t) { const j = v.jobLevel ?? 0; return { have: Math.min(j, t.JobLevel), need: t.JobLevel, done: j >= t.JobLevel }; }
  if ("Skill" in t) { const l = v.skillLv?.(t.Skill.Key) ?? 0; return { have: Math.min(l, t.Skill.Level), need: t.Skill.Level, done: l >= t.Skill.Level }; }
  return flag(false);
}

export const tasksDone = (tasks: readonly QuestTask[] | undefined, v: TaskView) => (tasks ?? []).every((t) => taskProgress(t, v).done);
