import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, Copy } from "./icons";

/** A <pre> with a copy button in its top-right corner, shown on hover. Copies `text`, or what the block shows. */
export function CodeBlock({ text, className, ...rest }: ComponentProps<"pre"> & { text?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="code">
      <pre ref={pre} className={className} {...rest} />
      <CopyButton text={() => text ?? pre.current?.innerText ?? ""} />
    </div>
  );
}

export function CopyButton({ text }: { text: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy"}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
        } catch {
          /* clipboard unavailable (insecure context or denied) */
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
