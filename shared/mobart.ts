// Stand-in art (W03): species already placed in the world (shared/data/spawns.txt) whose own sprite sheets the art queue has not
// drawn yet (.cache/loop/c14_progress.md, the Codex retry script fills client/public/sprites/anim). Until a species' own
// mob_<id>_move / _act (or its static mob_<id> strip) exists, the client draws it with the art of a look-alike species at the
// species' own size (main.ts addEntity -> AnimSprite `standin`), so no monster is ever invisible. A species' own art always wins
// once it lands; shared/rules/content.test.ts only lets a placed species without art pass when it has a stand-in here whose art
// exists. Drop a row once its species' sheets are in.
export const ART_STANDIN: Record<number, number> = {
};
