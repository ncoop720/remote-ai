import { useMemo } from 'react';
import { parseMarkdown, type Inline } from '../markdown';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'code':
            return <code key={i}>{n.v}</code>;
          case 'bold':
            return (
              <strong key={i}>
                <InlineNodes nodes={n.children} />
              </strong>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer">
                {n.v}
              </a>
            );
          default:
            return <span key={i}>{n.v}</span>;
        }
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            return (
              <pre key={i}>
                <code>{b.v}</code>
              </pre>
            );
          case 'h':
            return (
              <p key={i} className="md-h">
                <InlineNodes nodes={b.inline} />
              </p>
            );
          case 'list': {
            const items = b.items.map((item, j) => (
              <li key={j}>
                <InlineNodes nodes={item} />
              </li>
            ));
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
          case 'quote':
            return (
              <blockquote key={i}>
                <InlineNodes nodes={b.inline} />
              </blockquote>
            );
          default:
            return (
              <p key={i}>
                <InlineNodes nodes={b.inline} />
              </p>
            );
        }
      })}
    </div>
  );
}
