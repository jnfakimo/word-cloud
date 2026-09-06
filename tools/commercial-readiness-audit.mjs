#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root=path.resolve(process.cwd());
const artifactDir=path.join(root,'_site');
if (!fs.existsSync(path.join(artifactDir,'v2','index.html'))) throw new Error('請先建置完整網站產物，再執行發布稽核。');
const findings=[];
const add=(severity,rule,file,message)=>findings.push({severity,rule,file:path.relative(root,file).replaceAll('\\','/'),message});

function walk(dir,predicate){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    // removed-edge-functions 是刻意留底的已移除函式原始碼（見 ARCHITECTURE_V2.md），
    // 不會被部署也不該被當成現役程式碼稽核；掃它只會讓已處置的舊版本永遠亮紅燈。
    if(['.git','plans','vendor','node_modules','removed-edge-functions','.next','out','_site','dist','run'].includes(entry.name))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...walk(full,predicate));
    else if(predicate(full))out.push(full);
  }
  return out;
}

function stripScriptsAndStyles(html){
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
}

function resolveAsset(file, raw) {
  const clean=decodeURIComponent(raw.split(/[?#]/,1)[0]);
  if (!clean) return file;
  const relative=clean.replace(/^\/(?:Inspection|word-cloud)(?:\/|$)/, '/');
  return relative.startsWith('/') ? path.resolve(artifactDir, '.'+relative) : path.resolve(path.dirname(file), relative);
}

function auditHtml(file){
  const html=fs.readFileSync(file,'utf8');
  if(!/<meta\s+charset=["']?utf-8/i.test(html))add('error','html-charset',file,'缺少 UTF-8 charset。');
  if(!/<meta\s+name=["']viewport["']/i.test(html))add('error','html-viewport',file,'缺少 responsive viewport。');
  if(!/<title>[^<]+<\/title>/i.test(html))add('error','html-title',file,'缺少頁面標題。');
  if(!/http-equiv=["']Content-Security-Policy["']/i.test(html))add('error','content-security-policy',file,'缺少 Content Security Policy。');

  const visibleMarkup=stripScriptsAndStyles(html);
  const ids=[...visibleMarkup.matchAll(/\sid=["']([^"']+)["']/gi)].map(m=>m[1]);
  const duplicates=[...new Set(ids.filter((id,index)=>ids.indexOf(id)!==index))];
  duplicates.forEach(id=>add('error','duplicate-id',file,`重複 DOM id：${id}`));

  for(const match of visibleMarkup.matchAll(/<a\b([^>]*\btarget=["']_blank["'][^>]*)>/gi)){
    if(!/\brel=["'][^"']*\bnoopener\b/i.test(match[1]))add('error','noopener',file,'target="_blank" 連結缺少 rel="noopener"。');
  }

  for(const match of html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)){
    const raw=match[1];
    if(!raw||/^(?:[a-z]+:|\/\/|#|data:|javascript:|mailto:|tel:)/i.test(raw)||/[${}]/.test(raw))continue;
    const clean=raw.split(/[?#]/,1)[0];
    if(!clean)continue;
    let target;
    try{target=resolveAsset(file,raw);}catch{add('error','invalid-asset-url',file,`資源網址編碼錯誤：${raw}`);continue;}
    if(!fs.existsSync(target))add('error','missing-asset',file,`找不到本機資源：${raw}`);
  }

  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    const attrs=match[1],code=match[2].trim();
    const external=attrs.match(/\bsrc=["'](https:\/\/[^"']+)["']/i);
    if(external&&!/\bintegrity=["']sha(?:256|384|512)-/i.test(attrs))add('error','script-integrity',file,`外部程式缺少 SRI：${external[1]}`);
    if(!code||/\bsrc\s*=/i.test(attrs)||/\btype=["'](?:module|application\/ld\+json|application\/json)["']/i.test(attrs))continue;
    try{new vm.Script(code,{filename:path.relative(root,file)});}catch(error){add('error','inline-js-syntax',file,String(error.message).split('\n')[0]);}
  }
  for(const match of html.matchAll(/<link\b([^>]*\brel=["']stylesheet["'][^>]*)>/gi)){
    const external=match[1].match(/\bhref=["'](https:\/\/(?!fonts\.googleapis\.com)[^"']+)["']/i);
    if(external&&!/\bintegrity=["']sha(?:256|384|512)-/i.test(match[1]))add('error','stylesheet-integrity',file,`外部樣式缺少 SRI：${external[1]}`);
  }

  if(/https?:\/\/api\.ipify\.org/i.test(html))add('error','third-party-ip',file,'前端將使用者 IP 傳送至未受控第三方。');
  if(/@supabase\/supabase-js@2(?:["'\/])/i.test(html))add('error','floating-supabase-version',file,'Supabase 套件不可使用浮動 @2 版本。');
  if(/\.storage\.from\(["'](?:repair-files|handover-attachments|vehicle-dispatch-files)["']\)\.getPublicUrl/i.test(html))add('error','public-business-file',file,'業務附件不可產生永久公開網址。');
  if(/new Date\(\)\.toISOString\(\)\.split\(["']T["']\)/.test(html))add('error','utc-date-only',file,'日期欄位不可用 UTC 截日，請使用 Asia/Taipei。');
  if(/\bzoom\s*:\s*\d+/i.test(stripScriptsAndStyles(html)))add('error','css-zoom',file,'頁面不可用 CSS zoom 縮放整體介面。');
  for(const match of html.matchAll(/http:\/\/([A-Za-z0-9.-]+(?::\d+)?)/gi)){
    if(!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(match[1]))add('warning','mixed-content',file,`非本機 HTTP 資源：${match[0]}`);
  }
}

function auditCss(file){
  const css=fs.readFileSync(file,'utf8');
  for(const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)){
    const raw=match[1];
    if(/^(?:data:|https?:|\/\/)/i.test(raw))continue;
    if(raw.startsWith('#'))continue;
    let target;
    try{target=resolveAsset(file,raw);}catch{add('error','invalid-asset-url',file,`資源網址編碼錯誤：${raw}`);continue;}
    if(!fs.existsSync(target))add('error','missing-css-asset',file,`找不到 CSS 資源：${raw}`);
  }
}

// Search Console 的驗證文字檔不是應用程式頁面。
const htmlFiles=walk(artifactDir,file=>file.endsWith('.html') && path.basename(file)!=='google620de73073c56d88.html');
htmlFiles.forEach(auditHtml);
walk(artifactDir,file=>file.endsWith('.css')).forEach(auditCss);

const sourceFiles=walk(root,file=>/\.(?:html|js|mjs|ts|sql|ya?ml|toml|json)$/i.test(file));
for(const file of sourceFiles){
  const text=fs.readFileSync(file,'utf8');
  if(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']eyJ/i.test(text))add('error','service-key-literal',file,'偵測到硬編碼 service_role JWT。');
  if(/@supabase\/supabase-js@2(?:["'/])/i.test(text))add('error','floating-supabase-version',file,'Supabase 套件不可使用浮動 @2 版本。');
  if(/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----\s*\r?\n[A-Za-z0-9+/=\r\n]{100,}\r?\n-----END (?:RSA |EC |)PRIVATE KEY-----/.test(text))add('error','private-key',file,'偵測到私鑰內容。');
}

findings.sort((a,b)=>a.severity.localeCompare(b.severity)||a.file.localeCompare(b.file)||a.rule.localeCompare(b.rule));
const counts={error:0,warning:0,info:0};
for(const finding of findings)counts[finding.severity]=(counts[finding.severity]||0)+1;

console.log(`Commercial readiness audit: ${htmlFiles.length} HTML files`);
console.log(`Errors: ${counts.error} | Warnings: ${counts.warning} | Info: ${counts.info}`);
for(const finding of findings)console.log(`[${finding.severity.toUpperCase()}] ${finding.file} (${finding.rule}) ${finding.message}`);
if(counts.error)process.exitCode=1;
