import { Fragment, type ReactNode } from "react";

// Just enough markdown for chat replies: fenced code, inline code, and bold. Rendered as React nodes, never HTML.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split(/```[^\n]*\n?/).map((block, index) =>
        index % 2 === 1 ? <pre key={index}>{block.replace(/\n$/, "")}</pre> : <Fragment key={index}>{inline(block)}</Fragment>,
      )}
    </>
  );
}
