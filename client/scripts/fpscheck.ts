// Distinct frames per second of a video (the footage smoothness number): ffmpeg mpdecimate drops near-duplicate frames; what is
// left over the duration = how many real pictures a second the viewer sees. Also prints the strict count (exact repeats only) and
// the worst second, so a stutter shows even when the average is fine.
//   node client/scripts/fpscheck.ts <video> [<video> ...]
import { spawnSync } from "node:child_process";

export function distinct(file: string, filter = "mpdecimate") {
  const input = file.endsWith(".mp4") ? ["-i", file] : ["-framerate", "100", "-i", `${file}/%06d.jpg`];
  const r = spawnSync("ffmpeg", ["-hide_banner", ...input, "-vf", `${filter},showinfo`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const times = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  // a frame folder (rec60 REC_KEEP=1) is read at 100 fps: its "seconds" are then frames / 100
  const dur = !file.endsWith(".mp4") ? 1 : Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim());
  const perSec = new Map<number, number>();
  for (const t of times) perSec.set(Math.floor(t), (perSec.get(Math.floor(t)) ?? 0) + 1);
  const full = [...perSec.entries()].filter(([s]) => s + 1 <= Math.floor(dur)).map(([, n]) => n);
  return { frames: times.length, seconds: dur, fps: times.length / dur, worstSecond: full.length ? Math.min(...full) : 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const d = distinct(f), s = distinct(f, "mpdecimate=hi=64:lo=32:frac=0");
    console.log(`${f}: ${d.seconds.toFixed(2)} s · mpdecimate ${d.fps.toFixed(1)} distinct fps (worst second ${d.worstSecond}) · strict ${s.fps.toFixed(1)} (worst ${s.worstSecond})`);
  }
}
