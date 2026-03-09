import React from 'react';

/**
 * 轻量级 Markdown 渲染组件
 * 将 Markdown 文本渲染为格式化的 React 元素
 * 支持：标题 / 加粗 / 斜体 / 代码块 / 行内代码 / 列表 / 表格 / 链接
 */
export default function MarkdownRenderer({ text }) {
    if (!text) return null;

    const lines = text.split('\n');
    const elements = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 代码块
        if (line.trim().startsWith('```')) {
            const lang = line.trim().slice(3);
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            i++; // 跳过结尾 ```
            elements.push(
                <pre key={elements.length} className="md-code-block">
                    {lang && <div className="md-code-lang">{lang}</div>}
                    <code>{codeLines.join('\n')}</code>
                </pre>
            );
            continue;
        }

        // 表格
        if (line.includes('|') && line.trim().startsWith('|')) {
            const tableRows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
                tableRows.push(lines[i]);
                i++;
            }
            // 解析表格
            const rows = tableRows
                .filter(r => !r.match(/^\|[\s\-:|]+\|$/)) // 过滤分隔行
                .map(r => r.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim()));

            if (rows.length > 0) {
                elements.push(
                    <table key={elements.length} className="md-table">
                        <thead>
                            <tr>{rows[0].map((cell, ci) => <th key={ci}>{renderInline(cell)}</th>)}</tr>
                        </thead>
                        {rows.length > 1 && (
                            <tbody>
                                {rows.slice(1).map((row, ri) => (
                                    <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInline(cell)}</td>)}</tr>
                                ))}
                            </tbody>
                        )}
                    </table>
                );
            }
            continue;
        }

        // 空行
        if (line.trim() === '') {
            i++;
            continue;
        }

        // 标题
        const headingMatch = line.match(/^(#{1,5})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const Tag = `h${Math.min(level + 1, 6)}`; // h2-h6，避免 h1
            elements.push(<Tag key={elements.length} className="md-heading">{renderInline(headingMatch[2])}</Tag>);
            i++;
            continue;
        }

        // 无序列表
        if (line.match(/^\s*[-*]\s+/)) {
            const listItems = [];
            while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
                const indent = lines[i].match(/^(\s*)/)[1].length;
                listItems.push({ text: lines[i].replace(/^\s*[-*]\s+/, ''), indent });
                i++;
            }
            elements.push(
                <ul key={elements.length} className="md-list">
                    {listItems.map((item, li) => (
                        <li key={li} style={{ marginLeft: Math.min(item.indent, 4) * 8 }}>
                            {renderInline(item.text)}
                        </li>
                    ))}
                </ul>
            );
            continue;
        }

        // 有序列表
        if (line.match(/^\s*\d+\.\s+/)) {
            const listItems = [];
            while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
                listItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                i++;
            }
            elements.push(
                <ol key={elements.length} className="md-list">
                    {listItems.map((item, li) => (
                        <li key={li}>{renderInline(item)}</li>
                    ))}
                </ol>
            );
            continue;
        }

        // 普通段落
        elements.push(<p key={elements.length} className="md-paragraph">{renderInline(line)}</p>);
        i++;
    }

    return <div className="md-content">{elements}</div>;
}

/**
 * 渲染行内 Markdown 格式
 * 加粗、斜体、行内代码、链接
 */
function renderInline(text) {
    if (!text) return text;

    // 将行内 Markdown 转为 React 元素
    const parts = [];
    let remaining = text;
    let key = 0;

    while (remaining.length > 0) {
        // 行内代码
        let match = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
        if (match) {
            if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
            parts.push(<code key={key++} className="md-inline-code">{match[2]}</code>);
            remaining = match[3];
            continue;
        }

        // 加粗
        match = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
        if (match) {
            if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
            parts.push(<strong key={key++}>{match[2]}</strong>);
            remaining = match[3];
            continue;
        }

        // 斜体
        match = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
        if (match) {
            if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
            parts.push(<em key={key++}>{match[2]}</em>);
            remaining = match[3];
            continue;
        }

        // 链接
        match = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)(.*)/s);
        if (match) {
            if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
            parts.push(<a key={key++} href={match[3]} target="_blank" rel="noopener noreferrer" className="md-link">{match[2]}</a>);
            remaining = match[4];
            continue;
        }

        // 无匹配，输出剩余文本
        parts.push(<span key={key++}>{remaining}</span>);
        break;
    }

    return parts.length === 1 ? parts[0] : <>{parts}</>;
}
