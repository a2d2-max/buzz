// 읽기 전용 마크다운 렌더. web/ 과 같은 react-markdown + remark-gfm 조합.
// TV 에서는 링크를 눌러도 갈 곳이 없으니 항해를 막고 글자만 보여 준다.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => (
            <span className="markdown-link">{children}</span>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
