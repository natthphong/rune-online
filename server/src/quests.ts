// Per-character quest log and permanent character variables (rAthena: sd->quest_log with the `quest` table, and
// char_reg_num). Loaded at login after the inventory (so after writesSettled), kept in memory, and written through on every
// change on the character's own write chain (Inventory.persist): quest rows, variables, inventory and the status save land
// in order, and the character's next session waits for all of them. Rules live in shared/rules/quest.ts.
import { questLoad, type QuestEntry, type QuestLog, type QuestState } from "../../shared/rules/quest.ts";
import { QUEST_DB } from "../../shared/content/quest_db.ts";
import { db } from "./db.ts";
import type { Inventory } from "./inventory.ts";

export class QuestStore {
  /** sd->quest_log + avail_quests (available entries first, completed ones after). */
  readonly log: QuestLog;
  /** Permanent character variables (char_reg_num, index 0); unset = 0, like rAthena. */
  readonly vars: Map<string, number>;
  private readonly inv: Inventory;

  private constructor(inv: Inventory, log: QuestLog, vars: Map<string, number>) {
    this.inv = inv; this.log = log; this.vars = vars;
  }

  /** intif_parse_questlog + the character's registry load. Call after Inventory.load (which waited for the old session). */
  static async load(inv: Inventory) {
    const [q, v] = await Promise.all([
      db.query("SELECT quest_id, state, time, count1, count2, count3 FROM quest WHERE char_id = $1", [inv.charId]),
      db.query(`SELECT "key", value FROM char_reg_num WHERE char_id = $1 AND "index" = 0`, [inv.charId]),
    ]);
    const rows: QuestEntry[] = q.rows.map((r) => ({
      questId: Number(r.quest_id), state: Number(r.state) as QuestState, time: Number(r.time),
      count: [Number(r.count1), Number(r.count2), Number(r.count3)],
    }));
    return QuestStore.fromRows(inv, rows, new Map(v.rows.map((r) => [String(r.key), Number(r.value)])));
  }

  /** A store over rows already read (load, and tests that run the script engine without a database). */
  static fromRows(inv: Inventory, rows: readonly QuestEntry[], vars = new Map<string, number>()) {
    return new QuestStore(inv, questLoad(rows, QUEST_DB), vars);
  }

  private write(sql: string, args: unknown[]) {
    this.inv.persist(sql, args).catch((e: Error) => { if (/after session end/.test(e.message)) console.error("[quest]", e.message); });
  }

  /** Save one log entry as it is now (insert or update). */
  save(e: QuestEntry) {
    this.write(
      `INSERT INTO quest (char_id, quest_id, state, time, count1, count2, count3) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (char_id, quest_id) DO UPDATE SET state = EXCLUDED.state, time = EXCLUDED.time,
         count1 = EXCLUDED.count1, count2 = EXCLUDED.count2, count3 = EXCLUDED.count3`,
      [this.inv.charId, e.questId, e.state, e.time, e.count[0] ?? 0, e.count[1] ?? 0, e.count[2] ?? 0]);
  }

  /** quest_delete's row. */
  remove(questId: number) {
    this.write("DELETE FROM quest WHERE char_id = $1 AND quest_id = $2", [this.inv.charId, questId]);
  }

  /** pc_setreg for a permanent character variable: 0 deletes it (pc_setregistry), anything else is stored. */
  setVar(key: string, value: number) {
    if (value === 0) {
      if (!this.vars.delete(key)) return;
      this.write(`DELETE FROM char_reg_num WHERE char_id = $1 AND "key" = $2 AND "index" = 0`, [this.inv.charId, key]);
      return;
    }
    if (this.vars.get(key) === value) return;
    this.vars.set(key, value);
    this.write(
      `INSERT INTO char_reg_num (char_id, "key", "index", value) VALUES ($1, $2, 0, $3)
       ON CONFLICT (char_id, "key", "index") DO UPDATE SET value = EXCLUDED.value`, [this.inv.charId, key, value]);
  }
}
