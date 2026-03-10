/**
 * 导出工具集
 * 支持将交付物导出为 Markdown / HTML / PDF 三种格式
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 简易 Markdown → HTML 转换器
 * 使用 marked 库进行健壮且完整的 Markdown 渲染
 */
function markdownToHTML(md) {
    if (!md) return '';
    marked.setOptions({
        gfm: true,
        breaks: true,
        headerIds: false,
        mangle: false
    });
    const rawHtml = marked.parse(md);
    return DOMPurify.sanitize(rawHtml);
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
