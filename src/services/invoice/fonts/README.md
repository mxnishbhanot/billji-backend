# Invoice PDF fonts

Bundled rather than fetched at runtime: PDF generation must not depend on an outbound
request. Registered in `../fonts.js`; the stack is Noto Sans → Noto Sans Devanagari →
Mukta Mahee, resolved per glyph run by React PDF.

| Family | Files | Covers | Source |
| --- | --- | --- | --- |
| Noto Sans | Regular, Bold, Italic | Latin, ₹ (U+20B9) | [notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSans/hinted/ttf) |
| Noto Sans Devanagari | Regular, Bold | Hindi and other Devanagari scripts | [notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSansDevanagari/hinted/ttf) |
| Mukta Mahee | Regular, Bold | Gurmukhi (Punjabi) | [google/fonts](https://github.com/google/fonts/tree/main/ofl/muktamahee) |

Gurmukhi is Mukta Mahee, not Noto Sans Gurmukhi: fontkit — the shaper React PDF uses —
throws `Cannot read properties of null (reading 'xCoordinate')` on Noto Sans Gurmukhi's
mark-positioning table, in both the hinted and unhinted builds.

All three families are licensed under the SIL Open Font License 1.1
(<https://openfontlicense.org>), which permits bundling and redistribution.
