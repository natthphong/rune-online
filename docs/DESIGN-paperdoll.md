# DESIGN: RO-style paper doll (character look system)

Status: design + rough art proof, 2026-11-11. Nothing in the game was changed. Evidence: `ro/docs/paperdoll-evidence/`.
Proof files: `tools/art/paperdoll_proof*.py`, `.cache/art/paperdoll-proof/` (`proof.png` = contact sheet).

**Verdict in one paragraph.** The renderer plumbing (one `Composer` for world / Select / Make Character, public `Look`
from the server, hair-mask dye, distance-driven walk frames, flat depth, per-pixel picking) is fine and stays. What must
be rebuilt is the *art model*: today a character is a full painted body (head included) plus patches cut out of whole-sheet
repaints, glued with hand-tuned constants. RO's model is the opposite: a **headless body per outfit**, a **head per hair
style**, and small sprites pinned to **per-frame attach points**. Our pose rig (`tools/art/pose_guide.py`) is code, so it
can play the part of RO's `.act` file exactly. The proof below shows Codex can paint to that rig well enough: 24/24 body
cells landed within ~1 sprite pixel of the rig's head anchor with no manual tuning.

## 1. Bug list (what the evidence shows, and why)

| # | Visible bug (where) | Root cause | Kind |
|---|---|---|---|
| B1 | Styles 2-6 hide or erase the face: a flat peach band where the eyes should be, half eyes, hair curtain over the face (matrix: every job, most visible on Long / Ponytail; zoom; Select "Mage01"; clip 3:25-3:58) | A `hairdo_<k>` strip is a *wig* drawn over a body whose face was painted together with the Classic hair. `shave()` (animSprite.ts:53) deletes the crown rectangle, mirrors half the face, fills "holes" with skin; `Composer.draw` then paints a `SCALP` ellipse (l.387). The face under the bangs never existed, so it is invented by code. | Art-approach limit, patched in code 3 times (2c "white smear", "scalp ring", "face hole") |
| B2 | Job bodies have big pointed ears and red eyes, the Fledgling has neither; the same character changes face when it changes job | The layered base body (`lay_<G>_base_misc`) is a Codex *repaint* of the novice sheet with a new bald head = a different face. Face belongs to the body sheet, so there is one face per repaint. | Art-approach limit |
| B3 | Same dye, two colours: Classic "Silver" is white, the five strips are grey (owner screenshots, tile 1 vs tiles 2-6) | Two tint paths: `dye()` overlay for sheets, `dye()` + `brightness(0.78) saturate(1.2)` for strips (`hairdoSheet`, l.166). | Code |
| B4 | Hair floats, sinks or is cut: topknot above the skull, long hair wider than the shoulders, tiles show odd crops | One global scale `HAIRDO_K` and one hand-tuned `dy` per style (`HAIRDO_PLACE`) on a head anchor that is `[x, top, width]` of the *painted hair's bounding box* (so it moves with the hair; `CROWN = 43` is the workaround). Tiles are a fixed crop of the same composite. | Code + data model |
| B5 | "Walk" / auto-walk does nothing for 6 of 7 jobs; in the world those jobs have no walk or attack frames of their own (`standOnly`), Swordman walks in the OLD `pc_*_swordman` body (other head, other armour) and pops back when it stops | Only the misc sheet (stand/sit/hurt/dead) is layered. Walk and attack would need the base + every outfit + every weapon repainted again per sheet, so they were never made. | Art-approach limit |
| B6 | Weapon is glued to the job: every Arcanist holds the same staff, shown even with another weapon equipped; preview always passes `weapon: "blade"` (`styleLook`, screens.ts:283) while the world uses the equipped one | The weapon "layer" is the pixel diff of a per-job repaint (`lay_<G>_<job>w_misc`), stand column only. It is not an item sprite. | Art-approach limit |
| B7 | Fledgling and job bodies differ in height, head size and stance in the same grid (matrix row 1 vs rows 2-7) | Outfit layers are registered on the base by silhouette IoU 0.75-0.82: a fifth of the silhouette does not match, by design of "repaint then diff". | Art-approach limit |
| B8 | Specks / sparkles beside heads (matrix, F columns), dark fringe around some hair | Diff + key leftovers; no automated gate, sheets are checked by eye. | Pipeline (no QA gate) |
| B9 | Bald / wrong-clothes flash while picking (fixed in 2c), Select vs world mismatch (fixed in 143e7aa by carrying `job`) | A look is 4 body sheets + layered misc + strips + gear, loaded through separate caches, with `Look.outfit` and `Look.job` both able to choose the body. Fixed case by case; the structure invites the next one. | Code structure |
| B10 | 2nd / transcendent jobs are a hue-rotated first job (`tintSheet`, skin kept by a colour heuristic, f722860) | No way to make a new outfit cheaply, so a filter stands in. | Art-approach limit |

