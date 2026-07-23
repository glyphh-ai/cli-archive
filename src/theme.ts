/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * theme.ts — the one palette, per the Glyphh TUI law: white + neutral grays + ONE
 * purple (#af5fff = xterm-256 135). 256-color-safe — never truecolor, because
 * Terminal.app has no truecolor and tinted colors drift blue. Ink/chalk downsamples
 * these hex values to the nearest 256 index on a 256-color terminal.
 */

export const theme = {
  /** True white — primary text + the mascot. */
  white: "#ffffff",
  /** Neutral gray — secondary text, labels. */
  gray: "#8a8a8a",
  /** Dim gray — borders, hints, the quiet chrome. */
  dim: "#585858",
  /** The one accent. Used sparingly: focus, the wordmark, the active loop. */
  purple: "#af5fff",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
