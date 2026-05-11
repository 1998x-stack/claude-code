const fs = require('fs');

// Comprehensive markdown to HTML converter
function convertMarkdownToHtml(md) {
  let html = md;
  
  // First, handle code blocks to prevent interfering with other parsing
  html = html.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langClass}>${escaped}</code></pre>`;
  });
  
  // Handle tables - find table blocks
  const tableRegex = /^\|.*\|$/gm;
  const tableMatches = [];
  let match;
  
  while ((match = tableRegex.exec(html)) !== null) {
    tableMatches.push(match.index);
  }
  
  // Process tables in reverse order to avoid index issues
  for (let i = tableMatches.length - 1; i >= 0; i--) {
    const startIdx = tableMatches[i];
    let endIdx = startIdx;
    let tableLines = [];
    
    // Extract all consecutive table lines
    const lines = html.substring(startIdx).split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        tableLines.push(line);
        endIdx += line.length + 1;
      } else {
        break;
      }
    }
    
    if (tableLines.length > 0) {
      let tableHtml = '<table>';
      let inBody = false;
      
      for (let j = 0; j < tableLines.length; j++) {
        const line = tableLines[j];
        const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
        
        // Check if this is a header separator
        const isSeparator = cells.every(cell => /^-+$/.test(cell.replace(/ /g, '')));
        
        if (isSeparator) {
          tableHtml += '</thead><tbody>';
          inBody = true;
        } else if (!inBody) {
          // Header row
          const thCells = cells.map(cell => `<th>${cell}</th>`).join('');
          tableHtml += `<thead><tr>${thCells}</tr></thead>`;
        } else {
          // Body row
          const tdCells = cells.map(cell => `<td>${cell}</td>`).join('');
          tableHtml += `<tr>${tdCells}</tr>`;
        }
      }
      
      tableHtml += '</tbody></table>';
      
      // Replace the table in the original HTML
      html = html.substring(0, startIdx) + tableHtml + html.substring(endIdx);
    }
  }
  
  // Headers
  html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
  
  // Bold and italic
  html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^\s\)]+)(?:\s+"([^"]+)")?\)/g, '<a href="$2" title="$3">$1</a>');
  html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2">$1</a>');
  
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^\s\)]+)(?:\s+"([^"]+)")?\)/g, '<img alt="$1" src="$2" title="$3">');
  
  // Blockquotes
  html = html.replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^>\s*$/gm, '<blockquote>');
  
  // Horizontal rules
  html = html.replace(/^---+$|^\*\*\*+$/gm, '<hr>');
  
  // Lists - handle nested lists properly
  const lines = html.split('\n');
  let result = [];
  let inUl = false;
  let inOl = false;
  let listStack = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const ulMatch = line.match(/^([\s]*)[*+-] (.*)$/);
    const olMatch = line.match(/^([\s]*)\d+\. (.*)$/);
    
    if (ulMatch) {
      const indent = ulMatch[1].length;
      const content = ulMatch[2];
      
      if (!inUl || (listStack.length > 0 && listStack[listStack.length - 1].indent !== indent)) {
        if (inOl) {
          result.push('</ol>');
          inOl = false;
        }
        if (!inUl) {
          result.push('<ul>');
          inUl = true;
        }
        listStack.push({type: 'ul', indent});
      }
      result.push(`<li>${content}</li>`);
    } else if (olMatch) {
      const indent = olMatch[1].length;
      const content = olMatch[2];
      
      if (!inOl || (listStack.length > 0 && listStack[listStack.length - 1].indent !== indent)) {
        if (inUl) {
          result.push('</ul>');
          inUl = false;
        }
        if (!inOl) {
          result.push('<ol>');
          inOl = true;
        }
        listStack.push({type: 'ol', indent});
      }
      result.push(`<li>${content}</li>`);
    } else {
      if (inUl) {
        result.push('</ul>');
        inUl = false;
        listStack = listStack.filter(item => item.type !== 'ul');
      }
      if (inOl) {
        result.push('</ol>');
        inOl = false;
        listStack = listStack.filter(item => item.type !== 'ol');
      }
      result.push(line);
    }
  }
  
  // Close any remaining lists
  if (inUl) result.push('</ul>');
  if (inOl) result.push('</ol>');
  
  html = result.join('\n');
  
  // Paragraphs - wrap lines that aren't already HTML elements
  html = html.replace(/^(?!<[h1-6]|<p|<blockquote|<hr|<ul|<ol|<table|<pre|<li|<\/)([^<].*?)$/gm, '<p>$1</p>');
  
  // Clean up empty paragraphs and other issues
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>|<ol>|<table>|<pre>)/g, '$1');
  html = html.replace(/(<\/ul>|<\/ol>|<\/table>|<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<li>)/g, '$1');
  html = html.replace(/(<\/li>)<\/p>/g, '$1');
  
  return html;
}

// Create styled HTML page
function createStyledHtml(title, subtitle, content) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Claude Code 源码解析</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0F172A;
            --bg-secondary: #1E293B;
            --bg-tertiary: #334155;
            --text-primary: #F8FAFC;
            --text-secondary: #CBD5E1;
            --accent-cyan: #00FFFF;
            --accent-purple: #8B5CF6;
            --accent-pink: #EC4899;
            --accent-green: #10B981;
            --border-color: #334155;
            --shadow-glow: 0 0 20px rgba(0, 255, 255, 0.3);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'IBM Plex Sans', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.7;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(139, 92, 246, 0.1) 0%, transparent 20%),
                radial-gradient(circle at 90% 80%, rgba(236, 72, 153, 0.1) 0%, transparent 20%),
                repeating-linear-gradient(45deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 11px),
                repeating-linear-gradient(-45deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 11px);
        }

        /* Navigation */
        nav {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: rgba(15, 23, 42, 0.95);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border-color);
            z-index: 1000;
            padding: 1rem 2rem;
        }

        .nav-container {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .logo {
            font-family: 'JetBrains Mono', monospace;
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--accent-cyan);
            text-shadow: var(--shadow-glow);
            letter-spacing: 2px;
        }

        .nav-links {
            display: flex;
            gap: 2rem;
            list-style: none;
            flex-wrap: wrap;
        }

        .nav-links a {
            color: var(--text-secondary);
            text-decoration: none;
            font-size: 0.9rem;
            transition: all 0.3s ease;
            position: relative;
            font-family: 'JetBrains Mono', monospace;
        }

        .nav-links a:hover {
            color: var(--accent-cyan);
            text-shadow: 0 0 10px var(--accent-cyan);
        }

        .nav-links a::after {
            content: '';
            position: absolute;
            bottom: -5px;
            left: 0;
            width: 0;
            height: 2px;
            background: var(--accent-cyan);
            transition: width 0.3s ease;
        }

        .nav-links a:hover::after {
            width: 100%;
        }

        /* Main Content */
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 6rem 2rem 4rem;
        }

        /* Header */
        .header {
            text-align: center;
            margin-bottom: 4rem;
            animation: fadeInDown 1s ease;
        }

        .header h1 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 3.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple), var(--accent-pink));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 1rem;
            letter-spacing: 3px;
            line-height: 1.2;
        }

        .header .subtitle {
            font-size: 1.2rem;
            color: var(--text-secondary);
            max-width: 600px;
            margin: 0 auto;
        }

        /* Article */
        .article {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 3rem;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            animation: fadeInUp 1s ease 0.2s both;
        }

        .article h1 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 2.5rem;
            color: var(--accent-cyan);
            margin: 0 0 2rem 0;
            border-bottom: 2px solid var(--accent-purple);
            padding-bottom: 1rem;
        }

        .article h2 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 2rem;
            color: var(--accent-cyan);
            margin: 2rem 0 1rem;
            border-bottom: 2px solid var(--accent-purple);
            padding-bottom: 0.5rem;
        }

        .article h3 {
            font-size: 1.5rem;
            color: var(--accent-purple);
            margin: 1.5rem 0 0.75rem;
        }

        .article h4 {
            font-size: 1.2rem;
            color: var(--accent-pink);
            margin: 1rem 0 0.5rem;
        }

        .article p {
            margin-bottom: 1.5rem;
            color: var(--text-primary);
        }

        .article blockquote {
            border-left: 4px solid var(--accent-green);
            padding-left: 1.5rem;
            margin: 2rem 0;
            font-style: italic;
            color: var(--text-secondary);
            background: var(--bg-tertiary);
            padding: 1.5rem;
            border-radius: 0 8px 8px 0;
        }

        .article code {
            background: var(--bg-tertiary);
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            color: var(--accent-green);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9rem;
        }

        .article pre {
            background: var(--bg-tertiary);
            padding: 1.5rem;
            border-radius: 8px;
            overflow-x: auto;
            margin: 1.5rem 0;
            border: 1px solid var(--border-color);
            box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.5);
        }

        .article pre code {
            background: none;
            padding: 0;
            color: var(--accent-cyan);
        }

        .article ul, .article ol {
            margin: 1.5rem 0;
            padding-left: 2rem;
        }

        .article li {
            margin-bottom: 0.5rem;
        }

        .article table {
            width: 100%;
            border-collapse: collapse;
            margin: 2rem 0;
            background: var(--bg-tertiary);
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid var(--border-color);
        }

        .article thead {
            background: var(--accent-purple);
        }

        .article th {
            color: white;
            padding: 1rem;
            text-align: left;
            font-weight: 600;
            font-family: 'JetBrains Mono', monospace;
        }

        .article td {
            padding: 1rem;
            border-bottom: 1px solid var(--border-color);
        }

        .article tbody tr:hover {
            background: rgba(139, 92, 246, 0.1);
        }

        .article tbody tr:last-child td {
            border-bottom: none;
        }

        .article hr {
            border: none;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--accent-cyan), transparent);
            margin: 3rem 0;
        }

        .article a {
            color: var(--accent-cyan);
            text-decoration: none;
            border-bottom: 1px dashed var(--accent-cyan);
            transition: all 0.3s ease;
        }

        .article a:hover {
            color: var(--accent-pink);
            border-bottom: 1px solid var(--accent-pink);
        }

        .article strong {
            color: var(--accent-cyan);
        }

        .article em {
            color: var(--accent-pink);
        }

        /* Footer */
        .footer {
            text-align: center;
            margin-top: 4rem;
            padding-top: 2rem;
            border-top: 1px solid var(--border-color);
            color: var(--text-secondary);
        }

        /* Animations */
        @keyframes fadeInDown {
            from {
                opacity: 0;
                transform: translateY(-30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Responsive */
        @media (max-width: 768px) {
            .header h1 {
                font-size: 2.5rem;
            }
            
            .nav-links {
                display: none;
            }
            
            .article {
                padding: 2rem;
            }
            
            .container {
                padding: 5rem 1rem 3rem;
            }
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--bg-primary);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--accent-purple);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--accent-cyan);
        }
    </style>
</head>
<body>
    <nav>
        <div class="nav-container">
            <div class="logo">CLAUDE CODE</div>
            <ul class="nav-links">
                <li><a href="index.html">首页</a></li>
                <li><a href="01_overview_architecture.html">架构概览</a></li>
                <li><a href="02_agent_engine_tools.html">Agent引擎</a></li>
                <li><a href="03_memory_architecture.html">记忆系统</a></li>
                <li><a href="04_coordinator_mode.html">协调器</a></li>
                <li><a href="05_kairos_autodream.html">KAIROS</a></li>
                <li><a href="06_security_antidistillation.html">安全机制</a></li>
                <li><a href="07_terminal_renderer_features.html">终端渲染</a></li>
                <li><a href="08_engineering_summary.html">工程总结</a></li>
            </ul>
        </div>
    </nav>

    <div class="container">
        <header class="header">
            <h1>${title}</h1>
            <p class="subtitle">${subtitle}</p>
        </header>

        <article class="article">
            ${content}
        </article>

        <footer class="footer">
            <p>© 2026 Claude Code Source Code Analysis Series | 基于泄露源码的技术教育分析</p>
        </footer>
    </div>
</body>
</html>`;
}

