import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename } from 'path';

const DASHSCOPE_MAX_LENGTH = 30720;

export function analyzeFileWithLimit(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath);
    
    console.log(`📄 分析文件: ${fileName} (${content.length} chars)`);
    
    if (content.length > DASHSCOPE_MAX_LENGTH) {
      console.warn(`⚠️  文件过大，需要截断: ${content.length} > ${DASHSCOPE_MAX_LENGTH}`);
    }
    
    const safeContent = truncateContent(content, fileName);
    const analysis = generateChineseAnalysis(safeContent, fileName);
    
    return analysis;
  } catch (error) {
    console.error(`❌ 分析失败: ${filePath}`, error);
    return `# 分析失败: ${filePath}\n\n错误: ${error.message}`;
  }
}

function truncateContent(content: string, fileName: string): string {
  if (content.length <= DASHSCOPE_MAX_LENGTH) {
    return content;
  }
  
  const lines = content.split('\n');
  const importantLines: string[] = [];
  let charCount = 0;
  
  for (const line of lines) {
    const isStructural = 
      line.startsWith('import') ||
      line.startsWith('export') ||
      line.includes('interface') ||
      line.includes('type ') ||
      line.includes('class ') ||
      line.includes('function ') ||
      (line.includes('const ') && line.includes('='));
    
    if (isStructural) {
      if (charCount + line.length > DASHSCOPE_MAX_LENGTH - 500) break;
      importantLines.push(line);
      charCount += line.length;
    }
  }
  
  const remainingSpace = DASHSCOPE_MAX_LENGTH - charCount - 500;
  if (remainingSpace > 1000) {
    const bodyLines = lines.filter(line => 
      !line.startsWith('import') && !line.startsWith('export')
    );
    
    const selectedBodyLines = bodyLines.slice(0, Math.floor(remainingSpace / 50));
    importantLines.push('\n// ... 实现代码 ...\n', ...selectedBodyLines);
  }
  
  const truncated = importantLines.join('\n');
  return truncated.substring(0, DASHSCOPE_MAX_LENGTH - 100) + 
         `\n\n// [文件被截断: 原始大小 ${content.length} chars]\n`;
}

function generateChineseAnalysis(content: string, fileName: string): string {
  const lineCount = content.split('\n').length;
  const componentName = fileName.replace(/\.tsx?$/, '');
  
  const analysis = `# ${componentName} 组件分析

## 文件信息
- **文件名**: ${fileName}
- **行数**: ${lineCount}
- **大小**: ${content.length} 字符

## 功能概述
[AI分析内容]

## 主要导出
[组件、函数、类型等]

## 依赖关系
[import分析]

## 实现细节
[代码结构分析]

## 使用示例
\`\`\`typescript
// 使用示例代码
\`\`\`

## 注意事项
[重要提示和最佳实践]
`;
  
  return analysis;
}

/**
 * Check if file needs analysis
 */
export function needsAnalysis(filePath: string): boolean {
  const analysisPath = `${filePath}.analysis.md`;
  return !existsSync(analysisPath);
}

/**
 * Save analysis to file
 */
export function saveAnalysis(filePath: string, analysis: string): void {
  const analysisPath = `${filePath}.analysis.md`;
  writeFileSync(analysisPath, analysis, 'utf-8');
  console.log(`✅ 分析完成: ${analysisPath}`);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: tsx analyze-file-safe.ts <file-path>');
    process.exit(1);
  }
  
  const analysis = analyzeFileWithLimit(filePath);
  saveAnalysis(filePath, analysis);
}
