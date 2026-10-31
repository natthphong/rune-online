// Stages everything the desktop app ships into stage/game (mirrors the ro/ layout so the server's relative file URLs resolve):
//   stage/game/server/src/index.mjs   the server bundled to plain JS (esbuild; no TS type stripping needed at runtime)
//   stage/game/server/src/*.wasm|data PGlite's Postgres runtime (resolved next to the bundle via import.meta.url)
//   stage/game/server/migrations/     SQL migrations (db.ts reads ../migrations/)
//   stage/game/shared/data/           data files the server reads at runtime (spawns.txt, pets.json)
//   stage/game/public/                the built client (pnpm build), served by the server as PUBLIC_DIR
// Usage: node build.mjs [--skip-client]   (--skip-client reuses an existing ../client/dist)
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const ro = path.resolve(here, "..");
const out = path.join(here, "stage", "game");
const bundleDir = path.join(out, "server", "src"); // stands for ro/server/src

// The release version lives in ONE place, ro/package.json; electron-builder reads desktop/package.json, so keep it in step.
const version = JSON.parse(readFileSync(path.join(ro, "package.json"), "utf8")).version;
const deskPkgFile = path.join(here, "package.json");
const deskPkg = readFileSync(deskPkgFile, "utf8");
if (version && JSON.parse(deskPkg).version !== version) {
  writeFileSync(deskPkgFile, deskPkg.replace(/"version": "[^"]*"/, `"version": "${version}"`));
  console.log(`[desktop] version -> ${version}`);
}

if (!process.argv.includes("--skip-client") || !existsSync(path.join(ro, "client", "dist", "index.html"))) {
  execSync("pnpm --filter client build", { cwd: ro, stdio: "inherit" });
}
rmSync(out, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

// `new URL("../../shared/data/x", import.meta.url)` in our own sources is relative to the source file; in the bundle every
// file shares one import.meta.url, so rebase each such path onto the bundle's place (ro/server/src).
const rebaseUrls = {
  name: "rebase-import-meta-urls",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const src = readFileSync(args.path, "utf8");
      const code = src.replace(/new URL\((["'])(\.{1,2}\/[^"']*)\1,\s*import\.meta\.url\)/g, (_m, q, rel) => {
        const abs = path.resolve(path.dirname(args.path), rel);
        let r = path.relative(path.join(ro, "server", "src"), abs).split(path.sep).join("/");
        if (rel.endsWith("/")) r += "/";
        if (!r.startsWith(".")) r = "./" + r;
        return `new URL(${q}${r}${q}, import.meta.url)`;
      });
      return { contents: code, loader: "ts" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(ro, "server", "src", "index.ts")],
  outfile: path.join(bundleDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  // optional native add-ons the deps try/catch around; the JS fallbacks are bundled
  external: ["pg-native", "msgpackr-extract", "bufferutil", "utf-8-validate", "uWebSockets.js"],
  banner: {
    js: [
      'import { createRequire as __ro_cr } from "node:module";',
      'import { fileURLToPath as __ro_fu } from "node:url";',
      'import { dirname as __ro_dn } from "node:path";',
      "const require = __ro_cr(import.meta.url);",
      "const __filename = __ro_fu(import.meta.url);",
      "const __dirname = __ro_dn(__filename);",
    ].join("\n"),
  },
  plugins: [rebaseUrls],
});

const pglite = path.join(path.dirname(createRequire(path.join(ro, "server", "package.json")).resolve("@electric-sql/pglite")));
for (const f of ["pglite.wasm", "pglite.data", "initdb.wasm"]) cpSync(path.join(pglite, f), path.join(bundleDir, f));
cpSync(path.join(ro, "server", "migrations"), path.join(out, "server", "migrations"), { recursive: true });
mkdirSync(path.join(out, "shared", "data"), { recursive: true });
for (const f of ["spawns.txt", "pets.json"]) {
  const p = path.join(ro, "shared", "data", f);
  if (existsSync(p)) cpSync(p, path.join(out, "shared", "data", f));
}
cpSync(path.join(ro, "client", "dist"), path.join(out, "public"), { recursive: true });
console.log(`[desktop] staged ${out}`);
