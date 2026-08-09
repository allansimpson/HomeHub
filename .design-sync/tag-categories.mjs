/*
 * One-shot helper: add a `@category` tag to each design-system component's leading JSDoc.
 *
 * The /design-sync converter groups the Design System pane by the last non-generic source
 * directory — and every component here sits directly in `src/components/`, which the converter
 * treats as generic. Its documented fallback is the JSDoc `@category` tag. Tagging is preferable
 * to the alternative (per-component doc stubs), because a doc file REPLACES the component's JSDoc
 * in the design agent's usage reference, and this repo's JSDoc is worth far more than a stub.
 *
 * Idempotent: a component that already carries `@category` is left alone. Re-run after adding a
 * component; safe to delete once every component is tagged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CATEGORIES = {
  Shell: ['ScreenShell', 'BottomNav', 'DashboardHeader', 'DrillInHeader', 'BackButton', 'AccountAvatar'],
  Structure: ['DoubleRule', 'SectionLabel', 'CollapsibleSection', 'LedgerRow', 'ScrollArea', 'EmptyState'],
  Controls: ['Stepper', 'HoldButton', 'Toggle', 'Chip', 'PinPad', 'MarkPicker', 'MarkBox'],
  Status: ['AlertBanner', 'MicLiveBanner', 'OfflineChip', 'LiveCards', 'NotificationDrawer', 'NotificationPullTab', 'AttendantOverlay'],
};

// Component → file. Two files declare two exports each.
const FILE_OF = {
  MarkBox: 'MarkPicker', NotificationPullTab: 'NotificationDrawer',
};

const SRC = 'client/src/components';
let tagged = 0, already = 0, missed = [];

for (const [category, names] of Object.entries(CATEGORIES)) {
  for (const name of names) {
    const path = join(SRC, `${FILE_OF[name] ?? name}.tsx`);
    let text = readFileSync(path, 'utf8');

    // Anchor at the declaration and scan BACKWARDS for its own JSDoc. Scanning forwards from the
    // file's first `/**` instead spans from an unrelated inner prop comment down to this block,
    // and in a two-export file it would find the other component's doc.
    const declAt = text.search(new RegExp(`^export\\s+function\\s+${name}\\b`, 'm'));
    if (declAt < 0) { missed.push(name); continue; }
    const end = text.lastIndexOf('*/', declAt);
    const start = end < 0 ? -1 : text.lastIndexOf('/**', end);
    // Only whitespace may sit between the block and the declaration, else it's some other comment.
    if (start < 0 || text.slice(end + 2, declAt).trim() !== '') { missed.push(name); continue; }

    const block = text.slice(start, end + 2);
    if (/@category/.test(block)) { already++; continue; }

    const indent = /\n([ \t]*)\*\/$/.exec(block)?.[1] ?? ' ';
    const tagged_block = block.includes('\n')
      // Multi-line: a blank continuation line, then the tag, before the terminator.
      ? `${block.slice(0, -2 - indent.length)}${indent}*\n${indent}* @category ${category}\n${indent}*/`
      // Single-line `/** … */`: expand to a block so the tag has somewhere to live.
      : `/**\n * ${block.slice(3, -2).trim()}\n *\n * @category ${category}\n */`;

    text = text.slice(0, start) + tagged_block + text.slice(end + 2);
    writeFileSync(path, text);
    tagged++;
  }
}

console.log(`tagged ${tagged}, already tagged ${already}${missed.length ? `, MISSED: ${missed.join(', ')}` : ''}`);
if (missed.length) process.exit(1);
