// Stand-in art (W03): species already placed in the world (shared/data/spawns.txt) whose own sprite sheets the art queue has not
// drawn yet (.cache/loop/c14_progress.md, the Codex retry script fills client/public/sprites/anim). Until a species' own
// mob_<id>_move / _act (or its static mob_<id> strip) exists, the client draws it with the art of a look-alike species at the
// species' own size (main.ts addEntity -> AnimSprite `standin`), so no monster is ever invisible. A species' own art always wins
// once it lands; shared/rules/content.test.ts only lets a placed species without art pass when it has a stand-in here whose art
// exists. Drop a row once its species' sheets are in.
export const ART_STANDIN: Record<number, number> = {
};
// 2.7.0 the Tower's own species (shared/floor3.ts F3_MOBS) are drawn with the sheets of the species named by their row's `art`
// (default: the `base` row they are built from), multiplied by the row's `tint` and scaled by its `scale`, until their own sheets
// (mob_<id>_move / _act) are drawn. The client asks these three for every monster it draws.
import { F3_MOB_BY_ID } from "./floor3.ts";
/** The species whose sprite sheets draw monster `id`. */
export const artOf = (id: number): number => ART_STANDIN[id] ?? F3_MOB_BY_ID.get(id)?.art ?? F3_MOB_BY_ID.get(id)?.base ?? id;
/** 0xRRGGBB multiplied over the sprite (0xffffff = as painted) and the sprite's extra scale. */
export const tintOf = (id: number): number => F3_MOB_BY_ID.get(id)?.tint ?? 0xffffff;
export const scaleOf = (id: number): number => F3_MOB_BY_ID.get(id)?.scale ?? 1;
