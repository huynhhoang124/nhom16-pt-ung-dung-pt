// Test-only assembly of UNMERGED dependencies; never imports them into this PR's production tree.
// node scripts/prepare-pd04-candidate.mjs <PD02 checkout> <PD03 checkout> <new output directory>
import { cp,readFile,writeFile,mkdir,access } from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [pd02,pd03,out]=process.argv.slice(2);
if(!pd02||!pd03||!out)throw new Error('Supply PD-02 checkout, PD-03 checkout and NEW candidate directory');
try{await access(out);throw new Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(out,{recursive:true});
// cp only the small source directory (avoids traversing Windows node_modules junctions).
await cp(path.join(pd02,'parking-node','src'),path.join(out,'parking-node','src'),{recursive:true});
for(const name of ['package.json','package-lock.json','Dockerfile'])await cp(path.join(pd02,'parking-node',name),path.join(out,'parking-node',name));
await cp(path.join(pd03,'parking-node/src/reply-envelope.js'),path.join(out,'parking-node/src/reply-envelope.js'));
const commandFile=path.join(out,'parking-node/src/commands.js');
let source=await readFile(commandFile,'utf8');
if(!source.includes('await enrichReply(')){
  const beforeImport="const { tokenFor } = require('./gate');",beforeOutbox="      await c.query('INSERT INTO command_reply_outbox";
  if(!source.includes(beforeImport)||!source.includes(beforeOutbox))throw new Error('PD02_REPLY_HOOK_BASE_CHANGED');
  source=source.replace(beforeImport,beforeImport+"\nconst { enrichReply } = require('./reply-envelope');")
    .replace(beforeOutbox,"      await enrichReply(c, env, payload, properties, internalKey);\n"+beforeOutbox);
  await writeFile(commandFile,source);
}
const patch=path.join(root,'scripts/pd04-pd02-integration.patch');
for(const args of [['apply','--check',patch],['apply',patch]]){
  const r=spawnSync('git',args,{cwd:out,encoding:'utf8'});
  if(r.status!==0)throw new Error(r.stderr||'Candidate patch failed');
}
for(const file of ['admin-schema.sql','admin-integration.js','admin-commands.js','admin-payload.js','admin-guards.js','db.js'])
  await cp(path.join(root,'parking-node/src',file),path.join(out,'parking-node/src',file));
console.log('PD-04 test candidate prepared. Build context:',path.join(out,'parking-node'));
