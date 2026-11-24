import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./reader/icons.jsx";

/** Copy text to the OS clipboard (Rust side; the WebView clipboard is flaky). */
export function copyText(text) {
  return invoke("clip_set", { text }).catch(() => navigator.clipboard?.writeText(text));
}

/** A small copy button that flips to a check for a moment after copying. */
export function CopyButton({ getText, label = "Copy", className = "" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={"copy-btn" + (done ? " done" : "") + (className ? " " + className : "")}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        copyText(getText());
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
      <span>{done ? "Copied" : label}</span>
    </button>
  );
}

const LANG_NAMES = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JSX", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  rs: "Rust", rust: "Rust", py: "Python", python: "Python", sh: "Shell", bash: "Bash", shell: "Shell", zsh: "Shell",
  ps1: "PowerShell", powershell: "PowerShell", pwsh: "PowerShell", json: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", css: "CSS", scss: "SCSS", html: "HTML", xml: "XML", sql: "SQL", md: "Markdown", markdown: "Markdown",
  diff: "Diff", go: "Go", java: "Java", c: "C", cpp: "C++", cs: "C#", csharp: "C#", rb: "Ruby", php: "PHP",
  swift: "Swift", kotlin: "Kotlin", ini: "INI", dockerfile: "Dockerfile", text: "Text", txt: "Text", plaintext: "Text",
};

function CodeBlock({ children, node }) {
  const ref = useRef(null);
  const codeEl = node?.children?.[0];
  const cls = (codeEl?.properties?.className || []).join(" ");
  const lang = /language-([\w+#-]+)/.exec(cls)?.[1]?.toLowerCase();
  const label = lang ? LANG_NAMES[lang] || lang : null;
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{label || "Code"}</span>
        <CopyButton getText={() => ref.current?.innerText || ""} />
      </div>
      <pre ref={ref} className="md-pre">{children}</pre>
    </div>
  );
}

// Render Claude's text/plan replies as Markdown. Links open in the system
// browser (target=_blank is blocked inside the WebView2). Code blocks get a
// language label, syntax colouring and a copy button.
const components = {
  a: ({ href, children, node, ...p }) =>
    // Claude often "links" to local files (`lib.rs:139`); those can't open
    // from here, so they render as a quiet reference instead of a dead link.
    !href || !/^https?:\/\//i.test(href) ? (
      <span className="md-ref" title={href}>{children}</span>
    ) : (
    <a
      href={href}
      onClick={(e) => {
        // ALWAYS suppress the WebView's default navigation: an untrusted
        // transcript link like `//evil.example` or `/x` would otherwise navigate
        // the whole app frame away (remote phishing page / SPA-unmounting DoS).
        // Only genuine http(s) links are forwarded to the system browser.
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) {
          invoke("open_external", { url: href }).catch(() => {});
        }
      }}
      title={href}
      {...p}
    >
      {children}
    </a>
    ),
  pre: CodeBlock,
  table: ({ children, node, ...p }) => (
    <div className="md-table-wrap">
      <table {...p}>{children}</table>
    </div>
  ),
};

const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
const remarkPlugins = [remarkGfm];

function Markdown({ children, className = "" }) {
  return (
    <div className={"md" + (className ? " " + className : "")}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
