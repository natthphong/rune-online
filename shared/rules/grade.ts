// Item grades (2.5.0): common < fine < rare < epic < legendary. items.json `grade` is set by the importer (tools/rathena/gear250.ts) on every
// weapon and armour; anything else (potions, loot, cards) has none and counts as common. Rare and above drop only from class Boss monsters.
export const GRADES = ["common", "fine", "rare", "epic", "legendary"] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_LABEL: Record<Grade, string> = { common: "Common", fine: "Fine", rare: "Rare", epic: "Epic", legendary: "Legendary" };
/** Name colours on a light window background (inventory, shop, equipment) and on the dark tooltip. */
export const GRADE_COLOR: Record<Grade, { light: string; dark: string }> = {
  common: { light: "inherit", dark: "#eef1ff" }, fine: { light: "#2f8a43", dark: "#7ddc8f" }, rare: { light: "#2f62c8", dark: "#7fb0ff" },
  epic: { light: "#8a3fc4", dark: "#cf9bff" }, legendary: { light: "#c47f08", dark: "#ffc547" },
};
export const itemGrade = (it: object): Grade => {
  const g = (it as { grade?: string }).grade;
  return (GRADES as readonly string[]).includes(g ?? "") ? (g as Grade) : "common";
};
/** Rank 0-4, for comparisons ("rare or better"). */
export const gradeRank = (g: Grade) => GRADES.indexOf(g);
