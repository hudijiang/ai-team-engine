/**
 * 前端轻量 RAG 引擎
 * 支持文档上传、分段存储、关键词检索，检索结果注入 Agent Prompt
 */

const STORAGE_KEY = 'agent-auto-knowledge-base';
const CHUNK_SIZE = 500; // 每段约 500 字

/**
 * 加载知识库
 */
function loadKnowledgeBase() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : { documents: [], chunks: [] };
    } catch (_) { return { documents: [], chunks: [] }; }
}

function saveKnowledgeBase(kb) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(kb));
    } catch (_) { /* ignore */ }
}

/**
 * 文档分段
 */
function splitIntoChunks(text, docId) {
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let buffer = '';

    for (const para of paragraphs) {
        if ((buffer + para).length > CHUNK_SIZE && buffer.length > 0) {
            chunks.push({
                id: `${docId}-${chunks.length}`,
                docId,
                content: buffer.trim(),
                keywords: extractKeywords(buffer),
            });
            buffer = para;
        } else {
            buffer += (buffer ? '\n\n' : '') + para;
        }
    }
    if (buffer.trim()) {
        chunks.push({
            id: `${docId}-${chunks.length}`,
            docId,
            content: buffer.trim(),
            keywords: extractKeywords(buffer),
        });
    }
    return chunks;
}

/**
 * 简易关键词提取（TF-IDF 简化版）
 */
function extractKeywords(text) {
    // 中文按字/词分割，英文按空格
    const words = text
        .replace(/[^\u4e00-\u9fffA-Za-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1)
        .map(w => w.toLowerCase());

    const freq = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word]) => word);
}

/**
 * 添加文档到知识库
 */
export function addDocument(title, content) {
    const kb = loadKnowledgeBase();
    const docId = `doc-${Date.now()}`;
    const doc = { id: docId, title, addedAt: new Date().toISOString(), charCount: content.length };
    const newChunks = splitIntoChunks(content, docId);

    kb.documents.push(doc);
    kb.chunks.push(...newChunks);
    saveKnowledgeBase(kb);

    return { docId, chunksCount: newChunks.length };
}

/**
 * 删除文档
 */
export function removeDocument(docId) {
    const kb = loadKnowledgeBase();
    kb.documents = kb.documents.filter(d => d.id !== docId);
    kb.chunks = kb.chunks.filter(c => c.docId !== docId);
    saveKnowledgeBase(kb);
}

/**
 * 基于关键词的相似度搜索
 */
export function searchKnowledge(query, topK = 3) {
    const kb = loadKnowledgeBase();
    if (kb.chunks.length === 0) return [];

    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0) return [];

    // 计算每个 chunk 与查询的关键词重叠度
    const scored = kb.chunks.map(chunk => {
        const overlap = chunk.keywords.filter(k => queryKeywords.some(qk => k.includes(qk) || qk.includes(k)));
        return { ...chunk, score: overlap.length };
    });

    return scored
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

/**
 * 将搜索结果格式化为 Prompt 上下文
 */
export function formatRAGContext(query) {
    const results = searchKnowledge(query, 3);
    if (results.length === 0) return '';

    const lines = results.map((r, i) =>
        `[参考 ${i + 1}] ${r.content.slice(0, 300)}`
    );

    return `\n### 知识库参考\n以下是从企业知识库中检索到的相关内容：\n${lines.join('\n\n')}\n`;
}

/**
 * 获取知识库统计
 */
export function getKnowledgeStats() {
    const kb = loadKnowledgeBase();
    return {
        documentCount: kb.documents.length,
        chunkCount: kb.chunks.length,
        documents: kb.documents,
    };
}

/**
 * 清空知识库
 */
export function clearKnowledge() {
    saveKnowledgeBase({ documents: [], chunks: [] });
}

export default { addDocument, removeDocument, searchKnowledge, formatRAGContext, getKnowledgeStats, clearKnowledge };