// Process all markdown files
const files = [
  '01_overview_architecture.md',
  '02_agent_engine_tools.md',
  '03_memory_architecture.md',
  '04_coordinator_mode.md',
  '05_kairos_autodream.md',
  '06_security_antidistillation.md',
  '07_terminal_renderer_features.md',
  '08_engineering_summary.md'
];

console.log('🚀 Starting conversion with ui-ux-pro-max styling...\n');

files.forEach((file, index) => {
  if (fs.existsSync(file)) {
    console.log(`📄 Processing file ${index + 1}/${files.length}: ${file}`);
    
    const md = fs.readFileSync(file, 'utf-8');
    const htmlContent = convertMarkdownToHtml(md);
    
    // Extract title (first h1)
    const titleMatch = md.match(/^# (.*$)/m);
    const title = titleMatch ? titleMatch[1] : 'Claude Code Analysis';
    
    // Extract subtitle (series index line)
    const subtitleMatch = md.match(/^> \*\*系列索引\*\*\s+[^>]+>\s+[^>]+>\s+(.*$)/m);
    const subtitle = subtitleMatch ? subtitleMatch[1] : '深度解析 Anthropic Claude Code 源码泄露事件';
    
    const htmlPage = createStyledHtml(title, subtitle, htmlContent);
    const outputFile = file.replace('.md', '.html');
    
    fs.writeFileSync(outputFile, htmlPage);
    console.log(`✅ Converted: ${file} → ${outputFile}\n`);
  } else {
    console.log(`❌ File not found: ${file}\n`);
  }
});

console.log('🎉 All files converted successfully with ui-ux-pro-max styling!');