Git history shows the pattern: 666aa2f (lock one head, "no more boiling"), 7201032 (hair overlays), f722860 (tint keeps
face), ae6985c (bald flash, white smear, scalp ring), 143e7aa (select vs world), 55e4d27 (stand-only layers). Each fixed
a symptom of the same cause: **the head, the face and the clothes are not separate things in the art.**

## 2. Why the current approach cannot scale

1. **Whole-sheet repaints.** Every layer is a 4x5 sheet repainted by Codex; the layer is "pixels that changed". Codex
   never repaints the same pixels twice, so the diff carries noise and the registration is approximate (IoU ~0.8).
2. **Layers depend on each other.** Weapon = diff of (outfit + weapon) vs outfit. So weapons x outfits x genders, not
   weapons + outfits. Today: 6 jobs x 2 genders x (outfit + weapon) = 24 sheets, for the stand sheet only.
3. **Stand-only.** Walk (8 frames x 5 facings) and attacks would multiply that by ~4 sheets. Nobody will repaint
   base -> outfit -> weapon three more times per job, so walk/attack silently use the old body.
4. **Hair as a wig on a painted head.** Needs shave + scalp + mirror hacks, one tuned offset per style, and still has no
   face under it. A 7th style costs a tuning session and new edge cases on every body.
5. **Placement constants instead of data.** `HAIRDO_PLACE`, `GEAR_PLACE`, `HEAD`, `CROWN`, `HAIRDO_K` are per-slot guesses
   shared by all frames. A hat cannot follow the head through an attack swing.
6. **Cost model.** New visual = `items x actions x facings x genders x (every outfit it sits on)`. One headgear should
   cost one image; today a costume costs 2 genders x 4 sheets x (base + outfit + weapon repaints) and still breaks hair.

## 3. Target design

### 3.1 How the RO client does it (reference, systems only)

