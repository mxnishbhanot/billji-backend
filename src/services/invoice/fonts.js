import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Font } from '@react-pdf/renderer';

// Fonts are read from disk, never fetched: a runtime download would make PDF
// generation depend on an outbound request and fail closed on a cold container.
// Importing this module registers the families — ESM evaluates a module once per
// process, so registration cannot run twice.

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const file = (name) => path.join(FONT_DIR, name);

// Noto Sans carries the rupee sign (U+20B9) and Latin; the two script families cover
// customer and business names. No single family spans all three scripts, so the stack
// below is a real fallback chain, not a preference list.
Font.register({
  family: 'Noto Sans',
  fonts: [
    { src: file('NotoSans-Regular.ttf') },
    { src: file('NotoSans-Bold.ttf'), fontWeight: 'bold' },
    { src: file('NotoSans-Italic.ttf'), fontStyle: 'italic' }
  ]
});

Font.register({
  family: 'Noto Sans Devanagari',
  fonts: [
    { src: file('NotoSansDevanagari-Regular.ttf') },
    { src: file('NotoSansDevanagari-Bold.ttf'), fontWeight: 'bold' },
    // Devanagari has no italic design, and React PDF resolves a style across every
    // family in the stack — without this entry any italic text on the page fails to
    // resolve. Upright is the correct rendering for the script anyway.
    { src: file('NotoSansDevanagari-Regular.ttf'), fontStyle: 'italic' }
  ]
});

// Gurmukhi is Mukta Mahee rather than Noto Sans Gurmukhi: fontkit (the shaper React
// PDF uses) crashes on Noto Sans Gurmukhi's mark-positioning table with
// "Cannot read properties of null (reading 'xCoordinate')" — both the hinted and
// unhinted builds. Mukta Mahee (Ek Type, OFL) shapes cleanly and covers the script.
Font.register({
  family: 'Mukta Mahee',
  fonts: [
    { src: file('MuktaMahee-Regular.ttf') },
    { src: file('MuktaMahee-Bold.ttf'), fontWeight: 'bold' },
    // Same as Devanagari: Gurmukhi has no italic face.
    { src: file('MuktaMahee-Regular.ttf'), fontStyle: 'italic' }
  ]
});

// React PDF resolves this per glyph run: Latin and ₹ come from Noto Sans, Devanagari
// and Gurmukhi from their own family.
export const FONT_FAMILY = ['Noto Sans', 'Noto Sans Devanagari', 'Mukta Mahee'];
