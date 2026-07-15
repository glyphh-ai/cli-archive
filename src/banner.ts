/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * banner.ts — the Glyphh mascot in white braille, byte-identical to the shared shell
 * banner (glyphh-rotor's glyphh_rotor/banner.py, mirrored in @glyphh/client). The header
 * shows JUST THE CAT — the left columns of the full logo, with the "GLYPHH" wordmark
 * cropped away (the outlined header already carries the wordmark as its title).
 */

/** The full mascot + wordmark. The cat lives in the left ~18 columns. */
const FULL_LOGO = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀⠀⠀",
  "⠀⠀⢸⡏⠳⣄⡀⠀⣀⣠⠴⠚⠉⣿⠀⠀⠀⠀",
  "⠀⠀⠈⢧⣀⡤⠟⠛⠉⠀⠀⠀⢰⠃⠀⠀⠀⠀",
  "⠀⠀⢠⠞⠁⢀⣤⠴⠖⠒⠲⣄⠈⢳⡀⠀⠀⠀",
  "⠀⠀⡏⠀⣰⠋⠀⠀⢠⣶⡆⢸⡆⠀⣧",
  "⠀⠀⣇⠀⠘⠲⢤⣄⣀⣈⣠⠞⠁⢀⡟",
  "⠀⠀⠈⢹⡆⠀⣀⡀⠉⠉⠀⢤⠖⠋ ",
  "⠀⠀⠀⡾⠀⣸⣿⣿⣿⣶⡀⠈⠷⢚⣻",
  "⠀⠀⠰⣧⣀⣉⣩⣭⣭⣭⣧⣤⣼⠏⠀",
];

/** The cat as an array of rows (already cropped to the mascot). */
export const CAT_ROWS: readonly string[] = FULL_LOGO;

/** Rendered width in columns (braille cells are single-width). */
export const CAT_WIDTH = Math.max(...CAT_ROWS.map((r) => [...r].length));

/** The cat as a single newline-joined block. */
export const CAT = CAT_ROWS.join("\n");
