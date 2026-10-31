// Unit modes: enum e_mode (rathena src/common/mmo.hpp:242), the bits of status_data::mode. A monster's comes from mob_db (`Ai` is
// one of the MONSTER_TYPE_xx masks of these, mob.hpp:151; `Modes` / `Class` set or clear single bits, MobDatabase::parseBodyNode /
// loadingFinished): tools/rathena/import.ts writes it as mobs.json `mode` and checks these values against the C++ header. The AI
// (mobai.ts, which re-exports them) and battle (battle.ts is_infinite_defense) both read them, so they live in their own module.

export const MD = {
  CANMOVE: 0x1, LOOTER: 0x2, AGGRESSIVE: 0x4, ASSIST: 0x8, CASTSENSORIDLE: 0x10, NORANDOMWALK: 0x20, NOCAST: 0x40,
  CANATTACK: 0x80, CASTSENSORCHASE: 0x200, CHANGECHASE: 0x400, ANGRY: 0x800, CHANGETARGETMELEE: 0x1000,
  CHANGETARGETCHASE: 0x2000, TARGETWEAK: 0x4000, RANDOMTARGET: 0x8000, IGNOREMELEE: 0x10000, IGNOREMAGIC: 0x20000,
  IGNORERANGED: 0x40000, MVP: 0x80000, IGNOREMISC: 0x100000, KNOCKBACKIMMUNE: 0x200000, TELEPORTBLOCK: 0x400000,
  FIXEDITEMDROP: 0x1000000, DETECTOR: 0x2000000, STATUSIMMUNE: 0x4000000, SKILLIMMUNE: 0x8000000,
} as const;
export type ModeName = keyof typeof MD;

/** #define MD_MASK (mmo.hpp:274): the behaviour bits; the ones above it are immunities and drop / detection flags. */
export const MD_MASK = 0x000ffff;

/** status_has_mode */
export const hasMode = (mode: number, bit: number) => (mode & bit) !== 0;

/** A player's status mode (status_calc_pc_sub, status.cpp:3827): MD_MASK without MD_STATUSIMMUNE, the four MD_IGNORE* bits,
 *  MD_DETECTOR, MD_ANGRY and MD_TARGETWEAK. A player never has infinite defense (battle.ts isInfiniteDefense). */
export const PC_MODE = MD_MASK & ~(MD.STATUSIMMUNE | MD.IGNOREMELEE | MD.IGNOREMAGIC | MD.IGNORERANGED | MD.IGNOREMISC | MD.DETECTOR | MD.ANGRY | MD.TARGETWEAK);
