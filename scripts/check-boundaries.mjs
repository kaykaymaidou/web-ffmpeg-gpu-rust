import * as fs from 'node:fs';
import * as path from 'node:path';

const FORBIDDEN_RUST_CORE_PATTERNS = [
  { pattern: /\bstd::fs\b/, reason: 'Core must have zero filesystem I/O (pure in-memory streams)' },
  { pattern: /\bstd::net\b/, reason: 'Core must have zero network sockets (pure packet-level protocol)' },
  { pattern: /\bstd::process\b/, reason: 'Core must never invoke OS subprocesses' },
  { pattern: /\bstd::env\b/, reason: 'Core must not depend on OS environment variables' },
];

function scanDir(dir, ext, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'target' && entry.name !== 'node_modules') {
        scanDir(fullPath, ext, fileList);
      }
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

console.log('[INFO] [check-boundaries] Verifying monorepo architecture invariants...');

// 1. Check crates/core Rust Boundary
const coreSrcDir = path.resolve('crates/core/src');
const rustFiles = scanDir(coreSrcDir, '.rs');
let coreViolations = 0;

for (const file of rustFiles) {
  const relPath = path.relative('.', file);
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    // Ignore comments
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

    for (const { pattern, reason } of FORBIDDEN_RUST_CORE_PATTERNS) {
      if (pattern.test(line)) {
        console.error(`[FAIL] [check-boundaries] Violation in ${relPath}:${idx + 1}: ${reason}`);
        console.error(`       > ${trimmed}`);
        coreViolations++;
      }
    }
  });
}

// 2. Check .gitignore critical hygiene rules
const gitignorePath = path.resolve('.gitignore');
const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
const REQUIRED_IGNORES = ['target/', 'node_modules/', 'dist/', '*.exe', '*.dll', '*.raw'];
let gitignoreViolations = 0;

for (const rule of REQUIRED_IGNORES) {
  if (!gitignoreContent.includes(rule)) {
    console.error(`[FAIL] [check-boundaries] Missing required ignore pattern in .gitignore: '${rule}'`);
    gitignoreViolations++;
  }
}

// Summary
if (coreViolations === 0 && gitignoreViolations === 0) {
  console.log(`[PASS] [check-boundaries] All ${rustFiles.length} Rust core files conform to Zero-OS-I/O.`);
  console.log(`[PASS] [check-boundaries] .gitignore hygiene verified.`);
  console.log('[OK] Architecture invariants: 100% compliant.');
  process.exit(0);
} else {
  console.error(`[ERROR] [check-boundaries] Failed with ${coreViolations + gitignoreViolations} violation(s).`);
  process.exit(1);
}
