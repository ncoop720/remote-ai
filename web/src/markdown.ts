// A small Markdown subset for Claude's replies: fenced code, headings, lists, quotes, paragraphs,
// inline code, bold and http(s) links. Output is data, rendered as React elements (never HTML).

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'link'; v: string; href: string };

export type Block =
  | { t: 'p'; inline: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'h'; level: number; inline: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; inline: Inline[] };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const LIST_ITEM = /^\s*([-*]|\d+[.)])\s+(.*)$/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    // Bold often wraps code or links ("**`src/app.ts`:**"), so parse inside it too.
    else if (m[2] !== undefined) out.push({ t: 'bold', children: parseInline(m[2]) });
    else out.push({ t: 'link', v: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*(\S*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: 'h', level: heading[1]!.length, inline: parseInline(heading[2]!) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const items = [parseInline(item[2]!)];
      for (;;) {
        const next = i + 1 < lines.length ? LIST_ITEM.exec(lines[i + 1]!) : null;
        if (!next || /\d/.test(next[1]!) !== ordered) break;
        items.push(parseInline(next[2]!));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ t: 'quote', inline: parseInline(quote[1]!) });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return blocks;
}
