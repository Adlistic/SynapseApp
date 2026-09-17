import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";

// Render Claude's text/plan replies as Markdown. Links open in the system
// browser (target=_blank is blocked inside the WebView2). Code blocks get a
// styled <pre>; everything else is styled via the `.md` CSS scope.
const components = {
  a: ({ href, children, ...p }) => (
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
      {...p}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
};

export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
