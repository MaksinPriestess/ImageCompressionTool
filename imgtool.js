#!/usr/bin/env node
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      const elapsedMs = Date.now() - t0;
      if (err) { err.stdout = stdout; err.stderr = stderr; err.elapsedMs = elapsedMs; reject(err); }
      else resolve({ stdout, stderr, elapsedMs });
    });
  });
}

async function fileSize(p) { try { const s = await fsp.stat(p); return s.size; } catch { return null; } }
async function* walk(dir, recursive = true) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) yield* walk(p, recursive); }
    else yield p;
  }
}
function extOf(p) { return path.extname(p).slice(1).toLowerCase(); }
function baseNameNoExt(p) { return path.basename(p, path.extname(p)); }

function matchFile(relPath, cfg) {
  const ext = extOf(relPath);
  if (!cfg.selection.includeExt.includes(ext)) return false;
  return !cfg.selection.excludePatterns.some(pat => relPath.includes(pat));
}
function ensureDirFor(filePath) { return fsp.mkdir(path.dirname(filePath), { recursive: true }); }

function outPathForStep(inputAbs, inRoot, outRoot, preserveTree, stepSuffix, forcedExt) {
  const rel = path.relative(inRoot, inputAbs);
  const dir = preserveTree ? path.dirname(rel) : '';
  const name = baseNameNoExt(rel).split(path.sep).join('__');
  const ext = forcedExt || extOf(rel);
  const filename = `${name}${stepSuffix}.${ext}`;
  return path.join(outRoot, dir, filename);
}

async function writeCsvHeader(csvPath) {
  if (fs.existsSync(csvPath)) return;
  await fsp.writeFile(csvPath, 'file,stage,src_size,out_size,delta,delta_pct,elapsed_ms,status,message\n', 'utf8');
}
async function appendCsv(csvPath, row) { await fsp.appendFile(csvPath, row + '\n', 'utf8'); }
function pct(a, b) { if (a == null || a === 0) return ''; return (((b - a) / a) * 100).toFixed(2); }

async function processOne(inputAbs, cfg) {
  const inRoot = path.resolve(cfg.paths.inputDir);
  const outRoot = path.resolve(cfg.paths.outputDir);
  const origSize = await fileSize(inputAbs);

  for (const step of cfg.pipeline) {
    if (!step.enabled) continue;
    const inExt = extOf(inputAbs);
    if (!step.matchExt.includes(inExt)) continue;

    const forcedExt = (step.name === 'mozjpeg') ? 'jpg' : null;
    const outFile = outPathForStep(inputAbs, inRoot, outRoot, cfg.options.preserveTree, step.suffix || '', forcedExt);
    await ensureDirFor(outFile);

    const srcForStep = inputAbs;
    const before = await fileSize(srcForStep);
    let after = null, status = 'ok', message = '', elapsedMs = 0;

    try {
      if (cfg.options.dryRun) {
        // Для проверки без утилит: просто копируем исходник под нужным именем
        await fsp.copyFile(srcForStep, outFile);
      } else {
        if (step.name === 'pngquant') {
          const profile = (cfg.profiles?.[step.profile]?.pngquant) || [];
          const args = [...profile, '--output', outFile, srcForStep];
          const r = await execFileAsync(cfg.paths.tools.pngquant, args);
          elapsedMs = r.elapsedMs;
        } else if (step.name === 'mozjpeg') {
          const profile = (cfg.profiles?.[step.profile]?.mozjpeg) || [];
          const args = [...profile, '-outfile', outFile, srcForStep];
          const r = await execFileAsync(cfg.paths.tools.mozjpeg, args);
          elapsedMs = r.elapsedMs;
        } else if (step.name === 'imagemagick_compress') {
          const profileArgs = (inExt === 'png')
            ? (cfg.profiles?.[step.profile]?.imagemagick_png || [])
            : (cfg.profiles?.[step.profile]?.imagemagick_jpg || []);
        
          // проверяем, есть ли PNG8: или другой формат-префикс
          let formatPrefix = null;
          const cleanArgs = [];
          for (const a of profileArgs) {
            if (typeof a === 'string' && a.endsWith(':')) formatPrefix = a;
            else cleanArgs.push(a);
          }
        
          const outTarget = formatPrefix ? formatPrefix + outFile : outFile;
          const r = await execFileAsync(cfg.paths.tools.magick, ['convert', srcForStep, ...cleanArgs, outTarget]);
          elapsedMs = r.elapsedMs;    
        } else {
          throw new Error(`Unknown step: ${step.name}`);
        }
      }
      after = await fileSize(outFile);
    } catch (e) {
      status = 'error';
      message = (e.stderr || e.message || '').replace(/\r?\n/g, ' ').slice(0, 300);
    }

    if (cfg.logging.writePerFile) {
      const delta = (after != null && before != null) ? (after - before) : '';
      const deltaPct = (after != null && before != null) ? pct(before, after) : '';
      const row = [
        outFile, step.name, before ?? '', after ?? '', delta, deltaPct, elapsedMs, status, JSON.stringify(message || '')
      ].map(v => ('' + v).replaceAll(',', ' ')).join(',');
      await appendCsv(cfg.logging.csvPath, row);
    }
  }

  const row = [
    inputAbs, 'ORIGINAL', origSize ?? '', origSize ?? '', 0, '0.00', '', 'ok', ''
  ].map(v => ('' + v).replaceAll(',', ' ')).join(',');
  await appendCsv(cfg.logging.csvPath, row);
}

async function main() {
  const configPath = process.argv[2] || path.resolve(process.cwd(), 'config.json');
  const cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'));

  await fsp.mkdir(cfg.paths.outputDir, { recursive: true });
  await writeCsvHeader(cfg.logging.csvPath);

  const inRoot = path.resolve(cfg.paths.inputDir);
  const tasks = [];
  for await (const abs of walk(inRoot, cfg.options.recursive)) {
    const rel = path.relative(inRoot, abs);
    if (matchFile(rel, cfg)) tasks.push(abs);
  }

  const conc = Math.max(1, Number(cfg.options.concurrency || 2));
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++; if (i >= tasks.length) break;
      const f = tasks[i];
      try { await processOne(f, cfg); console.log(`[${i + 1}/${tasks.length}] OK ${f}`); }
      catch (e) { console.error(`[${i + 1}/${tasks.length}] FAIL ${f}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  console.log('Done. CSV:', cfg.logging.csvPath);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

