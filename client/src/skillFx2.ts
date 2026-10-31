// 2.5.0: effects of the 2nd-job skill kinds (shared/rules/skills2.ts), reusing skillFx.ts by element / kind: ground units and traps
// light their cell (every wave sends its own skillUse), splashes ring the target or the caster, party buffs / spheres glow on the
// caster, Hawk Dive is a shot, Sanctuary heals. main.ts onSkillUse asks this first; false = the old switch handles it.
import * as THREE from "three";
import type { SkillFx } from "./skillFx.ts";
import { SKILL_USE, skillHits, type Skill } from "../../shared/rules/skill.ts";
import type { SkillUseEvent } from "../../shared/protocol.ts";

type Pos = { obj: THREE.Object3D };
export function skillFx2(fx: SkillFx, s: Skill, m: SkillUseEvent, src: Pos, tgt: Pos | undefined, cell: THREE.Vector3 | undefined, ele: string | undefined,
  splash: number, pop: (t: Pos, text: string) => void): boolean {
  const use = SKILL_USE[s.key];
  if (!use) return false;
  switch (use.kind) {
    case "aura": case "spheres": fx.heal(src.obj.position); return true;
    case "selfMagic": fx.ground(src.obj.position, ele, splash || 2); return true;
    case "selfSplash": if (s.key.startsWith("SM_")) return false; fx.ground(src.obj.position, ele, splash || 2); return true;
    case "targetSplash": if (tgt) { fx.strike(tgt.obj.position, ele); fx.ground(tgt.obj.position, ele, splash || 1); } return true;
    case "groundMagic": if (cell) fx.ground(cell, ele, splash || 2); return true;
    case "trap": if (cell) fx.ground(cell, ele, 1); return true;
    case "misc": if (tgt) fx.shot(src.obj.position, tgt.obj.position, ele, Math.min(5, skillHits(s, m.lv))); return true;
    case "turnUndead": if (tgt) fx.strike(tgt.obj.position, "Holy"); return true;
    case "resurrect": case "pitcher": if (tgt) { fx.heal(tgt.obj.position); if (m.heal) pop(tgt, `+${m.heal}`); } return true;
    case "unit":
      if (use.hit === "heal") { if (tgt) { fx.heal(tgt.obj.position); if (m.heal) pop(tgt, `+${m.heal}`); } else if (cell) fx.ground(cell, "Holy", use.radius); return true; }
      if (cell) fx.ground(cell, ele, use.hit === "meteor" ? 1 : use.radius, false);
      else fx.ground(src.obj.position, ele, use.radius);
      return true;
    default: return false;
  }
}
