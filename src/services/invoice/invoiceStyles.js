import { StyleSheet } from '@react-pdf/renderer';
import { FONT_FAMILY } from './fonts.js';

// The invoice was authored as a 794px-wide CSS page (A4 at 96dpi). React PDF works in
// points, where A4 is 595.28pt wide — so every dimension carried over from the old
// stylesheet is the original px value scaled by 0.75. Keeping the conversion explicit
// means the two layouts can be compared line by line.
export const pt = (px) => px * 0.75;

const INK = '#0f172a';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const LINE = '#e2e8f0';

// Column widths are fixed rather than content-sized: React PDF has no table layout
// algorithm, so a long product name would otherwise squeeze the amount column. The
// three variants mirror the three header shapes the document can take.
export const columnWidths = ({ isGstDocument, showHsnColumn }) => {
  if (showHsnColumn) return { desc: '38%', hsn: '12%', qty: '11%', rate: '14%', gst: '9%', amount: '16%' };
  if (isGstDocument) return { desc: '46%', qty: '12%', rate: '15%', gst: '10%', amount: '17%' };
  return { desc: '52%', qty: '14%', rate: '17%', amount: '17%' };
};

export const createStyles = (accent, accentTint) =>
  StyleSheet.create({
    page: {
      backgroundColor: '#ffffff',
      color: INK,
      fontFamily: FONT_FAMILY,
      fontSize: pt(13),
      lineHeight: 1.45,
      paddingTop: pt(48),
      paddingHorizontal: pt(46),
      // Deeper than the original 36px so the fixed brand footer never collides with
      // the last row of a page that fills completely.
      paddingBottom: pt(78)
    },

    watermark: {
      position: 'absolute',
      top: '42%',
      left: 0,
      right: 0,
      textAlign: 'center',
      fontWeight: 'bold',
      fontSize: pt(108),
      letterSpacing: pt(8),
      color: accent,
      opacity: 0.08,
      transform: 'rotate(-32deg)'
    },

    rule: { height: pt(1), backgroundColor: LINE, marginVertical: pt(14) },

    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    headerLeft: { flexDirection: 'row', alignItems: 'center' },
    logo: {
      width: pt(52),
      height: pt(52),
      objectFit: 'contain',
      borderWidth: pt(1),
      borderColor: LINE,
      borderRadius: pt(10),
      padding: pt(4),
      marginRight: pt(14)
    },
    title: { fontWeight: 'bold', fontSize: pt(34), letterSpacing: pt(0.5), color: accent },
    number: { fontWeight: 'bold', fontSize: pt(14), textAlign: 'right', paddingTop: pt(8) },

    meta: { flexDirection: 'row' },
    metaCell: { flex: 1, paddingRight: pt(18) },
    metaLabel: { fontWeight: 'bold', fontSize: pt(9), letterSpacing: pt(0.5), color: FAINT },
    metaValue: { fontWeight: 'bold', fontSize: pt(13), marginTop: pt(3) },
    metaValueAccent: { color: accent },

    parties: { flexDirection: 'row', marginBottom: pt(6) },
    party: { flex: 1, paddingRight: pt(28) },
    partyLabel: { fontWeight: 'bold', fontSize: pt(9), letterSpacing: pt(0.6), color: FAINT, marginBottom: pt(4) },
    partyName: { fontWeight: 'bold', fontSize: pt(15) },
    partyText: { fontSize: pt(11.5), color: MUTED, marginTop: pt(2) },

    table: { marginTop: pt(16) },
    tableHeadRow: { flexDirection: 'row', backgroundColor: accentTint },
    tableHeadCell: {
      fontWeight: 'bold',
      fontSize: pt(10),
      letterSpacing: pt(0.4),
      textTransform: 'uppercase',
      color: accent,
      paddingVertical: pt(9),
      paddingHorizontal: pt(10),
      textAlign: 'right'
    },
    tableHeadFirst: { textAlign: 'left', borderTopLeftRadius: pt(6), borderBottomLeftRadius: pt(6) },
    tableHeadLast: { borderTopRightRadius: pt(6), borderBottomRightRadius: pt(6) },
    tableRow: { flexDirection: 'row', borderBottomWidth: pt(1), borderBottomColor: '#eef1f5' },
    tableCell: { paddingVertical: pt(11), paddingHorizontal: pt(10), textAlign: 'right', color: MUTED },
    itemName: { fontWeight: 'bold', fontSize: pt(13), color: INK },
    itemSku: { fontSize: pt(10), color: FAINT, marginTop: pt(2) },
    amountCell: { fontWeight: 'bold', color: INK },

    totals: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: pt(18) },
    totalsBox: { width: pt(280) },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: pt(4) },
    totalLabel: { fontSize: pt(12.5), color: MUTED },
    totalValue: { fontWeight: 'bold', fontSize: pt(12.5), color: INK },
    grandLabel: { fontWeight: 'bold' },
    grandValue: { color: accent },
    balanceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginTop: pt(8),
      paddingTop: pt(8),
      borderTopWidth: pt(1),
      borderTopColor: LINE
    },
    balanceLabel: { fontWeight: 'bold', fontSize: pt(13), color: accent },
    balanceValue: { fontWeight: 'bold', fontSize: pt(20), color: accent },

    taxSummary: { marginTop: pt(20) },
    taxTable: { marginTop: pt(6) },
    taxHeadRow: { flexDirection: 'row', backgroundColor: '#f8fafc' },
    taxHeadCell: {
      fontWeight: 'bold',
      fontSize: pt(9),
      letterSpacing: pt(0.4),
      textTransform: 'uppercase',
      color: MUTED,
      paddingVertical: pt(6),
      paddingHorizontal: pt(8),
      textAlign: 'right'
    },
    taxRow: { flexDirection: 'row', borderBottomWidth: pt(1), borderBottomColor: '#f1f5f9' },
    taxCell: { fontSize: pt(11), paddingVertical: pt(6), paddingHorizontal: pt(8), textAlign: 'right' },
    firstColumnLeft: { textAlign: 'left' },

    disclaimer: {
      marginTop: pt(18),
      paddingVertical: pt(10),
      paddingHorizontal: pt(12),
      borderRadius: pt(8),
      borderWidth: pt(1),
      borderColor: accent,
      backgroundColor: accentTint
    },
    disclaimerTag: {
      fontWeight: 'bold',
      fontSize: pt(9.5),
      letterSpacing: pt(0.6),
      color: accent,
      marginBottom: pt(3)
    },
    disclaimerText: { fontSize: pt(11), lineHeight: 1.5, color: '#334155' },

    footerBlock: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: pt(26) },
    notes: { flex: 1, maxWidth: pt(420), paddingRight: pt(28) },
    notesText: { fontSize: pt(12), color: MUTED, marginTop: pt(6), lineHeight: 1.5 },
    sign: { width: pt(170), textAlign: 'center' },
    signAuto: { width: pt(210), textAlign: 'right' },
    signLine: { borderTopWidth: pt(1), borderTopColor: '#cbd5e1', marginBottom: pt(5) },
    signImage: {
      height: pt(56),
      objectFit: 'contain',
      marginBottom: pt(2),
      borderBottomWidth: pt(1),
      borderBottomColor: '#cbd5e1'
    },
    signText: { fontSize: pt(10), color: FAINT },
    signNote: { fontStyle: 'italic', fontSize: pt(10), color: FAINT, lineHeight: 1.5 },

    brandFooter: {
      position: 'absolute',
      bottom: pt(36),
      left: pt(46),
      right: pt(46),
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: pt(1),
      borderTopColor: LINE,
      paddingTop: pt(10)
    },
    brandSide: { flex: 1, fontSize: pt(9.5), color: FAINT },
    brandSideRight: { textAlign: 'right' },
    brandName: { flex: 1, textAlign: 'center', fontWeight: 'bold', fontSize: pt(10), color: INK },
    brandBill: { color: '#0A2540' },
    brandJi: { color: '#1E7FFF' }
  });
