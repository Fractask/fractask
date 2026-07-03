/**
 * Pick a base text direction from content.
 *
 * `dir="auto"` only looks at the *first* strong directional character, so a
 * Hebrew line that happens to start with a Latin token (e.g. "[manual-work — …]")
 * is wrongly treated as LTR. For our mixed HE/EN agent prompts we want the
 * direction the sentence is *mostly* in, so we count strong letters of each
 * script and take the majority. Ties and letter-less strings default to LTR.
 */

// Hebrew, Arabic, Syriac, Thaana, and the Arabic/Hebrew presentation-forms blocks.
const RTL_RE =
  /[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;
// Basic Latin letters plus Latin-1 Supplement / Extended-A.
const LTR_RE = /[A-Za-zÀ-ɏ]/;

export function textDirection(s: string | null | undefined): 'rtl' | 'ltr' {
  if (!s) return 'ltr';
  let rtl = 0;
  let ltr = 0;
  for (const ch of s) {
    if (RTL_RE.test(ch)) rtl++;
    else if (LTR_RE.test(ch)) ltr++;
  }
  return rtl > ltr ? 'rtl' : 'ltr';
}