- A character is several sprites drawn in order: **body** (one sprite set per job x gender: the job *is* the clothes),
  **head** (one per hair style x gender: face + hair together), headgear **top / mid / low**, **garment** (robe/wings),
  **weapon** and **shield** (per job, because they follow that job's hand).
- Every sprite has an `.act`: actions (stand, walk, sit, pick up, ready, attack 1-3, hurt, freeze, dead, cast) x 8
  directions (5 drawn, 3 mirrored), each frame with an **attach point**. The client draws the head at
  `body.attach - head.attach`; headgear uses the same rule against the head. Nothing is tuned per item.
- Colour variants are **palettes** (hair palette per style, cloth palette per job), not new art.
- Draw order changes with direction (shield and garment go behind the body in some facings).

### 3.2 Our version

**Layers and order** (front, 3/4 front, side); for 3/4 back and back the items marked * flip to the other side of the body:

```
shadow -> garment(back part)* -> weapon/shield of the FAR hand* -> BODY (headless outfit) -> HEAD (face + hair)
       -> headgear low -> mid -> top -> garment(front part)* -> weapon/shield of the NEAR hand* -> fx
```
Order is data, not code: each frame carries `z` flags (below). Long hair that must fall behind the shoulders is the
head's own `back` sub-sprite (drawn before the body in front facings), as in the proof's keyed hat.

**Anchors** come from the rig, per action x facing x frame, written once by `pose_guide.py` into `rig.json`:
`head [x,y,r]`, `handR [x,y,deg]`, `handL [x,y,deg]`, `back [x,y]`, `feet [x,y]`, `nearHand: R|L`. A body sheet may
override an anchor with what was *measured* in its own art (the cyan head ball; later a hand blob). Sprites carry their own
origin (head: skull centre + radius; weapon: grip point + up direction; headgear: skull centre). Placement is always
`body.anchor - sprite.origin`, scale `body.head.r / sprite.r`.

**Actions and facings.** 5 painted facings, mirrored to 8 (as today). First set: stand 1, walk 8, sit 1, hurt 1, dead 1,
attack-swing 4, attack-shoot/thrust 4, cast 2 = 22 frames per facing. Weapon *family* picks the attack action
(swing: sword/dagger/axe/mace; shoot: bow; cast: rod), not a separate body sheet per weapon.

**Colour.** Hair stays key-green in the art with a mask; the dye is ONE function (grey ramp x dye, fixes B3). Outfits get
up to 2 key regions (primary / secondary cloth) for dyes and for 2nd-job variants until they have their own art;
`tintSheet`'s skin heuristic is retired.

**One data format** for every visual (`shared/data/visuals.json`, checked by a test like `look.test.ts`):

```jsonc
{ "id": "hat_feather", "slot": "head_top",          // body | head | head_top|mid|low | garment | weapon | shield
  "item": 2220,                                      // item id(s) that show it; bodies/heads use job / style index instead
  "sprite": { "M": "pd/hat_feather", "F": "pd/hat_feather" },   // per-gender variants, may be the same file
  "views": 5, "origin": [[64,70,41], ...],           // per view: x, y, r (heads/headgear) or grip x, y, up-deg (weapons)
  "back": true,                                      // has a behind-the-body sub-sprite
  "frames": null,                                    // null = rigid (one image per view); else per-action sheets (bodies)
  "dye": ["hair"], "z": 0 }
```
`Look` becomes ids only: `{ gender, body, head, hairColor, clothColor?, top?, mid?, low?, garment?, weapon?, shield? }`.
`visualsOf` maps equipped items -> ids (costume slots override equipment slots, like RO). `outfit@hue` strings,
`LAYER_JOBS`, `standOnly`, `HAIRDO_PLACE`, `GEAR_PLACE`, `shave`, `SCALP` all disappear.

**One renderer.** `Composer.loadLook(look)` resolves ids -> sprites + anchors and returns only when all parts are loaded
(no partial look is ever drawn: B9 by construction); `draw(action, frame, facing)` walks the order list. World
`AnimSprite`, Select slots, Make Character preview and the hair tiles (a head sprite alone: no crop) call the same two
functions. The composite is cached per (look, action, frame, facing) as today.

## 4. Art pipeline that scales

Hybrid: **code-drawn rig guide + Codex repaint against a key-colour placeholder + automatic lock + QA gate.**

1. `pose_guide.py` renders the guide (mannequin, head = flat cyan ball) and `rig.json` for each action group x facing.
2. Codex repaints the guide as the item. Bodies: "head stays the cyan ball" -> body is keyed headless and the ball
   *measures* where the head goes. Heads / headgear: repaint a row of 5 cyan balls; headgear keeps the balls, so the ball
   occludes the far side of the hat for free. Weapons / shields: one isolated image (side + toward-viewer view).
3. Lock step (the current `sprite_lock.py` idea, now trivial): key, measure anchors, scale to the rig, write sprite + json.
4. **QA gate** (script, exit 1 = cannot ship): cyan ball found in every cell; head anchor within 3 raw px of the rig and
   radius ratio 0.93-1.07; feet line stable across a row; no cyan/magenta left; no blob < 30 px (specks, B8); bodies:
   no skin-coloured pixels inside the head circle (a head was painted); heads: face visible (eye-dark pixels at the
   guide's eye dots in front views: B1 can never ship); walk rows pass the existing `walk_check.py`. Then
   `layershots.ts`-style screenshot matrix of the new item on every body for a human glance.

**Cost per new visual** (Codex measured in the proof: 38-118 s, mean 78 s, 0 retries in 9):

| Visual | Images | Codex time | Depends on outfits? |
|---|---|---|---|
| Headgear (top/mid/low) | 1 (5 views) | ~1.5 min | no |
| Hair style | 1 per gender | ~3 min | no |
| Weapon / shield | 1 | ~1 min | no |
| Garment (cape, wings) | 1-2 (5 views, back/front parts) | ~3 min | no |
| Outfit / costume body | 3 per facing (walk 8; stand+sit+hurt+dead+cast; attacks) x 5 facings x 2 genders = 30 | ~40 min + redraws | no |

**Smallest first set:** 7 outfits x 30 = 210 body images, 6 hair styles x 2 = 12, 7 starting weapons = 7, re-key the 3
existing gear pieces = 3. **~232 images, about 5 h of Codex at 78 s, plan 7 h with ~30 % redraws** (run overnight with
`queue.py`; ChatGPT fallback exists). A hair style or hat after that is minutes, which is the whole point.

## 5. Migration plan (each step ships alone; old path stays until step 5)

| Step | What | Gate | Claude % of week | Codex images |
|---|---|---|---|---|
| 0 | Second proof on the unknowns: 3/4 + back facings, female, attack + sit + dead cells, hand anchor measured from the art, chibi-proportion guide (clay style) | `paperdoll_proof` numbers + contact sheet shown to the owner | 1 | ~15 |
| 1 | `visuals.json` + rig export + new `Composer` path behind `?pd=1`, dev page `/dev/paperdoll.html` (every part x action x facing) with Novice M only | typecheck, `pnpm test`, dev-page screenshot | 2-3 | 16 |
| 2 | Pipeline scripts (`pd_jobs.py`, `pd_build.py`, `pd_check.py` = QA gate); Novice + Swordman both genders, 6 heads x 2, 7 weapons | QA gate green; `create` bot (select look == world look); `layershots` matrix | 2 | ~80 |
| 3 | Make / Select / world switch to the new path for jobs that have art; hair tiles = head sprites | `create`, `smoke`, `clickskill`, `grind`; matrix screenshot has a face in every cell | 2 | 0 |
| 4 | Remaining 5 outfits | QA gate, matrix, `walk_check.py` | 2 | ~150 |
| 5 | Delete old path: `shave`, hairdo strips, `layeredMisc`, `standOnly`, `tintSheet`, `lay_*` / old `pc_*` sheets | all bots; bundle size drops | 1 | 0 |
| 6 | Fashion: costume + headgear top/mid/low slots in items/DB, `visualsOf`, first 5 hats + 1 costume | `items` bot + matrix | 2 | ~40 |

Total about 12-13 % of weekly quota spread over 3-4 releases, ~300 Codex images.

## 6. Risks and open questions

- **3/4 and back facings are unproven** (the walk notes say Codex prefers an open stance in 3/4 with a grey mannequin; the
  clay-style guide fixed it for walks). Step 0 exists for this.
- **Hand anchor.** Wide sleeves move the painted hand off the rig's wrist (proof: mage staff). Fix candidates: measure
  the skin blob nearest the rig wrist per cell (preferred), or a key-colour mitten like the head ball.
- **Rigid weapons** look right from the side, flat from the front. Proposed: 2 views per weapon (profile + toward
  viewer). Owner: is that good enough, or do attacks need painted weapon frames (RO style, x outfits cost)?
- **Shoulders under the head** are not painted (hidden by the ball). Every head must cover the ball; very short hair
  styles need the QA gate to prove it.
- **Proportions.** The proof bodies are thinner than today's sprites because the mannequin is. Owner: keep today's
  chibi build (set in the guide once, before 210 images are drawn)?
- **Existing characters**: `hairdo`/`hair` columns map 1:1 to head ids; no DB migration until step 6 (costume slots).
- **Gender**: are heads unisex (6 images) or per gender (12)? Plan assumes per gender.
- Codex quota for ~300 images is assumed available; the browser fallback is slower (manual pace).

## Proof results

Run: `paperdoll_proof_guide.py` (guides, anchors, 9 jobs) -> `paperdoll_proof_run.py` (Codex) -> `paperdoll_proof.py`.
9 images: 2 outfits (swordman, mage) x 2 facings (side, front) x 6 cells (stand + 5 walk frames), 2 heads (5 views each,
key-green hair), 1 hat (5 views on cyan balls), sword, staff. Output `.cache/art/paperdoll-proof/proof.png`: 5 rows x 12
frames: raw body, then 4 mixes of body x head x dye x hat x weapon composited only from anchors.

**Codex time:** 82, 118, 91, 72, 102, 79, 53, 54, 38 s = 689 s total, mean 77 s, all first try.

**Worked**
- The cyan placeholder was respected in 24/24 cells: flat, same place, same size. Measured vs rig: head |dx| mean 1.7,
  max 2.4 raw px; |dy| mean 1.2, max 2.8; radius ratio 0.96-0.99. At sprite scale (x0.45) that is about 1 px. No tuning.
- Two different heads, the hat and both dyes sit correctly on both outfits, both facings, every frame, including the walk
  bob, with zero per-item constants. Swapping outfit never touches the face (B1, B2, B4, B7 gone by construction).
- Headgear painted on a cyan ball keys cleanly and the ball hides its far side.
- Bodies followed the guide's limbs in the side walk; the robe (a silhouette changer) stayed registered.

**Broke / weak**
- Weapon: the wrist anchor is the rig's, shifted by the head offset. Good on the side swordman, loose on the front view
  (sword beside the fist) and on the mage (staff not in the hand, drawn under the head in front). Needs a measured hand
  anchor and the per-frame z flag; a single rotated image reads flat from the front.
- Feet line: boots are 10-19 raw px lower than the mannequin's feet (thicker soles), consistent per sheet; the lock step
  must set the baseline from the art, not the rig.
- Dye in the proof is a naive luminance multiply: "red" came out orange with yellow highlights. The shipped hair-mask
  dye is better; keep it, single path.
- Front-view walk frames barely differ (legs overlap), same weakness the walk pipeline already documents.
- Bodies are mannequin-thin next to the big chibi head.

**Not tested:** 3/4 and back facings, female, sit / dead / attack cells, garment, shield, behind-the-body hair.
