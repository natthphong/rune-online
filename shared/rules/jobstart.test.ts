// A character made with a first job (Make Character): every starter skill is learnable at Job Lv 1 / Base Lv 1 right after Basic
// Training 9, implemented (not a "coming later" row), the kit equals the guild master's gift, and the bar holds the skills first.
import test from "node:test";
import assert from "node:assert/strict";
import { MASTERS } from "../content/f1/jobs.ts";
import type { FirstJob } from "./data.ts";
import { hotkeyList, hotkeySkill } from "./hotkey.ts";
import { JOB_START, startHotkeys, startSkillRows } from "./jobstart.ts";
import { START_JOBS, createRequest } from "../look.ts";
import { SKILL_ID, skillReady, skillUpBlock } from "./skill.ts";
import { ITEMS, equipBlock } from "./items.ts";
import { itemNamed } from "./quest.ts";

test("every first job has a start, and 3 starter skill levels", () => {
  assert.deepEqual(Object.keys(JOB_START).sort(), START_JOBS.filter((j) => j !== "Novice").sort());
  for (const [job, st] of Object.entries(JOB_START)) assert.equal(st.skills.reduce((n, [, l]) => n + l, 0), 3, job);
});

test("the starter skills can be learned in order at level 1 and are implemented", () => {
  for (const job of Object.keys(JOB_START) as FirstJob[]) {
    const learned: Record<number, number> = {};
    for (const [id, lv] of startSkillRows(job)) {
      for (let i = 0; i < lv; i++) {
        assert.equal(skillUpBlock(job, learned, JOB_START[job].level, 1, 99, id), null, `${job} skill ${id} level ${i + 1}`);
        learned[id] = (learned[id] ?? 0) + 1;
      }
    }
    for (const [key] of JOB_START[job].skills) assert.ok(skillReady(SKILL_ID[key]), `${job}: ${key} is not implemented yet`);
  }
});

test("the kit is wearable at the start level, in the guild master's weapon family", () => {
  for (const m of MASTERS) {
    const st = JOB_START[m.job], weapon = (list: { item: string }[]) => ITEMS.get(itemNamed(list[0].item)!.id)!;
    assert.equal(weapon(st.kit).subType, weapon(m.kit).subType, `${m.job}: weapon family`);
    for (const k of st.kit.filter((x) => ITEMS.get(itemNamed(x.item)!.id)!.type === "Weapon")) assert.equal(equipBlock(ITEMS.get(itemNamed(k.item)!.id)!, m.job, st.level, "Fist"), null, `${m.job}: ${k.item} at Base Lv ${st.level}`);
  }
});

test("the bar starts with the skills and survives hotkeyList", () => {
  for (const job of Object.keys(JOB_START) as FirstJob[]) {
    const keys = hotkeyList(startHotkeys(job));
    JOB_START[job].skills.forEach(([k, lv], i) => assert.deepEqual(hotkeySkill(keys[i]), { id: SKILL_ID[k], lv }, `${job} F${i + 1}`));
  }
});

test("the create request: a Fledgling sends no job, a first job sends it", () => {
  const base = { slot: 0, name: "Ann", gender: "F", hair: 1, style: 2 };
  assert.equal("job" in createRequest({ ...base, job: "Novice" }).body, false);
  assert.equal(createRequest({ ...base, job: "Mage" }).body.job, "Mage");
});
