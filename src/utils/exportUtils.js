/**
 * 导出工具集
 * 支持将交付物导出为 Markdown / HTML / PDF 三种格式
 */

/**
 * 简易 Markdown → HTML 转换器
 * 支持标题、列表、表格、代码块、加粗、斜体
 */
function markdownToHTML(md) {
    if (!md) return '';

    // 1. 保护代码块
    const codeBlocks = [];
    let html = md.replace(/```([\s\S]*?)```/g, (match, code) => {
        codeBlocks.push(code);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // 2. 基础块级格式化
    html = html
        .replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>')
        .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
        .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
        .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
        .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    // 3. 处理连续的列表项 (包裹 ul/ol)
    html = html.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (match) => {
        const items = match.trim().split('\n').map(item => `<li>${item.replace(/^[-*]\s+/, '')}</li>`);
        return `<ul>${items.join('')}</ul>\n`;
    });
    html = html.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (match) => {
        const items = match.trim().split('\n').map(item => `<li>${item.replace(/^\d+\.\s+/, '')}</li>`);
        return `<ol>${items.join('')}</ol>\n`;
    });

    // 4. 表格处理
    html = html.replace(/(?:^\|.+?\|(?:\n|$))+/gm, (match) => {
        const rows = match.trim().split('\n').filter(r => !r.match(/^\|[\s\-|]+\|$/));
        if (rows.length === 0) return '';
        const parseRow = (r) => r.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());
        let ths = parseRow(rows[0]).map(c => `<th>${c}</th>`).join('');
        let trs = rows.slice(1).map(r => `<tr>${parseRow(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
        return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>\n`;
    });

    // 5. 段落和换行处理（避免包裹 HTML 标签）
    const lines = html.split('\n');
    let inBlock = false;
    let outHtml = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === '') {
            if (inBlock) { outHtml.push('</p>'); inBlock = false; }
            continue;
        }
        if (line.match(/^<(h[1-6]|ul|ol|table)/)) {
            if (inBlock) { outHtml.push('</p>'); inBlock = false; }
            outHtml.push(line);
            continue;
        }
        if (line.match(/^__CODE_BLOCK_/)) {
            if (inBlock) { outHtml.push('</p>'); inBlock = false; }
            outHtml.push(line);
            continue;
        }

        if (!inBlock) {
            outHtml.push('<p>');
            inBlock = true;
        }
        outHtml.push(line + (i < lines.length - 1 && lines[i + 1].trim() !== '' && !lines[i + 1].match(/^</) ? '<br/>' : ''));
    }
    if (inBlock) outHtml.push('</p>');
    html = outHtml.join('\n');

    // 6. 还原代码块
    html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => {
        let codeContent = codeBlocks[index];
        let lang = '';
        if (codeContent.startsWith('\n')) {
            codeContent = codeContent.substring(1);
        } else {
            const firstLineEnd = codeContent.indexOf('\n');
            if (firstLineEnd !== -1) {
                lang = codeContent.substring(0, firstLineEnd).trim();
                codeContent = codeContent.substring(firstLineEnd + 1);
            }
        }
        return `<pre><code class="lang-${lang}">${codeContent}</code></pre>`;
    });

    return html;
}

/**
 * 生成带样式的完整 HTML 文档
 */
function buildHTMLDocument(content, title) {
    const bodyHTML = markdownToHTML(content);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; line-height: 1.8; background: #fafafa; }
  h1 { font-size: 1.8em; border-bottom: 2px solid #3B82F6; padding-bottom: 8px; color: #1e293b; }
  h2 { font-size: 1.4em; margin-top: 2em; color: #334155; }
  h3 { font-size: 1.2em; color: #475569; }
  p { margin-bottom: 1em; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  td, th { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  tr:nth-child(even) { background: #f1f5f9; }
  pre { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; }
  code { font-family: 'Fira Code', monospace; font-size: 0.9em; }
  ul { padding-left: 24px; }
  li { margin: 4px 0; }
  strong { color: #1e40af; }
  @media print { body { background: white; } pre { background: #f1f5f9; color: #1a1a1a; } }
</style>
</head>
<body>${bodyHTML}</body>
</html>`;
}

/**
 * 下载文件工具函数
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * 导出为 Markdown 文件
 */
export function exportAsMarkdown(content, title = 'deliverable') {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `${title}.md`);
}

/**
 * 导出为 HTML 文件
 */
export function exportAsHTML(content, title = 'deliverable') {
    const htmlDoc = buildHTMLDocument(content, title);
    const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    downloadBlob(blob, `${title}.html`);
}

/**
 * 导出为 PDF（利用浏览器打印功能）
 */
export function exportAsPDF(content, title = 'deliverable') {
    const htmlDoc = buildHTMLDocument(content, title);
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
        alert('请允许弹出窗口以生成 PDF');
        return;
    }
    printWindow.document.write(htmlDoc);
    printWindow.document.close();
    // 等待渲染完成后触发打印
    printWindow.onload = () => {
        setTimeout(() => {
            printWindow.print();
            printWindow.close();
        }, 500);
    };
}

export default { exportAsMarkdown, exportAsHTML, exportAsPDF };
