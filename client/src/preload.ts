// Per-map asset warm-up: the monster species of a map (shared/data/spawns.txt) are fetched + decoded as soon as the map is
// known — in parallel with the room join — and the maps one warp away follow at idle time, so a warp finds its sheets cached.
import spawnText from "../../shared/data/spawns.txt?raw";
import { WARPS, type MapName } from "../../shared/maps.ts";
import { preloadMobs } from "./animSprite.ts";
import { ART_STANDIN } from "../../shared/mobart.ts";

const speciesOf = new Map<string, Set<number>>();
for (const line of spawnText.split("\n")) {
  if (!line || line.startsWith("//")) continue;
  const f = line.split("\t");
  if (f.length < 4 || !/^(boss_)?monster$/.test(f[1])) continue;
  const map = f[0].split(",")[0], id = Number(f[3].split(",")[0]);
  if (!Number.isFinite(id)) continue;
  if (!speciesOf.has(map)) speciesOf.set(map, new Set());
  speciesOf.get(map)!.add(id);
}
const done = new Set<string>();
const warm = (map: string) => {
  if (done.has(map)) return;
  done.add(map);
  const ids = [...(speciesOf.get(map) ?? [])];
  preloadMobs([...ids, ...ids.filter((id) => id in ART_STANDIN).map((id) => ART_STANDIN[id])]); // W03: stand-in art too
};

/** Call when a map is about to be joined (before the room answers), then again nothing: the neighbours are queued here. */
export function preloadMap(map: MapName) {
  warm(map);
  const next = [...new Set(WARPS.filter((w) => w.map === map).map((w) => w.to.map))].filter((m) => m !== map);
  const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
  for (const m of next) idle(() => warm(m), { timeout: 4000 });
}
