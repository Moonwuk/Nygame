#!/usr/bin/env node
// Aggregates SARIF + pnpm-audit JSON from a directory tree into one Markdown report.
// Pure Node (no external deps — avoids the unpinned-install supply-chain vector).
//   node .github/scripts/summarize-security.mjs <inputDir> <outFile>
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.argv[2] ?? 'reports';
const outFile = process.argv[3] ?? 'security-report.md';
const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
const ref = process.env.GITHUB_REF_NAME ?? '';
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const LEVELS = ['error', 'warning', 'note', 'none'];
const ICON = { error: '🔴', warning: '🟠', note: '🔵', none: '⚪' };
const RANK = { error: 3, warning: 2, note: 1, none: 0 };
const norm = (lvl) => (LEVELS.includes(lvl) ? lvl : 'warning');

const files = walk(inputDir);
const perTool = new Map();
const totals = { error: 0, warning: 0, note: 0, none: 0 };
const findings = [];

const toolOf = (name) => {
  if (!perTool.has(name)) perTool.set(name, { error: 0, warning: 0, note: 0, none: 0 });
  return perTool.get(name);
};

for (const f of files.filter((f) => f.endsWith('.sarif') || f.endsWith('.sarif.json'))) {
  let data;
  try {
    data = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  for (const run of data.runs ?? []) {
    const name = run.tool?.driver?.name ?? 'Unknown';
    for (const r of run.results ?? []) {
      const level = norm(r.level);
      toolOf(name)[level]++;
      totals[level]++;
      const loc = r.locations?.[0]?.physicalLocation;
      findings.push({
        tool: name,
        level,
        rule: r.ruleId ?? '',
        path: loc?.artifactLocation?.uri ?? '',
        line: loc?.region?.startLine ?? '',
        msg: (r.message?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
  }
}

// pnpm audit (optional)
let auditLine = '_не запускался_';
const auditFile = files.find((f) => /pnpm-audit\.json$/.test(f));
if (auditFile) {
  try {
    const v = JSON.parse(readFileSync(auditFile, 'utf8')).metadata?.vulnerabilities ?? {};
    const total =
      (v.critical ?? 0) + (v.high ?? 0) + (v.moderate ?? 0) + (v.low ?? 0) + (v.info ?? 0);
    auditLine =
      total === 0
        ? '✅ 0 уязвимостей'
        : `🔴 critical ${v.critical ?? 0} · 🟠 high ${v.high ?? 0} · moderate ${v.moderate ?? 0} · low ${v.low ?? 0}`;
  } catch {
    /* ignore */
  }
}

// pnpm run check (optional)
let checkLine = '_неизвестно_';
const checkFile = files.find((f) => /check-status\.json$/.test(f));
if (checkFile) {
  try {
    const o = JSON.parse(readFileSync(checkFile, 'utf8')).check;
    checkLine =
      o === 'success' ? '✅ зелёный (lint+typecheck+test)' : `⚠️ ${o} (lint+typecheck+test)`;
  } catch {
    /* ignore */
  }
}

const sbom = files.find((f) => /\.cdx\.json$/i.test(f) || /sbom/i.test(f));

findings.sort((a, b) => RANK[b.level] - RANK[a.level] || a.tool.localeCompare(b.tool));
const CAP = 25;

const L = [];
L.push('## 🛡️ Security scan — сводный отчёт');
L.push('');
L.push(
  `**Коммит:** \`${sha || '—'}\`${ref ? ` · **ветка:** \`${ref}\`` : ''}${runUrl ? ` · [лог прогона](${runUrl})` : ''}`,
);
L.push('');
L.push('| Серьёзность | Σ |');
L.push('| --- | --: |');
for (const l of LEVELS) L.push(`| ${ICON[l]} ${l} | ${totals[l]} |`);
L.push('');
L.push(`**pnpm run check:** ${checkLine}  `);
L.push(`**pnpm audit:** ${auditLine}  `);
L.push(`**SBOM (CycloneDX):** ${sbom ? '✅ сгенерирован (артефакт)' : '—'}`);
L.push('');

if (perTool.size) {
  L.push('### По инструментам');
  L.push('| Инструмент | 🔴 | 🟠 | 🔵 |');
  L.push('| --- | --: | --: | --: |');
  for (const [name, c] of [...perTool.entries()].sort())
    L.push(`| ${name} | ${c.error} | ${c.warning} | ${c.note} |`);
  L.push('');
}

if (findings.length) {
  L.push(`### Находки (топ ${Math.min(CAP, findings.length)} из ${findings.length})`);
  L.push('| | Инструмент | Правило | Где | Сообщение |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const f of findings.slice(0, CAP)) {
    const where = f.path ? `\`${f.path}${f.line ? ':' + f.line : ''}\`` : '—';
    L.push(
      `| ${ICON[f.level]} | ${f.tool} | \`${f.rule}\` | ${where} | ${f.msg.replace(/\|/g, '\\|')} |`,
    );
  }
  if (findings.length > CAP)
    L.push(`\n_…и ещё ${findings.length - CAP}. Полные SARIF — в артефактах прогона._`);
  L.push('');
} else {
  L.push('_Сканеры не вернули находок (или SARIF недоступны в этом прогоне)._');
  L.push('');
}

L.push('---');
L.push(
  'ℹ️ _Информационный отчёт. Пайплайн **не блокирует** коммиты/мерж — сканеры гоняются на каждый push для видимости. Полные SARIF и SBOM — в артефактах прогона._',
);

writeFileSync(outFile, L.join('\n'));
process.stdout.write(L.join('\n') + '\n');
