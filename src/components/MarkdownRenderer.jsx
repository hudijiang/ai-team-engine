import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 健壮的 Markdown 渲染组件
 * 使用 marked 进行标准化解析，DOMPurify 保证 XSS 安全
 */
export default function MarkdownRenderer({ text }) {
    const htmlContent = useMemo(() => {
        if (!text) return '';
        // 配置 marked 参数以支持更多功能（如支持 GFM 表格，换行等）
        marked.setOptions({
            gfm: true,
            breaks: true,
            headerIds: false,
            mangle: false
        });
        const rawHtml = marked.parse(text);
        return DOMPurify.sanitize(rawHtml);
    }, [text]);

    if (!text) return null;

    return (
        <div
            className="md-content"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
    );
}
