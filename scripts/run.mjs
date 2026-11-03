import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
const cwd = fileURLToPath(new URL('../', import.meta.url));
try { loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = {...process.env};
// Honor explicit proxy settings; otherwise use the enabled Windows HTTP proxy.
if (process.platform === 'win32' && !env.HTTPS_PROXY && !env.HTTP_PROXY) {
  try {
    const raw = execFileSync('powershell.exe',['-NoProfile','-Command',"$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if($p.ProxyEnable -eq 1){$p.ProxyServer}"],{encoding:'utf8',windowsHide:true}).trim();
    const proxy = raw.includes('=') ? (raw.match(/(?:^|;)https=([^;]+)/)?.[1] || raw.match(/(?:^|;)http=([^;]+)/)?.[1]) : raw;
    if (proxy && /^[\w.-]+:\d+$/.test(proxy)) env.HTTPS_PROXY=env.HTTP_PROXY=`http://${proxy}`;
  } catch { /* Explicit environment configuration remains supported. */ }
}
env.NODE_USE_ENV_PROXY='1';
env.NO_PROXY=[env.NO_PROXY,'localhost','127.0.0.1'].filter(Boolean).join(',');
const children=[spawn(process.execPath,['--use-env-proxy','server/index.mjs'],{cwd,env,stdio:'inherit',windowsHide:true})];
if(!process.argv.includes('--production')) children.push(spawn(process.execPath,['node_modules/vite/bin/vite.js'],{cwd,env,stdio:'inherit',windowsHide:true}));
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children) child.kill();process.exitCode=code;}
children.forEach(child=>{child.on('error',err=>{console.error(err.message);stop(1);});child.on('exit',code=>stop(code??0));});
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
