#!/usr/bin/env node

import { readdirSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { analyzeFileWithLimit, needsAnalysis, saveAnalysis } from './analyze-file-safe.js';

const COMPONENTS_DIR = '/Users/xd/Desktop/claude-code/components';
const MAX_ITERATIONS = 100;
const DASHSCOPE_MAX_LENGTH = 30720;

function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        traverse(fullPath);
      } else if (entry.isFile() && (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

function getProgressReport(allFiles: string[], analyzedFiles: Set<string>): string {
  const remaining = allFiles.filter(f => !analyzedFiles.has(f));
  const largeFiles = remaining.filter(f => statSync(f).size > DASHSCOPE_MAX_LENGTH);
  
  return `
=== 进度报告 ===
总文件数: ${allFiles.length}
已分析: ${analyzedFiles.size}
剩余: ${remaining.length}
大文件(>30KB): ${largeFiles.length}

剩余文件列表:
${remaining.slice(0, 10).map(f => `  - ${basename(f)}`).join('\n')}
${remaining.length > 10 ? `  ... 还有 ${remaining.length - 10} 个文件` : ''}
  `;
}

async function main() {
  console.log('🚀 开始分析 TypeScript 文件...\n');
  
  const allFiles = findTypeScriptFiles(COMPONENTS_DIR);
  const analyzedFiles = new Set<string>();
  
  // 加载已分析的文件列表
  allFiles.forEach(file => {
    if (!needsAnalysis(file)) {
      analyzedFiles.add(file);
    }
  });
  
  console.log(`📊 找到 ${allFiles.length} 个 TypeScript 文件`);
  console.log(`✅ 已分析: ${analyzedFiles.size} 个`);
  console.log(`📝 待分析: ${allFiles.length - analyzedFiles.size} 个\n`);
  
  // 每10个文件检查一次进度
  const CHECKPOINT_INTERVAL = 10;
  let iteration = 0;
  
  for (const filePath of allFiles) {
    if (analyzedFiles.has(filePath)) {
      continue;
    }
    
    iteration++;
    if (iteration > MAX_ITERATIONS) {
      console.log(`\n⚠️  达到最大迭代次数: ${MAX_ITERATIONS}`);
      break;
    }
    
    const fileName = basename(filePath);
    const fileSize = statSync(filePath).size;
    
    console.log(`[${iteration}/${MAX_ITERATIONS}] 📄 ${fileName}`);
    
    if (fileSize > DASHSCOPE_MAX_LENGTH) {
      console.warn(`   ⚠️  大文件: ${fileSize} chars (limit: ${DASHSCOPE_MAX_LENGTH})`);
    }
    
    try {
      const analysis = analyzeFileWithLimit(filePath);
      saveAnalysis(filePath, analysis);
      analyzedFiles.add(filePath);
      
      console.log(`   ✅ 完成\n`);
    } catch (error) {
      console.error(`   ❌ 失败: ${error.message}\n`);
    }
    
    // 每10个文件显示进度
    if (iteration % CHECKPOINT_INTERVAL === 0) {
      console.log('═══════════════════════════════════════');
      console.log(getProgressReport(allFiles, analyzedFiles));
      console.log('═══════════════════════════════════════\n');
    }
  }
  
  console.log('🏁 分析完成！');
  console.log(getProgressReport(allFiles, analyzedFiles));
}

main().catch(console.error);
