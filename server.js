#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const VERSION = '2.4.0';
const CLI_ARGS = new Set(process.argv.slice(2));
if(CLI_ARGS.has('--help')||CLI_ARGS.has('-h')){console.log('Switchboard '+VERSION+'\n\nUsage: switchboard [--no-open]\n\nLaunches the local gateway at http://127.0.0.1:3141.\nAll providers, credentials, models, combos, and routes are configured in the dashboard.');process.exit(0);}
if(CLI_ARGS.has('--version')||CLI_ARGS.has('-v')){console.log(VERSION);process.exit(0);}
const AUTO_OPEN = !CLI_ARGS.has('--no-open');
const PORT = 3141;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 60000;
const STREAM_IDLE_TIMEOUT_MS = 180000;
const PORT_RETRY_COUNT = 5;
const PORT_RETRY_DELAY_MS = 1500;
const SHUTDOWN_GRACE_MS = 10000;
const LOCAL_AUTH_BYPASS = true;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
function defaultDataDir(){if(process.platform==='win32')return path.join(os.homedir(),'AppData','Roaming','Switchboard');if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Switchboard');return path.join(os.homedir(),'.config','switchboard');}
const DATA_DIR=defaultDataDir();
fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
const STATE_PATH=path.join(DATA_DIR,'switchboard-state.json');
const LOG_PATH=path.join(DATA_DIR,'switchboard.log');
const KEY_PATH=path.join(DATA_DIR,'switchboard.key');
function migrateLegacyFiles(){for(const name of ['switchboard-state.json','switchboard.log','switchboard.key']){const source=path.join(__dirname,name),destination=path.join(DATA_DIR,name);try{if(source!==destination&&fs.existsSync(source)&&!fs.existsSync(destination))fs.copyFileSync(source,destination)}catch(error){console.warn('[Switchboard] Legacy '+name+' migration skipped:',error.message)}}}
migrateLegacyFiles();
const TOKENROUTER_BASE_URL = 'https://api.tokenrouter.com/v1';

const PROVIDER_DEFAULTS = {
  openai: { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  google: { name: 'Google AI Studio', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openrouter: { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  tokenrouter: { name: 'TokenRouter', kind: 'anthropic', baseUrl: TOKENROUTER_BASE_URL },
  nvidia: { name: 'NVIDIA NIM', kind: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  groq: { name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  custom: { name: 'Custom endpoint', kind: 'openai', baseUrl: '' }
};
const MODEL_ALIASES = Object.freeze({
  'full-stack': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-3-5-sonnet': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-3-5-sonnet-latest': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-3-7-sonnet': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-sonnet-4': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-sonnet-4-5': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-sonnet-5': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'claude-opus-4': ['gemini-1.5-pro', 'gemini-2.5-flash'],
  'claude-haiku': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'gemini-2.5-flash': ['gemini-2.5-flash', 'gemini-1.5-pro'],
  'gemini-1.5-pro': ['gemini-1.5-pro', 'gemini-2.5-flash']
});
const REQUIRED_CLIENT_MODELS = Object.freeze(['full-stack', 'gemini-2.5-flash']);

function emptyState(){return {version:2,providers:[],models:[],combos:[],keys:[],settings:{defaultRoute:'',defaultModel:'gemini-2.5-flash'},counters:{model:1,combo:1,key:1}};}
function loadState(){
  try{
    if(!fs.existsSync(STATE_PATH))return emptyState();
    const parsed=JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));
    const state={...emptyState(),...parsed};
    state.providers=Array.isArray(state.providers)?state.providers:[];
    state.models=Array.isArray(state.models)?state.models:[];
    state.combos=Array.isArray(state.combos)?state.combos:[];
    state.keys=Array.isArray(state.keys)?state.keys:[];
    state.settings={...emptyState().settings,...(state.settings||{})};
    state.counters={...emptyState().counters,...(state.counters||{})};
    for(const provider of state.providers){if(provider.id==='tokenrouter')provider.base_url=TOKENROUTER_BASE_URL;}
    return state;
  }catch(error){console.warn('[Switchboard] State file could not be loaded; starting clean:',error.message);return emptyState();}
}
const state=loadState();
const routeCache=new Map(),providerKeyCache=new Map();
function invalidateRuntimeCaches(){routeCache.clear();providerKeyCache.clear();}
let stateWriteQueue=Promise.resolve();
let logWriteQueue=Promise.resolve(),pendingLogWrites=0;
const MAX_PENDING_LOG_WRITES=2000;
function persistState(){
  invalidateRuntimeCaches();
  const snapshot=JSON.stringify(state,null,2), temp=STATE_PATH+'.tmp';
  stateWriteQueue=stateWriteQueue.catch(()=>{}).then(async()=>{await fsp.mkdir(path.dirname(STATE_PATH),{recursive:true});await fsp.writeFile(temp,snapshot,{encoding:'utf8',mode:0o600});await fsp.rename(temp,STATE_PATH);}).catch(error=>{console.warn('[Switchboard] State persistence skipped:',error.message);});
  return stateWriteQueue;
}
function now(){return new Date().toISOString();}
function logRequest(value){
  const row={requested_model:value.requested,resolved_model:value.resolved||null,provider_id:value.provider||null,endpoint:value.endpoint,status:Number(value.status)||500,latency_ms:Number(value.latency)||0,fallback_count:Number(value.fallbacks)||0,error:value.error?String(value.error).slice(0,2000):null,created_at:now()};
  const line=JSON.stringify(row)+'\n';
  if(pendingLogWrites>=MAX_PENDING_LOG_WRITES){try{console.warn('[Switchboard] Request log buffer full; dropping one nonessential log entry.');}catch{}return false;}
  pendingLogWrites++;
  logWriteQueue=logWriteQueue.catch(()=>{}).then(()=>fsp.appendFile(LOG_PATH,line,'utf8')).catch(error=>{try{console.warn('[Switchboard] Request log append skipped:',error.message);}catch{}}).finally(()=>{pendingLogWrites=Math.max(0,pendingLogWrites-1);});
  return true;
}
async function recentLogs(limit=40){
  try{const text=await fsp.readFile(LOG_PATH,'utf8');return text.trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);}catch(error){if(error.code!=='ENOENT')console.warn('[Switchboard] Log read skipped:',error.message);return [];}
}
function loadMasterKey(){
  if(fs.existsSync(KEY_PATH)){const key=Buffer.from(fs.readFileSync(KEY_PATH,'utf8').trim(),'hex');if(key.length===32)return key;throw new Error('switchboard.key is invalid');}
  const key=crypto.randomBytes(32);fs.writeFileSync(KEY_PATH,key.toString('hex'),{mode:0o600,flag:'wx'});return key;
}
const MASTER_KEY=loadMasterKey();
function encrypt(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',MASTER_KEY,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(part=>part.toString('base64url')).join('.');}
function decrypt(value){const [iv,tag,body]=String(value).split('.').map(part=>Buffer.from(part,'base64url')),decipher=crypto.createDecipheriv('aes-256-gcm',MASTER_KEY,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8');}
function keyHash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function cleanUrl(value){return String(value||'').trim().replace(/\/+$/,'');}
function normalizeProviderBase(value,kind,providerId='custom'){
  const input=String(value||'').trim();if(!input)throw new Error('Base URL is required');
  let parsed;try{parsed=new URL(input)}catch{throw new Error('Base URL must be a valid http:// or https:// URL');}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('Base URL must use http:// or https://');
  if(parsed.username||parsed.password)throw new Error('Put credentials in the API key field, not the URL');
  parsed.hash='';parsed.search='';
  let pathname=parsed.pathname.replace(/\/{2,}/g,'/').replace(/\/+$/,'');
  if(kind==='google')pathname=pathname.replace(/\/models(?:\/[^/:]+)?(?::(?:streamGenerateContent|generateContent))?$/i,'');
  else if(kind==='anthropic')pathname=pathname.replace(/\/(?:messages|models)$/i,'');
  else pathname=pathname.replace(/\/(?:chat\/completions|responses|models)$/i,'');
  pathname=pathname.replace(/\/+$/,'');
  if(providerId!=='custom'){
    if(kind==='google'&&!/\/v1(?:beta)?$/i.test(pathname))pathname+=(pathname?'':'')+'/v1beta';
    else if(kind!=='google'&&!/\/v\d+(?:beta)?$/i.test(pathname))pathname+=(pathname?'':'')+'/v1';
  }
  parsed.pathname=pathname||'/';
  return parsed.origin+(parsed.pathname==='/'?'':parsed.pathname);
}
function joinEndpoint(base,...segments){return cleanUrl(base)+'/'+segments.map(segment=>String(segment).replace(/^\/+|\/+$/g,'')).filter(Boolean).join('/');}
const ANSI_ESCAPE_PATTERN=/[\u001B\u009B][[\]\\()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
function sanitizeModelName(value){return String(value??'').replace(ANSI_ESCAPE_PATTERN,'').replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g,'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').trim().slice(0,256);}
function safeJson(text){try{return JSON.parse(text)}catch{return null}}
function isRetryable(status,text){return [408,409,425,429,500,502,503,504].includes(status)||(status===403&&/(?:no access|not authorized|not allowed|unsupported|unavailable|unknown).{0,80}model|model.{0,80}(?:no access|not authorized|not allowed|unsupported|unavailable|unknown)/i.test(text||''))||/rate.?limit|quota|overloaded|temporar|timeout/i.test(text||'');}
function authHeaders(kind,key){if(kind==='anthropic')return {'x-api-key':key,'anthropic-version':'2023-06-01'};if(kind==='google')return {'x-goog-api-key':key};return {Authorization:'Bearer '+key};}
function apiBase(baseUrl,kind,providerId='custom'){return normalizeProviderBase(baseUrl,kind,providerId);}
function createUpstreamRequest(url,options={}){
  const controller=new AbortController();let finished=false,timer=null;
  const clearTimer=()=>{if(timer){clearTimeout(timer);timer=null;}};
  const arm=(ms,message)=>{if(finished)return;clearTimer();timer=setTimeout(()=>{if(!controller.signal.aborted)controller.abort(new Error(message));},ms);timer.unref?.();};
  const cleanup=()=>{if(!finished){finished=true;clearTimer();}};
  const abort=reason=>{if(!controller.signal.aborted)controller.abort(reason||new Error('Upstream request aborted'));cleanup();};
  arm(TIMEOUT_MS,'Upstream did not respond within '+TIMEOUT_MS+'ms');
  const response=fetch(url,{...options,signal:controller.signal}).then(value=>{clearTimer();return value;}).catch(error=>{cleanup();throw error;});
  const startBody=()=>arm(STREAM_IDLE_TIMEOUT_MS,'Upstream response body timed out after '+STREAM_IDLE_TIMEOUT_MS+'ms');
  const touch=()=>arm(STREAM_IDLE_TIMEOUT_MS,'Upstream stream was idle for '+STREAM_IDLE_TIMEOUT_MS+'ms');
  return {response,controller,cleanup,abort,startBody,touch};
}
function upstreamError(error){if(error&&(error.name==='AbortError'||/abort|timeout|timed out/i.test(error.message||'')))return new Error(error.message||'Upstream timeout');return error instanceof Error?error:new Error(String(error));}
async function readUpstreamText(response,pending){pending.startBody();try{return await response.text();}finally{pending.cleanup();}}
function modelUrl(provider){return joinEndpoint(apiBase(provider.base_url,provider.kind,provider.id||'custom'),'models');}
function parseModels(kind,data){const list=Array.isArray(data?.data)?data.data:Array.isArray(data?.models)?data.models:[];return list.map(item=>{const raw=typeof item==='string'?item:(item.id||item.name||item.model),id=String(raw||'').replace(/^models\//,'');return {id,name:String(item.displayName||item.display_name||item.name||item.id||id).replace(/^models\//,''),metadata:item}}).filter(model=>model.id&&(kind!=='google'||!model.metadata.supportedGenerationMethods||model.metadata.supportedGenerationMethods.includes('generateContent')));}
function targetForProvider(provider,modelId){if(!provider||provider.enabled===false)return null;const tokenRouter=provider.id==='tokenrouter';return {model_id:modelId,provider_id:provider.id,provider_name:provider.name,kind:provider.kind,base_url:tokenRouter?TOKENROUTER_BASE_URL:provider.base_url,api_key_enc:provider.api_key_enc};}
function providerTarget(model){return targetForProvider(state.providers.find(item=>item.id===model.provider_id),model.model_id);}
function aliasCandidates(requested){const key=String(requested||'').trim().toLowerCase();if(MODEL_ALIASES[key])return [...MODEL_ALIASES[key]];if(/^claude-(?:3(?:[-.]5|[-.]7)|sonnet|opus|haiku)/.test(key))return key.includes('opus')?['gemini-1.5-pro','gemini-2.5-flash']:['gemini-2.5-flash','gemini-1.5-pro'];if(/^gemini[-/.]/.test(key))return [key.replace(/^models\//,'')];return [];}
function resolveGoogleAlias(requested,allowCustom=false){const candidates=aliasCandidates(requested);if(!candidates.length&&allowCustom)candidates.push('gemini-2.5-flash','gemini-1.5-pro');const rows=state.models.map(providerTarget).filter(target=>target?.kind==='google');const normalized=row=>String(row.model_id).toLowerCase().replace(/^models\//,'');const picked=[];for(const candidate of candidates){const key=candidate.toLowerCase(),match=rows.find(row=>(normalized(row)===key||normalized(row).startsWith(key+'-')||normalized(row).includes(key))&&!picked.includes(row));if(match)picked.push(match)}if(!picked.length){const flash=rows.find(row=>/gemini.*flash/i.test(row.model_id)),pro=rows.find(row=>/gemini.*pro/i.test(row.model_id));if(flash)picked.push(flash);if(pro&&!picked.includes(pro))picked.push(pro)}return picked;}
function tokenRouterTargets(provider,requested){
  const known=state.models.filter(model=>model.provider_id===provider.id),targets=[];
  const addModelId=modelId=>{const target=targetForProvider(provider,modelId);if(target&&!targets.some(item=>item.model_id.toLowerCase()===target.model_id.toLowerCase()))targets.push(target);};
  const findKnown=candidate=>known.find(model=>{const id=model.model_id.toLowerCase(),key=candidate.toLowerCase();return id===key||id.endsWith('/'+key)||id.includes(key);});
  const configuredModel=String(state.settings?.defaultModel||'').trim();if(configuredModel){const configured=findKnown(configuredModel);if(configured)addModelId(configured.model_id);}
  for(const candidate of aliasCandidates(requested)){const match=findKnown(candidate);if(match)addModelId(match.model_id);}
  for(const model of known)addModelId(model.model_id);
  if(!targets.length)addModelId(configuredModel||'gemini-2.5-flash');
  return targets;
}
function comboTargets(combo){return (combo?.modelIds||[]).map(id=>state.models.find(model=>model.id===id)).map(providerTarget).filter(Boolean);}
function configuredRouteTargets(reference){
  const value=String(reference||'').trim();if(!value)return [];
  const combo=state.combos.find(item=>item.alias.toLowerCase()===value.toLowerCase());if(combo)return comboTargets(combo);
  const split=value.match(/^([^/:]+)[:/](.+)$/);if(split){const provider=state.providers.find(item=>item.id.toLowerCase()===split[1].toLowerCase()),model=state.models.find(item=>item.provider_id===provider?.id&&item.model_id.toLowerCase()===split[2].toLowerCase());const target=model?providerTarget(model):null;return target?[target]:[];}
  return state.models.filter(model=>model.model_id.toLowerCase()===value.toLowerCase()).map(providerTarget).filter(Boolean);
}
function resolveTargetsUncached(requested){
  const defaultRoute=String(state.settings?.defaultRoute||'').trim();
  if(defaultRoute&&/^claude-/i.test(requested)){const configured=configuredRouteTargets(defaultRoute);if(configured.length)return configured;}
  const combo=state.combos.find(item=>item.alias.toLowerCase()===requested.toLowerCase());
  if(combo){const targets=comboTargets(combo),fallbacks=resolveGoogleAlias(requested,true);for(const target of fallbacks)if(!targets.some(item=>item.provider_id===target.provider_id&&item.model_id===target.model_id))targets.push(target);if(targets.length)return targets;}
  const split=requested.match(/^([^/:]+)[:/](.+)$/);if(split){const provider=state.providers.find(item=>item.id.toLowerCase()===split[1].toLowerCase()),model=state.models.find(item=>item.provider_id===provider?.id&&item.model_id.toLowerCase()===split[2].toLowerCase()),target=model?providerTarget(model):null;if(target)return [target];}
  const tokenRouter=state.providers.find(item=>item.id==='tokenrouter'&&item.enabled!==false);if(tokenRouter&&/^claude-/i.test(requested)){const targets=tokenRouterTargets(tokenRouter,requested),fallbacks=resolveGoogleAlias(requested);for(const fallback of fallbacks)if(!targets.some(item=>item.provider_id===fallback.provider_id&&item.model_id===fallback.model_id))targets.push(fallback);return targets;}
  const mapped=resolveGoogleAlias(requested);if(mapped.length)return mapped;
  const exact=state.models.map(providerTarget).filter(target=>target&&target.model_id.toLowerCase()===requested.toLowerCase());if(exact.length)return exact;
  return resolveGoogleAlias(requested,true);
}
function resolveTargets(requested){const key=String(requested||'').toLowerCase();const cached=routeCache.get(key);if(cached)return cached.slice();const targets=resolveTargetsUncached(requested);if(routeCache.size>=512)routeCache.delete(routeCache.keys().next().value);routeCache.set(key,targets);return targets.slice();}
function routeLabel(value){return sanitizeModelName(value).replace(/[\r\n']/g,char=>char==="'"?"\\'":' ');}
function isLoopback(req){const value=String(req.socket.remoteAddress||'').toLowerCase();return value==='127.0.0.1'||value==='::1'||value==='::ffff:127.0.0.1';}
function clientAuthorized(req){if(LOCAL_AUTH_BYPASS&&isLoopback(req))return true;const token=String(req.headers.authorization||req.headers['x-api-key']||'').replace(/^Bearer\s+/i,'');return !!state.keys.find(item=>!item.revoked_at&&item.key_hash===keyHash(token));}

function anthropicBlockToOpenAI(block) {
  if(!block||typeof block!=='object')return {type:'text',text:String(block||'')};
  if(block.type==='text')return {type:'text',text:block.text||''};
  if(block.type==='image'&&block.source?.type==='base64')return {type:'image_url',image_url:{url:'data:'+block.source.media_type+';base64,'+block.source.data}};
  if(block.type==='image'&&block.source?.type==='url')return {type:'image_url',image_url:{url:block.source.url}};
  return {type:'text',text:JSON.stringify(block)};
}
function anthropicToOpenAI(body, model) {
  const messages=[]; let system=body.system;
  if(Array.isArray(system))system=system.map(x=>x.text||'').join('\n');
  if(system)messages.push({role:'system',content:String(system)});
  for(const m of body.messages||[]){
    const blocks=Array.isArray(m.content)?m.content:[{type:'text',text:String(m.content||'')}];
    const toolResults=blocks.filter(x=>x?.type==='tool_result');
    const regular=blocks.filter(x=>x?.type!=='tool_result'&&x?.type!=='tool_use').map(anthropicBlockToOpenAI);
    const toolUses=blocks.filter(x=>x?.type==='tool_use');
    if(regular.length||toolUses.length){const out={role:m.role,content:regular.length===1&&regular[0].type==='text'?regular[0].text:regular};if(toolUses.length)out.tool_calls=toolUses.map(x=>({id:x.id,type:'function',function:{name:x.name,arguments:JSON.stringify(x.input||{})}}));messages.push(out);}
    for(const x of toolResults){const value=typeof x.content==='string'?x.content:(x.content||[]).map(v=>v?.type==='text'?(v.text||''):JSON.stringify(v)).join('\n');messages.push({role:'tool',tool_call_id:x.tool_use_id,content:value||'',is_error:!!x.is_error});}
  }
  const tools=(body.tools||[]).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.input_schema||{type:'object',properties:{}}}}));
  let toolChoice;if(body.tool_choice?.type==='auto')toolChoice='auto';else if(body.tool_choice?.type==='any')toolChoice='required';else if(body.tool_choice?.type==='tool')toolChoice={type:'function',function:{name:body.tool_choice.name}};
  return compact({model,messages,temperature:body.temperature,top_p:body.top_p,max_tokens:body.max_tokens||1024,stop:body.stop_sequences,stream:!!body.stream,tools:tools.length?tools:undefined,tool_choice:toolChoice});
}
function openAIContentToAnthropic(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return String(content||'');
  return content.map(x=>{if(x.type==='text'||x.text!==undefined)return {type:'text',text:x.text||''};const url=x.image_url?.url;if(url&&url.startsWith('data:')){const match=url.match(/^data:([^;]+);base64,(.+)$/);if(match)return {type:'image',source:{type:'base64',media_type:match[1],data:match[2]}};}if(url)return {type:'image',source:{type:'url',url}};return {type:'text',text:JSON.stringify(x)}});
}
function openAIToAnthropic(body, model) {
  const systems=[],messages=[];
  for(const m of body.messages||[]){
    if(m.role==='system'||m.role==='developer'){systems.push(typeof m.content==='string'?m.content:JSON.stringify(m.content));continue;}
    if(m.role==='tool'){messages.push({role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:typeof m.content==='string'?m.content:JSON.stringify(m.content||'')}]});continue;}
    let content=openAIContentToAnthropic(m.content);
    if(m.tool_calls?.length){const blocks=Array.isArray(content)?content:(content?[{type:'text',text:content}]:[]);for(const call of m.tool_calls){let input={};try{input=JSON.parse(call.function?.arguments||'{}')}catch{input={raw:call.function?.arguments||''}}blocks.push({type:'tool_use',id:call.id||('toolu_'+crypto.randomUUID()),name:call.function?.name||'tool',input});}content=blocks;}
    messages.push({role:m.role==='assistant'?'assistant':'user',content});
  }
  const tools=(body.tools||[]).map(t=>({name:t.function?.name||t.name,description:t.function?.description||t.description,input_schema:t.function?.parameters||t.input_schema||{type:'object',properties:{}}}));
  let toolChoice;if(body.tool_choice==='auto')toolChoice={type:'auto'};else if(body.tool_choice==='required')toolChoice={type:'any'};else if(body.tool_choice?.function?.name)toolChoice={type:'tool',name:body.tool_choice.function.name};
  return compact({model,messages,system:systems.join('\n')||undefined,max_tokens:body.max_tokens||body.max_completion_tokens||1024,temperature:body.temperature,top_p:body.top_p,stop_sequences:Array.isArray(body.stop)?body.stop:body.stop?[body.stop]:undefined,stream:!!body.stream,tools:tools.length?tools:undefined,tool_choice:toolChoice});
}
const GEMINI_UNSUPPORTED_SCHEMA_FIELDS=new Set(['$schema','additionalProperties','propertyNames','prefixItems','const','exclusiveMinimum','exclusiveMaximum','minContains','maxContains','uniqueItems']);
function sanitizeSchema(schema,seen=new WeakSet()){
  if(Array.isArray(schema))return schema.map(value=>sanitizeSchema(value,seen));
  if(!schema||typeof schema!=='object')return schema;
  if(seen.has(schema))return undefined;
  seen.add(schema);const clean={};
  for(const [key,value] of Object.entries(schema)){if(GEMINI_UNSUPPORTED_SCHEMA_FIELDS.has(key))continue;const sanitized=sanitizeSchema(value,seen);if(sanitized!==undefined)clean[key]=sanitized;}
  const typeIsArray=typeof clean.type==='string'?clean.type.toLowerCase().includes('array'):Array.isArray(clean.type)&&clean.type.some(type=>String(type).toLowerCase()==='array');
  const itemsMissing=clean.items==null||(typeof clean.items==='object'&&!Array.isArray(clean.items)&&Object.keys(clean.items).length===0);
  if(typeIsArray&&itemsMissing)clean.items={type:'string'};
  seen.delete(schema);return clean;
}
function sanitizeGeminiPayload(payload){
  const clean=typeof structuredClone==='function'?structuredClone(payload):JSON.parse(JSON.stringify(payload));
  for(const toolGroup of clean.tools||[])for(const declaration of toolGroup.functionDeclarations||[])declaration.parameters=sanitizeSchema(declaration.parameters||{type:'object',properties:{}});
  return clean;
}
function googleImagePart(url){const match=String(url||'').match(/^data:([^;]+);base64,(.+)$/);return match?{inlineData:{mimeType:match[1],data:match[2]}}:{fileData:{mimeType:'application/octet-stream',fileUri:url}};}
function toGoogle(body, model, inputFormat) {
  const oa=inputFormat==='anthropic'?anthropicToOpenAI(body,model):{...body,model};
  const contents=[],system=[],toolNames=new Map();
  for(const m of oa.messages||[]){
    if(m.role==='system'||m.role==='developer'){system.push(typeof m.content==='string'?m.content:JSON.stringify(m.content));continue;}
    const parts=[];
    if(m.role==='tool'){let response={result:m.content};try{response=JSON.parse(m.content)}catch{}parts.push({functionResponse:{name:m.name||toolNames.get(m.tool_call_id)||'tool',response}});}
    else {const blocks=Array.isArray(m.content)?m.content:[{type:'text',text:String(m.content||'')}];for(const x of blocks){if(x.type==='text'||x.text!==undefined)parts.push({text:x.text||''});else if(x.image_url?.url)parts.push(googleImagePart(x.image_url.url));}for(const call of m.tool_calls||[]){let args={};try{args=JSON.parse(call.function?.arguments||'{}')}catch{}const name=call.function?.name||'tool';if(call.id)toolNames.set(call.id,name);parts.push({functionCall:{name,args}});}}
    if(parts.length)contents.push({role:m.role==='assistant'?'model':'user',parts});
  }
  const declarations=(oa.tools||[]).map(t=>({name:t.function?.name||t.name,description:t.function?.description||t.description,parameters:sanitizeSchema(t.function?.parameters||t.input_schema||{type:'object',properties:{}})}));
  const anthropicThinking=inputFormat==='anthropic'?body.thinking:undefined;
  const thinkingBudget=anthropicThinking?.type==='enabled'?Math.max(0,Number(anthropicThinking.budget_tokens||0)):undefined;
  const payload={contents,generationConfig:{temperature:oa.temperature,topP:oa.top_p,maxOutputTokens:oa.max_tokens||oa.max_completion_tokens||1024,stopSequences:Array.isArray(oa.stop)?oa.stop:oa.stop?[oa.stop]:undefined,thinkingConfig:thinkingBudget!==undefined?{thinkingBudget,includeThoughts:true}:undefined},tools:declarations.length?[{functionDeclarations:declarations}]:undefined};
  if(system.length)payload.systemInstruction={parts:[{text:system.join('\n')}]};
  return compact(payload);
}
function compact(obj){ for(const k of Object.keys(obj)){ if(obj[k]===undefined) delete obj[k]; else if(obj[k]&&typeof obj[k]==='object'&&!Array.isArray(obj[k])) compact(obj[k]); } return obj; }
function forwardedProviderKey(target){
  const cacheId=target.provider_id+'\u0000'+target.api_key_enc;
  if(providerKeyCache.has(cacheId))return providerKeyCache.get(cacheId);
  const key=decrypt(target.api_key_enc);
  providerKeyCache.set(cacheId,key);
  return key;
}
function upstreamRequest(target, body, inputFormat) {
  const key=forwardedProviderKey(target), headers={'content-type':'application/json','accept':body.stream?'text/event-stream':'application/json',...authHeaders(target.kind,key)};
  if(target.kind==='anthropic') return {url:joinEndpoint(apiBase(target.base_url,'anthropic',target.provider_id),'messages'),headers,body:compact(inputFormat==='anthropic'?{...body,model:target.model_id}:openAIToAnthropic(body,target.model_id))};
  if(target.kind==='google'){ const method=body.stream?'streamGenerateContent?alt=sse':'generateContent'; const geminiBody=sanitizeGeminiPayload(toGoogle(body,target.model_id,inputFormat)); return {url:joinEndpoint(apiBase(target.base_url,'google',target.provider_id),'models',encodeURIComponent(target.model_id)+':'+method),headers,body:geminiBody}; }
  return {url:joinEndpoint(apiBase(target.base_url,'openai',target.provider_id),'chat/completions'),headers,body:compact(inputFormat==='openai'?{...body,model:target.model_id}:anthropicToOpenAI(body,target.model_id))};
}
function extractText(data, kind){ if(kind==='anthropic') return (data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''); if(kind==='google') return (((data.candidates||[])[0]||{}).content?.parts||[]).map(x=>x.text||'').join(''); return data.choices?.[0]?.message?.content||''; }
function extractToolCalls(data,kind){
  if(kind==='anthropic')return (data.content||[]).filter(x=>x.type==='tool_use').map(x=>({id:x.id||('toolu_'+crypto.randomUUID()),name:x.name,input:x.input||{}}));
  if(kind==='google')return ((((data.candidates||[])[0]||{}).content?.parts)||[]).filter(x=>x.functionCall).map(x=>({id:x.functionCall.id||('toolu_'+crypto.randomUUID()),name:x.functionCall.name,input:x.functionCall.args||{}}));
  return (data.choices?.[0]?.message?.tool_calls||[]).map(x=>{let input={};try{input=JSON.parse(x.function?.arguments||'{}')}catch{input={raw:x.function?.arguments||''}}return {id:x.id||('toolu_'+crypto.randomUUID()),name:x.function?.name||'tool',input}});
}
function normalizeNonStream(data,target,outputFormat,requested){
  const text=extractText(data,target.kind), tools=extractToolCalls(data,target.kind), id=data.id||('switchboard-'+crypto.randomUUID()), created=Math.floor(Date.now()/1000);
  const promptTokens=data.usage?.prompt_tokens||data.usage?.input_tokens||data.usageMetadata?.promptTokenCount||0, completionTokens=data.usage?.completion_tokens||data.usage?.output_tokens||data.usageMetadata?.candidatesTokenCount||0;
  if(outputFormat==='anthropic'){const content=[];if(text)content.push({type:'text',text});for(const t of tools)content.push({type:'tool_use',id:t.id,name:t.name,input:t.input});return {id,type:'message',role:'assistant',model:requested,content,stop_reason:tools.length?'tool_use':(data.stop_reason||(data.choices?.[0]?.finish_reason==='length'?'max_tokens':'end_turn')),stop_sequence:null,usage:{input_tokens:promptTokens,output_tokens:completionTokens}};}
  const message={role:'assistant',content:text||null};if(tools.length)message.tool_calls=tools.map(t=>({id:t.id,type:'function',function:{name:t.name,arguments:JSON.stringify(t.input)}}));return {id,object:'chat.completion',created,model:requested,choices:[{index:0,message,finish_reason:tools.length?'tool_calls':(data.choices?.[0]?.finish_reason||data.stop_reason||'stop')}],usage:{prompt_tokens:promptTokens,completion_tokens:completionTokens,total_tokens:data.usage?.total_tokens||data.usageMetadata?.totalTokenCount||promptTokens+completionTokens}};
}
function streamText(data,kind){ if(kind==='anthropic') return data.type==='content_block_delta'?(data.delta?.text||''):''; if(kind==='google')return (((data.candidates||[])[0]||{}).content?.parts||[]).map(x=>x.text||'').join(''); return data.choices?.[0]?.delta?.content||''; }
function streamHasToolEvent(data,kind){if(kind==='anthropic')return data.content_block?.type==='tool_use'||data.delta?.type==='input_json_delta';if(kind==='google')return (((data.candidates||[])[0]||{}).content?.parts||[]).some(x=>x.functionCall);return !!data.choices?.[0]?.delta?.tool_calls?.length;}
function streamHasTerminalEvent(data,kind){ if(kind==='anthropic')return data.type==='message_stop'||data.type==='message_delta'; if(kind==='google')return !!data.candidates?.[0]?.finishReason; return data.choices?.some(x=>x.finish_reason)||false; }
function inspectSseBuffer(buffer,kind){
  for(const line of buffer.split(/\r?\n/)){ if(!line.startsWith('data:'))continue; const raw=line.slice(5).trim(); if(raw==='[DONE]')return true; const data=safeJson(raw); if(data&&(streamText(data,kind)||streamHasToolEvent(data,kind)||streamHasTerminalEvent(data,kind)))return true; }
  return false;
}
async function writeSse(res,chunk){
  if(res.destroyed||res.writableEnded)throw new Error('Client connection closed');
  if(res.write(chunk))return;
  await new Promise((resolve,reject)=>{const clean=()=>{res.off('drain',ok);res.off('close',closed);res.off('error',failed);};const ok=()=>{clean();resolve();};const closed=()=>{clean();reject(new Error('Client connection closed'));};const failed=error=>{clean();reject(error);};res.once('drain',ok);res.once('close',closed);res.once('error',failed);});
}
async function streamFromComplete(res,data,target,outputFormat,requested){
  const normalized=normalizeNonStream(data,target,outputFormat,requested);
  res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  if(outputFormat==='anthropic'){
    await writeSse(res,'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:normalized.id,type:'message',role:'assistant',model:requested,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:normalized.usage?.input_tokens||0,output_tokens:0}}})+'\n\n');
    let index=0;
    for(const block of normalized.content||[]){
      if(block.type==='text'){await writeSse(res,'event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index,content_block:{type:'text',text:''}})+'\n\n');if(block.text)await writeSse(res,'event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}})+'\n\n');}
      else if(block.type==='tool_use'){await writeSse(res,'event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index,content_block:{type:'tool_use',id:block.id,name:block.name,input:{}}})+'\n\n');await writeSse(res,'event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input||{})}})+'\n\n');}
      await writeSse(res,'event: content_block_stop\ndata: '+JSON.stringify({type:'content_block_stop',index})+'\n\n');index++;
    }
    await writeSse(res,'event: message_delta\ndata: '+JSON.stringify({type:'message_delta',delta:{stop_reason:normalized.stop_reason||'end_turn',stop_sequence:null},usage:{output_tokens:normalized.usage?.output_tokens||0}})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }else{
    const choice=normalized.choices?.[0]||{},message=choice.message||{},delta={role:'assistant'};if(message.content!=null)delta.content=message.content;if(message.tool_calls)delta.tool_calls=message.tool_calls.map((call,index)=>({...call,index}));
    await writeSse(res,'data: '+JSON.stringify({id:normalized.id,object:'chat.completion.chunk',created:normalized.created,model:requested,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    await writeSse(res,'data: '+JSON.stringify({id:normalized.id,object:'chat.completion.chunk',created:normalized.created,model:requested,choices:[{index:0,delta:{},finish_reason:choice.finish_reason||'stop'}]})+'\n\ndata: [DONE]\n\n');
  }
  res.end();
}
async function primeStream(response,kind,pending){
  if(!response.body)throw new Error('Upstream returned no response body');
  const reader=response.body.getReader(), chunks=[]; let bytes=0, preview='';pending.touch();
  while(true){
    const item=await reader.read();
    if(item.done){ if(!bytes)throw new Error('Upstream returned an empty stream'); if(!inspectSseBuffer(preview,kind))throw new Error('Upstream closed before producing a usable SSE event'); return {reader,chunks}; }
    pending.touch();chunks.push(item.value); bytes+=item.value.byteLength; preview+=new TextDecoder().decode(item.value,{stream:true});
    if(inspectSseBuffer(preview,kind)||bytes>=1024*1024)return {reader,chunks};
  }
}
async function* eventData(reader,initialChunks,onChunk){ const decoder=new TextDecoder(); let buf=''; const consume=function*(value,done){ if(value)buf+=decoder.decode(value,{stream:!done}); const blocks=buf.split(/\r?\n\r?\n/); buf=blocks.pop(); for(const block of blocks)for(const line of block.split(/\r?\n/))if(line.startsWith('data:'))yield line.slice(5).trim(); }; for(const chunk of initialChunks){onChunk?.();yield* consume(chunk,false);} while(true){const item=await reader.read();if(item.value)onChunk?.();yield* consume(item.value,item.done);if(item.done)break;} if(buf.trim())for(const line of buf.split(/\r?\n/))if(line.startsWith('data:'))yield line.slice(5).trim(); }
function upstreamStreamParts(data,kind,state){
  const out=[];
  if(kind==='anthropic'){
    if(data.type==='content_block_start'&&data.content_block?.type==='tool_use'){const key=data.index??state.next;const tool={slot:state.next++,id:data.content_block.id||('toolu_'+crypto.randomUUID()),name:data.content_block.name||'tool'};state.tools.set(key,tool);out.push({type:'tool_start',...tool});}
    if(data.type==='content_block_delta'&&data.delta?.type==='input_json_delta'){const tool=state.tools.get(data.index)||{slot:state.next++,id:'toolu_'+crypto.randomUUID(),name:'tool'};state.tools.set(data.index,tool);out.push({type:'tool_delta',...tool,json:data.delta.partial_json||''});}
  }else if(kind==='google'){
    for(const part of (((data.candidates||[])[0]||{}).content?.parts||[])){if(part.functionCall){const tool={slot:state.next++,id:part.functionCall.id||('toolu_'+crypto.randomUUID()),name:part.functionCall.name||'tool'};out.push({type:'tool_start',...tool},{type:'tool_delta',...tool,json:JSON.stringify(part.functionCall.args||{})});}}
  }else{
    for(const call of data.choices?.[0]?.delta?.tool_calls||[]){const key=call.index??0;let tool=state.tools.get(key);if(!tool){tool={slot:state.next++,id:call.id||('toolu_'+crypto.randomUUID()),name:call.function?.name||'tool'};state.tools.set(key,tool);out.push({type:'tool_start',...tool});}if(call.function?.name)tool.name=call.function.name;if(call.function?.arguments)out.push({type:'tool_delta',...tool,json:call.function.arguments});}
  }
  const text=streamText(data,kind);if(text)out.unshift({type:'text',text});return out;
}
async function pipeStream(req,res,reader,initialChunks,target,outputFormat,requested,pending){
  let clientClosed=false,textStarted=false,hadTools=false,textIndex=null,anthropicIndex=0,heartbeat=null;const streamState={tools:new Map(),next:0};const anthropicToolIndexes=new Map();
  const onClose=()=>{clientClosed=true;try{pending.abort(new Error('Client disconnected'));}catch{}};res.once('close',onClose);
  const write=async chunk=>{
    if(clientClosed||res.destroyed||res.writableEnded)throw new Error('Client connection closed');
    if(res.write(chunk))return;
    await new Promise((resolve,reject)=>{const cleanup=()=>{res.off('drain',onDrain);res.off('close',onClosed);res.off('error',onError);};const onDrain=()=>{cleanup();resolve();};const onClosed=()=>{cleanup();reject(new Error('Client connection closed during backpressure'));};const onError=error=>{cleanup();reject(error);};res.once('drain',onDrain);res.once('close',onClosed);res.once('error',onError);});
  };
  try{
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    heartbeat=setInterval(()=>{if(!clientClosed&&!res.destroyed&&!res.writableEnded){try{res.write(': switchboard-keepalive\n\n');}catch{}}},15000);heartbeat.unref();
    const id='switchboard-'+crypto.randomUUID(),created=Math.floor(Date.now()/1000);
    if(outputFormat==='anthropic')await write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id,type:'message',role:'assistant',model:requested,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}})+'\n\n');
    for await(const raw of eventData(reader,initialChunks,()=>pending.touch())){
      if(raw==='[DONE]')break;const data=safeJson(raw);if(!data)continue;
      for(const part of upstreamStreamParts(data,target.kind,streamState)){
        if(outputFormat==='anthropic'){
          if(part.type==='text'){if(!textStarted){textStarted=true;textIndex=anthropicIndex++;await write('event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index:textIndex,content_block:{type:'text',text:''}})+'\n\n');}await write('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:textIndex,delta:{type:'text_delta',text:part.text}})+'\n\n');}
          else if(part.type==='tool_start'){hadTools=true;const index=anthropicIndex++;anthropicToolIndexes.set(part.slot,index);await write('event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index,content_block:{type:'tool_use',id:part.id,name:part.name,input:{}}})+'\n\n');}
          else if(part.type==='tool_delta'){hadTools=true;let index=anthropicToolIndexes.get(part.slot);if(index===undefined){index=anthropicIndex++;anthropicToolIndexes.set(part.slot,index);await write('event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index,content_block:{type:'tool_use',id:part.id,name:part.name,input:{}}})+'\n\n');}await write('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:part.json}})+'\n\n');}
        }else{
          if(part.type==='text')await write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:requested,choices:[{index:0,delta:{content:part.text},finish_reason:null}]})+'\n\n');
          else if(part.type==='tool_start'){hadTools=true;await write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:requested,choices:[{index:0,delta:{tool_calls:[{index:part.slot,id:part.id,type:'function',function:{name:part.name,arguments:''}}]},finish_reason:null}]})+'\n\n');}
          else if(part.type==='tool_delta')await write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:requested,choices:[{index:0,delta:{tool_calls:[{index:part.slot,function:{arguments:part.json}}]},finish_reason:null}]})+'\n\n');
        }
      }
    }
    if(!clientClosed){
      if(outputFormat==='anthropic'){if(textStarted)await write('event: content_block_stop\ndata: '+JSON.stringify({type:'content_block_stop',index:textIndex})+'\n\n');for(const index of anthropicToolIndexes.values())await write('event: content_block_stop\ndata: '+JSON.stringify({type:'content_block_stop',index})+'\n\n');await write('event: message_delta\ndata: '+JSON.stringify({type:'message_delta',delta:{stop_reason:hadTools?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:0}})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');}
      else await write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:requested,choices:[{index:0,delta:{},finish_reason:hadTools?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');res.end();
    }
  }catch(error){if(!clientClosed&&!res.destroyed){try{console.warn('[Switchboard] SSE stream ended safely:',error?.message||error);}catch{}try{if(!res.writableEnded){const message=String(error?.message||'Upstream stream failed');if(outputFormat==='anthropic')await write('event: error\ndata: '+JSON.stringify({type:'error',error:{type:'api_error',message}})+'\n\n');else await write('data: '+JSON.stringify({error:{type:'upstream_stream_error',message}})+'\n\ndata: [DONE]\n\n');res.end();}}catch{try{res.end();}catch{}}}}
  finally{if(heartbeat)clearInterval(heartbeat);res.off('close',onClose);pending.cleanup();try{await reader.cancel();}catch{}}
}


async function proxy(req,res,format){
  const start=Date.now(), requested=sanitizeModelName(req.body?.model), targets=resolveTargets(requested), endpoint=format==='openai'?'/v1/chat/completions':'/v1/messages';
  if(!requested)return res.status(400).json({error:{message:'model is required'}}); if(!targets.length)return res.status(503).json({error:{message:'No enabled model or combo found for '+requested}});
  let lastError='No target succeeded', fallback=0;
  for(const target of targets){
    try{
      const u=upstreamRequest(target,req.body,format), pending=createUpstreamRequest(u.url,{method:'POST',headers:u.headers,body:JSON.stringify(u.body)}); let response;
      try{response=await pending.response;}catch(error){pending.cleanup();throw upstreamError(error);}
      if(!response.ok){const text=await readUpstreamText(response,pending);if(isRetryable(response.status,text)){lastError=text.slice(0,800)||('HTTP '+response.status);fallback++;continue;} const data=safeJson(text);logRequest({requested,resolved:target.model_id,provider:target.provider_id,endpoint,status:response.status,latency:Date.now()-start,fallbacks:fallback,error:text.slice(0,800)});return res.status(response.status).json(data||{error:{message:text||'Upstream request failed'}});}
      if(req.body.stream){
        const contentType=String(response.headers.get('content-type')||'').toLowerCase();
        if(contentType.includes('application/json')){const text=await readUpstreamText(response,pending),data=safeJson(text);if(!data)throw new Error('Upstream returned invalid JSON instead of SSE');logRequest({requested,resolved:target.model_id,provider:target.provider_id,endpoint,status:200,latency:Date.now()-start,fallbacks:fallback});return await streamFromComplete(res,data,target,format,requested);}
        try{const primed=await primeStream(response,target.kind,pending);logRequest({requested,resolved:target.model_id,provider:target.provider_id,endpoint,status:200,latency:Date.now()-start,fallbacks:fallback});return await pipeStream(req,res,primed.reader,primed.chunks,target,format,requested,pending);}catch(error){pending.abort(error);lastError=upstreamError(error).message;fallback++;continue;}
      }
      const text=await readUpstreamText(response,pending);const data=safeJson(text);if(!data)throw new Error('Upstream returned invalid JSON');logRequest({requested,resolved:target.model_id,provider:target.provider_id,endpoint,status:200,latency:Date.now()-start,fallbacks:fallback});return res.json(normalizeNonStream(data,target,format,requested));
    }catch(rawError){const e=upstreamError(rawError);lastError=e.message;fallback++;}
  }
  logRequest({requested,endpoint,status:502,latency:Date.now()-start,fallbacks:fallback,error:lastError}); if(!res.headersSent)res.status(502).json({error:{type:'upstream_error',message:'All fallback models failed: '+lastError}});
}
async function handleProxyRequest(req,res,format){
  try{
    return await proxy(req,res,format);
  }catch(error){
    const requestId=crypto.randomUUID();
    try{console.error('[Switchboard] Proxy request '+requestId+' failed safely:',error);}catch{}
    if(res.destroyed||res.writableEnded)return;
    if(res.headersSent){try{res.end();}catch{}return;}
    const rawStatus=Number(error?.status||error?.statusCode||500),status=rawStatus>=400&&rawStatus<600?rawStatus:500;
    const message=status<500?(error?.message||'Invalid request'):'Switchboard could not complete the request';
    const payload=format==='anthropic'?{type:'error',error:{type:status===400?'invalid_request_error':'api_error',message,request_id:requestId}}:{error:{type:status===400?'invalid_request_error':'server_error',message,request_id:requestId}};
    try{res.status(status).json(payload);}catch(responseError){try{console.warn('[Switchboard] Failed to write protected error response:',responseError?.message||responseError);}catch{}}
  }
}

const DASHBOARD=String.raw`<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Switchboard — Local AI gateway</title>
<script>try{var saved=localStorage.getItem('switchboard-theme');var preferred=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=saved||preferred}catch(e){}</script>
<style>
:root{color-scheme:light;--canvas:#f6f6f4;--surface:#fff;--surface-2:#f1f1ef;--surface-3:#e8e8e5;--text:#242422;--muted:#74746f;--faint:#a3a39d;--border:#deded9;--border-strong:#c9c9c2;--blue:#286fbe;--blue-soft:#e9f2fb;--green:#347a58;--green-soft:#e7f3ec;--amber:#996515;--amber-soft:#fbf1dc;--red:#b84d45;--red-soft:#fae9e7;--shadow:0 1px 2px rgba(20,20,18,.04),0 10px 30px rgba(20,20,18,.035);--sidebar:248px}
html[data-theme="dark"]{color-scheme:dark;--canvas:#181817;--surface:#20201f;--surface-2:#292927;--surface-3:#343431;--text:#f3f3f1;--muted:#aaa9a3;--faint:#7d7c77;--border:#393936;--border-strong:#4a4a46;--blue:#74a8df;--blue-soft:#213346;--green:#78b995;--green-soft:#21372b;--amber:#d7aa5f;--amber-soft:#3b3020;--red:#e0877f;--red-soft:#432725;--shadow:0 1px 2px rgba(0,0,0,.16),0 14px 34px rgba(0,0,0,.12)}
*{box-sizing:border-box}html{font-size:16px}body{margin:0;background:var(--canvas);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}button,input,select{font:inherit;color:inherit}button{cursor:pointer}.app{min-height:100vh;display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;padding:24px 18px;border-right:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:11px;padding:0 8px 24px}.mark{width:34px;height:34px;border-radius:9px;background:var(--text);color:var(--surface);display:grid;place-items:center;font-size:14px;font-weight:750;letter-spacing:-.03em}.brand-name{font-weight:700;letter-spacing:-.02em}.brand-sub{font-size:12px;color:var(--muted);margin-top:-1px}.nav-label{padding:0 10px 7px;color:var(--faint);font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.nav{display:grid;gap:3px}.nav button{height:42px;border:0;border-radius:8px;background:transparent;color:var(--muted);display:flex;align-items:center;gap:11px;padding:0 11px;text-align:left;font-size:14px;font-weight:550}.nav button:hover{background:var(--surface-2);color:var(--text)}.nav button.active{background:var(--surface-2);color:var(--text);font-weight:650}.nav svg{width:18px;height:18px;stroke-width:1.8}.mobile-theme{display:none!important}.sidebar-foot{margin-top:auto;padding:16px 9px 2px;border-top:1px solid var(--border)}.online{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px var(--green-soft)}.storage{font-size:11px;color:var(--faint);margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace{min-width:0}.topbar{height:72px;padding:0 36px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--canvas) 90%,transparent);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}.page-title{font-size:15px;font-weight:680}.top-actions{display:flex;align-items:center;gap:8px}.icon-btn{height:36px;min-width:36px;border:1px solid var(--border);border-radius:8px;background:var(--surface);display:grid;place-items:center;padding:0 10px}.icon-btn:hover{border-color:var(--border-strong);background:var(--surface-2)}.content{max-width:1120px;margin:0 auto;padding:38px 38px 64px}.panel{display:none}.panel.active{display:block}.section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-bottom:24px}.section-head h1{font-size:28px;line-height:1.2;letter-spacing:-.035em;margin:0;font-weight:720}.section-head p{margin:7px 0 0;color:var(--muted);font-size:14px;max-width:620px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:28px}.stat{border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:16px 17px;box-shadow:var(--shadow)}.stat-label{font-size:12px;color:var(--muted);font-weight:600}.stat-value{font-size:22px;font-weight:720;letter-spacing:-.03em;margin-top:5px}.stat-value.small{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:9px}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{border:1px solid var(--border);background:var(--surface);border-radius:10px;box-shadow:var(--shadow)}.provider{padding:19px}.provider-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.provider-identity{display:flex;gap:12px;align-items:center}.provider-icon{width:38px;height:38px;border-radius:9px;background:var(--surface-2);border:1px solid var(--border);display:grid;place-items:center;font-size:13px;font-weight:750;color:var(--muted)}.provider-name{font-weight:680;letter-spacing:-.015em}.provider-meta{font-size:12px;color:var(--muted);margin-top:2px}.status{border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border)}.status.connected{color:var(--green);background:var(--green-soft);border-color:transparent}.status.off{color:var(--muted);background:var(--surface-2)}.status.error{color:var(--red);background:var(--red-soft);border-color:transparent}.form-grid{display:grid;grid-template-columns:152px minmax(0,1fr);gap:11px;margin-top:18px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:12px;color:var(--muted);font-weight:650}.input,.select{width:100%;height:40px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);padding:0 11px;outline:none;font-size:13px}.input:focus,.select:focus{border-color:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 14%,transparent)}.endpoint{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.45;color:var(--faint);overflow-wrap:anywhere;min-height:32px;margin-top:10px}.provider-actions{display:flex;align-items:center;gap:8px;margin-top:15px}.btn{height:38px;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:0 13px;font-size:13px;font-weight:650}.btn:hover{border-color:var(--border-strong);background:var(--surface-2)}.btn.primary{background:var(--text);color:var(--surface);border-color:var(--text)}.btn.primary:hover{opacity:.88}.btn.danger{color:var(--red)}.btn:disabled{opacity:.55;cursor:wait}.provider-actions .primary{flex:1}.last-test{margin-left:auto;color:var(--faint);font-size:11px}.notice{border-radius:8px;padding:10px 11px;margin-top:12px;font-size:12px}.notice.error{background:var(--red-soft);color:var(--red)}.route-card{padding:20px;margin-bottom:16px}.route-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.route-card h2,.builder h2,.list-title,.keys-card h2{font-size:17px;letter-spacing:-.02em;margin:0;font-weight:690}.route-card p,.builder-copy{font-size:13px;color:var(--muted);margin:5px 0 16px}.routing-grid{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(0,1.1fr);gap:16px}.builder{padding:20px}.stack{display:grid;gap:13px}.model-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.queue{list-style:none;margin:3px 0 0;padding:0;display:grid;gap:7px}.queue-empty,.empty{border:1px dashed var(--border-strong);border-radius:8px;padding:18px;color:var(--muted);font-size:13px;text-align:center;background:var(--canvas)}.queue-item{display:flex;align-items:center;gap:9px;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--canvas)}.queue-number{width:22px;color:var(--faint);font-size:12px;text-align:center}.queue-name{min-width:0;flex:1;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mini{width:30px;height:30px;border:0;border-radius:6px;background:transparent;color:var(--muted)}.mini:hover{background:var(--surface-2);color:var(--text)}.builder-actions{display:flex;gap:8px;margin-top:16px}.builder-actions .primary{flex:1}.combo-list{display:grid;gap:10px;margin-top:12px}.combo{padding:16px}.combo-top{display:flex;justify-content:space-between;gap:12px}.combo-name{font-weight:680}.combo-description{font-size:12px;color:var(--muted);margin-top:2px}.combo-actions{display:flex;gap:4px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}.chip{padding:5px 7px;border-radius:6px;background:var(--surface-2);font-size:11px;color:var(--muted)}.keys-card{padding:20px;max-width:760px}.inline-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:18px}.secret{margin-top:14px;background:var(--blue-soft);border:1px solid color-mix(in srgb,var(--blue) 24%,transparent);padding:14px;border-radius:8px}.secret-label{font-size:12px;color:var(--blue);font-weight:700}.secret-row{display:flex;gap:8px;margin-top:8px}.secret code{min-width:0;flex:1;background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:10px;font-size:12px;word-break:break-all}.key-list{display:grid;gap:8px;margin-top:20px}.key-row{border-top:1px solid var(--border);padding:13px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}.key-name{font-size:13px;font-weight:650}.key-meta{font-size:11px;color:var(--muted);margin-top:2px}.client-config{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}.client-config pre{margin:9px 0 0;padding:13px;border-radius:8px;background:var(--canvas);border:1px solid var(--border);font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.table-wrap{overflow:auto}.table-card{padding:0}.table-head{padding:18px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}.table-head h2{font-size:16px;margin:0}.table-head span{font-size:12px;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:var(--muted);font-weight:650;padding:11px 14px;background:var(--surface-2);white-space:nowrap}td{padding:12px 14px;border-top:1px solid var(--border);white-space:nowrap}.status-code.good{color:var(--green)}.status-code.bad{color:var(--red)}.toast-wrap{position:fixed;right:20px;bottom:20px;z-index:50;display:grid;gap:8px}.toast{max-width:360px;padding:11px 13px;border-radius:8px;background:var(--text);color:var(--surface);font-size:13px;box-shadow:0 12px 35px rgba(0,0,0,.2)}.toast.bad{background:var(--red);color:white}.hidden{display:none!important}
@media(max-width:900px){.app{grid-template-columns:1fr}.sidebar{height:auto;position:sticky;padding:12px 18px;border-right:0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:18px;z-index:20}.brand{padding:0}.brand-sub,.nav-label,.sidebar-foot{display:none}.nav{display:flex;overflow:auto}.nav button{height:38px;white-space:nowrap}.topbar{display:none}.content{padding:30px 22px 56px}.routing-grid{grid-template-columns:1fr}}
@media(max-width:680px){.sidebar{grid-template-columns:minmax(0,1fr) 36px;gap:8px}.brand{display:none}.nav{width:100%}.nav button{flex:1;justify-content:center;padding:0 8px}.nav button span{display:none}.mobile-theme{display:grid!important}.content{padding:24px 16px 48px}.section-head{align-items:flex-start;flex-direction:column}.section-head h1{font-size:24px}.stats,.provider-grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.route-row,.model-add,.inline-form{grid-template-columns:1fr}.provider-actions{flex-wrap:wrap}.last-test{width:100%;margin-left:0}.table-card{border-radius:8px}.toast-wrap{left:16px;right:16px}.toast{max-width:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<div class="app">
<aside class="sidebar">
  <div class="brand"><div class="mark">SB</div><div><div class="brand-name">Switchboard</div><div class="brand-sub">Local AI gateway</div></div></div>
  <div><div class="nav-label">Workspace</div><nav class="nav" aria-label="Dashboard navigation">
    <button class="active" data-tab="providers" data-title="Providers" aria-current="page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg><span>Providers</span></button>
    <button data-tab="routing" data-title="Routing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M7.5 7.5l3.4 8.3M16.5 7.5l-3.4 8.3"/></svg><span>Routing</span></button>
    <button data-tab="keys" data-title="Client keys"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/></svg><span>Client keys</span></button>
    <button data-tab="activity" data-title="Activity"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/></svg><span>Activity</span></button>
  </nav></div><button class="icon-btn mobile-theme" id="mobileThemeBtn" type="button" title="Toggle theme" aria-label="Toggle theme"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z"/></svg></button>
  <div class="sidebar-foot"><div class="online"><span class="dot"></span>Gateway online</div><div class="storage" id="storagePath">Local encrypted storage</div></div>
</aside>
<div class="workspace">
  <header class="topbar"><div class="page-title" id="pageTitle">Providers</div><div class="top-actions"><button class="icon-btn" id="refreshBtn" type="button" title="Refresh data" aria-label="Refresh data"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6v5h-5"/><path d="M18.2 15a7 7 0 1 1-.7-7.7L20 11"/></svg></button><button class="icon-btn" id="themeBtn" type="button" title="Toggle theme" aria-label="Toggle theme"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z"/></svg></button></div></header>
  <main class="content">
    <section class="panel active" id="providers">
      <div class="section-head"><div><h1>Provider connections</h1><p>Connect upstream services once. Credentials stay encrypted on this device and never appear in terminal sessions.</p></div><button class="btn" id="refreshProviders" type="button">Refresh</button></div>
      <div class="stats"><div class="stat"><div class="stat-label">Connected providers</div><div class="stat-value" id="providerCount">0</div></div><div class="stat"><div class="stat-label">Available models</div><div class="stat-value" id="modelCount">0</div></div><div class="stat"><div class="stat-label">Default Claude route</div><div class="stat-value small" id="routeSummary">Automatic fallback</div></div></div>
      <div class="provider-grid" id="providerGrid"></div>
    </section>
    <section class="panel" id="routing">
      <div class="section-head"><div><h1>Routing</h1><p>Choose a default destination for Claude, then build ordered fallbacks for graceful recovery.</p></div></div>
      <form id="routingForm" class="card route-card"><h2>Default Claude route</h2><p>Every incoming claude-* request uses this route while preserving the requested model name in responses.</p><div class="route-row"><div class="field"><label for="defaultRoute">Route</label><select class="select" id="defaultRoute"></select></div><button class="btn primary" type="submit">Save default</button></div></form>
      <div class="routing-grid"><form id="comboForm" class="card builder"><h2>New fallback combo</h2><p class="builder-copy">Models run top to bottom. Retryable errors automatically continue to the next option.</p><input id="comboId" type="hidden"><div class="stack"><div class="field"><label for="comboAlias">Alias</label><input class="input" id="comboAlias" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" placeholder="coding-default"></div><div class="field"><label for="comboDescription">Description</label><input class="input" id="comboDescription" placeholder="Fast primary, reliable fallback"></div><div class="field"><label for="modelPicker">Add model</label><div class="model-add"><select class="select" id="modelPicker"></select><button class="btn" id="addModel" type="button">Add</button></div></div><ol class="queue" id="queue"></ol></div><div class="builder-actions"><button class="btn primary" type="submit">Save combo</button><button class="btn" id="resetCombo" type="button">Clear</button></div></form><div><h2 class="list-title">Saved combos</h2><div class="combo-list" id="comboList"></div></div></div>
    </section>
    <section class="panel" id="keys">
      <div class="section-head"><div><h1>Client keys</h1><p>Optional keys for non-loopback clients. Local Claude traffic works with the bundled dummy credential.</p></div></div>
      <div class="card keys-card"><h2>Generate a client key</h2><form class="inline-form" id="keyForm"><input class="input" id="keyName" placeholder="VS Code laptop"><button class="btn primary" type="submit">Generate key</button></form><div class="secret hidden" id="newKey"><div class="secret-label">Copy now — this value is shown once</div><div class="secret-row"><code id="newKeyValue"></code><button class="btn" id="copyKey" type="button">Copy</button></div></div><div class="key-list" id="keyList"></div><div class="client-config"><div class="provider-name">Client configuration</div><pre>Base URL  http://127.0.0.1:3141/v1
Header    Authorization: Bearer sk-switchboard-…
Model     combo alias or provider/model-id</pre></div></div>
    </section>
    <section class="panel" id="activity">
      <div class="section-head"><div><h1>Activity</h1><p>Operational metadata only. Prompts and model responses are never recorded.</p></div><button class="btn" id="refreshActivity" type="button">Refresh</button></div>
      <div class="card table-card"><div class="table-head"><h2>Recent requests</h2><span>Latest 40</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Requested</th><th>Resolved route</th><th>Status</th><th>Latency</th><th>Fallbacks</th></tr></thead><tbody id="logs"></tbody></table></div></div>
    </section>
  </main>
</div>
</div>
<div class="toast-wrap" id="toasts" aria-live="polite"></div>
<script>
var $=function(selector){return document.querySelector(selector)};var $$=function(selector){return Array.prototype.slice.call(document.querySelectorAll(selector))};var queue=[];
var preview={providerDefaults:{openai:{name:'OpenAI',kind:'openai',baseUrl:'https://api.openai.com/v1'},anthropic:{name:'Anthropic',kind:'anthropic',baseUrl:'https://api.anthropic.com/v1'},google:{name:'Google AI Studio',kind:'google',baseUrl:'https://generativelanguage.googleapis.com/v1beta'},openrouter:{name:'OpenRouter',kind:'openai',baseUrl:'https://openrouter.ai/api/v1'},tokenrouter:{name:'TokenRouter',kind:'anthropic',baseUrl:'https://api.tokenrouter.com/v1'},groq:{name:'Groq',kind:'openai',baseUrl:'https://api.groq.com/openai/v1'},nvidia:{name:'NVIDIA NIM',kind:'openai',baseUrl:'https://integrate.api.nvidia.com/v1'},custom:{name:'Custom endpoint',kind:'openai',baseUrl:'http://127.0.0.1:8080/v1'}},providers:[{id:'openrouter',name:'OpenRouter',kind:'openai',base_url:'https://openrouter.ai/api/v1',enabled:true,last_tested_at:new Date().toISOString(),last_error:null}],models:[{id:1,provider_id:'openrouter',provider_name:'OpenRouter',model_id:'anthropic/claude-sonnet-4',display_name:'Claude Sonnet 4'},{id:2,provider_id:'openrouter',provider_name:'OpenRouter',model_id:'google/gemini-2.5-flash',display_name:'Gemini 2.5 Flash'}],combos:[{id:1,alias:'coding-default',description:'Balanced coding route',items:[{id:1,provider_name:'OpenRouter',display_name:'Claude Sonnet 4'},{id:2,provider_name:'OpenRouter',display_name:'Gemini 2.5 Flash'}]}],keys:[],logs:[{created_at:new Date().toISOString(),requested_model:'claude-sonnet-5',provider_id:'openrouter',resolved_model:'anthropic/claude-sonnet-4',status:200,latency_ms:842,fallback_count:0}],settings:{defaultRoute:'coding-default'},dataDir:'Local encrypted storage'};
var state={providerDefaults:{},providers:[],models:[],combos:[],keys:[],logs:[],settings:{defaultRoute:''}};
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]})}
function toast(message,bad){var node=document.createElement('div');node.className='toast'+(bad?' bad':'');node.textContent=message;$('#toasts').appendChild(node);setTimeout(function(){node.remove()},3600)}
async function api(url,options){var response=await fetch(url,Object.assign({headers:{'content-type':'application/json'}},options||{}));var data=await response.json().catch(function(){return {}});if(!response.ok){var detail=data&&data.error&&data.error.message?data.error.message:data.error||'Request failed';throw new Error(String(detail))}return data}
async function load(){state=location.protocol==='file:'?preview:await api('/api/state');render()}
function setTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('switchboard-theme',theme)}catch(e){}}
function providerStatus(provider){if(!provider)return ['Not connected','off'];if(provider.last_error)return ['Needs attention','error'];if(provider.enabled===false)return ['Paused','off'];return ['Connected','connected']}
function endpointHint(base,kind){if(kind==='google')return 'Endpoint · /models/{model}:generateContent';if(kind==='anthropic')return 'Endpoint · /messages';return 'Endpoint · /chat/completions'}
function providerCard(id,defaults){var provider=state.providers.find(function(item){return item.id===id});var kind=provider?provider.kind:defaults.kind;var base=provider?provider.base_url:defaults.baseUrl;var status=providerStatus(provider);var count=state.models.filter(function(model){return model.provider_id===id}).length;var options=[['openai','OpenAI / compatible'],['anthropic','Anthropic'],['google','Gemini native']].map(function(option){return '<option value="'+option[0]+'"'+(kind===option[0]?' selected':'')+'>'+option[1]+'</option>'}).join('');var initials=id==='google'?'G':id==='openrouter'?'OR':id==='tokenrouter'?'TR':id==='anthropic'?'A':id==='nvidia'?'N':id==='custom'?'<>':id.slice(0,2).toUpperCase();return '<form class="card provider" data-id="'+esc(id)+'"><div class="provider-head"><div class="provider-identity"><div class="provider-icon">'+esc(initials)+'</div><div><div class="provider-name">'+esc(defaults.name)+'</div><div class="provider-meta">'+(provider?count+' model'+(count===1?'':'s'):'Encrypted local connection')+'</div></div></div><span class="status '+status[1]+'">'+status[0]+'</span></div><div class="form-grid"><div class="field"><label>Protocol</label><select class="select" name="kind">'+options+'</select></div><div class="field"><label>Base URL</label><input class="input" name="baseUrl" value="'+esc(base)+'" placeholder="http://127.0.0.1:8080/v1"></div><div class="field full"><label>API key</label><input class="input" name="apiKey" type="password" autocomplete="new-password" placeholder="'+(provider?'Saved key will be reused':'Paste key to connect')+'"></div></div><div class="endpoint" title="Resolved request endpoint">→ '+esc(endpointHint(base,kind))+'</div>'+(provider&&provider.last_error?'<div class="notice error">'+esc(provider.last_error)+'</div>':'')+'<div class="provider-actions"><button class="btn primary test" type="submit">'+(provider?'Retest connection':'Test & connect')+'</button>'+(provider?'<button class="btn toggle" type="button" data-action="toggle">'+(provider.enabled===false?'Enable':'Pause')+'</button><button class="btn danger" type="button" data-action="remove">Remove</button>':'')+'<span class="last-test">'+(provider&&provider.last_tested_at?'Tested '+new Date(provider.last_tested_at).toLocaleDateString():'')+'</span></div></form>'}
function renderProviders(){var order=['openai','anthropic','google','openrouter','groq','nvidia','tokenrouter','custom'];$('#providerGrid').innerHTML=order.map(function(id){return providerCard(id,state.providerDefaults[id])}).join('');var connected=state.providers.filter(function(provider){return provider.enabled!==false&&!provider.last_error}).length;$('#providerCount').textContent=connected;$('#modelCount').textContent=state.models.length;$('#routeSummary').textContent=state.settings&&state.settings.defaultRoute||'Automatic fallback';$('#storagePath').textContent=state.dataDir||'Local encrypted storage';$('#storagePath').title=state.dataDir||''}
function renderRouting(){var routes=['<option value="">Automatic provider fallback</option>'];state.combos.forEach(function(combo){routes.push('<option value="'+esc(combo.alias)+'">Combo · '+esc(combo.alias)+'</option>')});state.models.forEach(function(model){routes.push('<option value="'+esc(model.provider_id+'/'+model.model_id)+'">'+esc(model.provider_name+' · '+model.display_name)+'</option>')});$('#defaultRoute').innerHTML=routes.join('');$('#defaultRoute').value=state.settings&&state.settings.defaultRoute||'';$('#modelPicker').innerHTML='<option value="">Choose a discovered model</option>'+state.models.map(function(model){return '<option value="'+model.id+'">'+esc(model.provider_name+' · '+model.display_name)+'</option>'}).join('');renderQueue();$('#comboList').innerHTML=state.combos.length?state.combos.map(function(combo){return '<article class="card combo"><div class="combo-top"><div><div class="combo-name">'+esc(combo.alias)+'</div><div class="combo-description">'+esc(combo.description||'No description')+'</div></div><div class="combo-actions"><button class="mini" data-action="edit" data-id="'+combo.id+'" title="Edit">✎</button><button class="mini" data-action="delete" data-id="'+combo.id+'" title="Delete">×</button></div></div><div class="chips">'+combo.items.map(function(model,index){return '<span class="chip">'+(index+1)+' · '+esc(model.provider_name+' / '+model.display_name)+'</span>'}).join('')+'</div></article>'}).join(''):'<div class="empty">No fallback combos yet.</div>'}
function renderQueue(){$('#queue').innerHTML=queue.length?queue.map(function(id,index){var model=state.models.find(function(item){return item.id===id});return '<li class="queue-item"><span class="queue-number">'+(index+1)+'</span><span class="queue-name">'+esc(model?model.provider_name+' · '+model.display_name:'Missing model')+'</span><button class="mini" type="button" data-action="up" data-index="'+index+'">↑</button><button class="mini" type="button" data-action="down" data-index="'+index+'">↓</button><button class="mini" type="button" data-action="remove" data-index="'+index+'">×</button></li>'}).join(''):'<li class="queue-empty">Add models to define fallback priority.</li>'}
function renderKeys(){$('#keyList').innerHTML=state.keys.length?state.keys.map(function(key){return '<div class="key-row"><div><div class="key-name">'+esc(key.name)+'</div><div class="key-meta"><code>'+esc(key.key_prefix)+'…</code> · '+new Date(key.created_at).toLocaleDateString()+(key.revoked_at?' · Revoked':'')+'</div></div>'+(key.revoked_at?'':'<button class="btn danger" data-action="revoke" data-id="'+key.id+'">Revoke</button>')+'</div>'}).join(''):'<div class="empty">No client keys created.</div>'}
function renderActivity(){$('#logs').innerHTML=state.logs.length?state.logs.map(function(log){return '<tr><td>'+new Date(log.created_at).toLocaleString()+'</td><td>'+esc(log.requested_model)+'</td><td>'+esc(log.provider_id&&log.resolved_model?log.provider_id+' / '+log.resolved_model:'—')+'</td><td><strong class="status-code '+(log.status<400?'good':'bad')+'">'+log.status+'</strong></td><td>'+log.latency_ms+' ms</td><td>'+log.fallback_count+'</td></tr>'}).join(''):'<tr><td colspan="6"><div class="empty">No requests recorded yet.</div></td></tr>'}
function render(){renderProviders();renderRouting();renderKeys();renderActivity()}
$$('.nav button').forEach(function(button){button.addEventListener('click',function(){$$('.nav button').forEach(function(item){item.classList.remove('active');item.removeAttribute('aria-current')});button.classList.add('active');button.setAttribute('aria-current','page');$$('.panel').forEach(function(panel){panel.classList.remove('active')});$('#'+button.dataset.tab).classList.add('active');$('#pageTitle').textContent=button.dataset.title})});
function toggleTheme(){setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')}$('#themeBtn').onclick=toggleTheme;$('#mobileThemeBtn').onclick=toggleTheme;$('#refreshBtn').onclick=function(){load().then(function(){toast('Dashboard refreshed')}).catch(function(error){toast(error.message,true)})};$('#refreshProviders').onclick=$('#refreshBtn').onclick;$('#refreshActivity').onclick=$('#refreshBtn').onclick;
$('#providerGrid').addEventListener('change',function(event){if(event.target.name==='kind'||event.target.name==='baseUrl'){var form=event.target.closest('form');var endpoint=form.querySelector('.endpoint');endpoint.textContent='→ '+endpointHint(form.baseUrl.value,form.kind.value)}});
$('#providerGrid').addEventListener('submit',async function(event){event.preventDefault();var form=event.target;var id=form.dataset.id;var defaults=state.providerDefaults[id];var button=form.querySelector('.test');button.disabled=true;button.textContent='Testing…';try{var result=await api('/api/providers/test',{method:'POST',body:JSON.stringify({id:id,name:defaults.name,kind:form.kind.value,baseUrl:form.baseUrl.value,apiKey:form.apiKey.value})});toast('Connected · '+result.count+' models found');await load()}catch(error){toast(error.message,true);button.disabled=false;button.textContent='Test & connect'}});
$('#providerGrid').addEventListener('click',async function(event){var button=event.target.closest('button[data-action]');if(!button)return;var form=button.closest('form');var id=form.dataset.id;var provider=state.providers.find(function(item){return item.id===id});try{if(button.dataset.action==='toggle'){await api('/api/providers/'+id,{method:'PATCH',body:JSON.stringify({enabled:provider.enabled===false})});toast(provider.enabled===false?'Provider enabled':'Provider paused');await load()}if(button.dataset.action==='remove'&&confirm('Remove '+state.providerDefaults[id].name+' and its discovered models?')){await api('/api/providers/'+id,{method:'DELETE'});toast('Provider removed');await load()}}catch(error){toast(error.message,true)}});
$('#routingForm').onsubmit=async function(event){event.preventDefault();try{await api('/api/settings',{method:'PATCH',body:JSON.stringify({defaultRoute:$('#defaultRoute').value})});toast('Default route saved');await load()}catch(error){toast(error.message,true)}};
$('#addModel').onclick=function(){var id=Number($('#modelPicker').value);if(id&&!queue.includes(id)){queue.push(id);renderQueue()}};$('#queue').onclick=function(event){var button=event.target.closest('button[data-action]');if(!button)return;var index=Number(button.dataset.index);if(button.dataset.action==='remove')queue.splice(index,1);if(button.dataset.action==='up'&&index>0){var previous=queue[index-1];queue[index-1]=queue[index];queue[index]=previous}if(button.dataset.action==='down'&&index<queue.length-1){var next=queue[index+1];queue[index+1]=queue[index];queue[index]=next}renderQueue()};
function resetCombo(){queue=[];$('#comboId').value='';$('#comboAlias').value='';$('#comboDescription').value='';renderQueue()}$('#resetCombo').onclick=resetCombo;$('#comboForm').onsubmit=async function(event){event.preventDefault();try{var id=$('#comboId').value;await api(id?'/api/combos/'+id:'/api/combos',{method:id?'PUT':'POST',body:JSON.stringify({alias:$('#comboAlias').value,description:$('#comboDescription').value,modelIds:queue})});toast('Combo saved');resetCombo();await load()}catch(error){toast(error.message,true)}};
$('#comboList').onclick=async function(event){var button=event.target.closest('button[data-action]');if(!button)return;var id=Number(button.dataset.id);var combo=state.combos.find(function(item){return item.id===id});if(button.dataset.action==='edit'){$('#comboId').value=combo.id;$('#comboAlias').value=combo.alias;$('#comboDescription').value=combo.description;queue=combo.items.map(function(item){return item.id});renderQueue();window.scrollTo({top:0,behavior:'smooth'})}if(button.dataset.action==='delete'&&confirm('Delete '+combo.alias+'?')){try{await api('/api/combos/'+id,{method:'DELETE'});toast('Combo deleted');await load()}catch(error){toast(error.message,true)}}};
$('#keyForm').onsubmit=async function(event){event.preventDefault();try{var result=await api('/api/keys',{method:'POST',body:JSON.stringify({name:$('#keyName').value})});$('#newKeyValue').textContent=result.key;$('#newKey').classList.remove('hidden');$('#keyName').value='';toast('Client key generated');await load()}catch(error){toast(error.message,true)}};$('#copyKey').onclick=async function(){await navigator.clipboard.writeText($('#newKeyValue').textContent);toast('Copied to clipboard')};$('#keyList').onclick=async function(event){var button=event.target.closest('button[data-action="revoke"]');if(!button)return;if(confirm('Revoke this client key?')){try{await api('/api/keys/'+button.dataset.id,{method:'DELETE'});toast('Client key revoked');await load()}catch(error){toast(error.message,true)}}};
load().catch(function(error){toast(error.message,true)});setInterval(function(){if($('#activity').classList.contains('active'))load()},10000);
</script>
</body>
</html>
`;

function sendJson(res,status,value){if(res.writableEnded)return;const body=JSON.stringify(value);res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',Buffer.byteLength(body));res.end(body);}
function decorateResponse(res){res.status=function(code){this.statusCode=code;return this};res.set=function(headers){for(const [key,value] of Object.entries(headers))this.setHeader(key,value);return this};res.json=function(value){sendJson(this,this.statusCode||200,value);return this};res.type=function(value){this.setHeader('Content-Type',value==='html'?'text/html; charset=utf-8':value);return this};}
function httpError(status,message){return Object.assign(new Error(message),{status});}
async function readJson(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY_BYTES)throw httpError(413,'Request body is too large');chunks.push(chunk)}if(!chunks.length)return {};try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw httpError(400,'Malformed JSON request body')}}
function setSecurityHeaders(req,res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');const origin=req.headers.origin;if(!origin||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)){if(origin)res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-api-key,x-upstream-api-key,x-provider-api-key');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');}else throw httpError(403,'Origin not allowed');}
async function apiState(res){const providers=state.providers.map(({api_key_enc,...item})=>item),models=state.models.map(model=>({...model,provider_name:state.providers.find(provider=>provider.id===model.provider_id)?.name||model.provider_id})),combos=state.combos.map(combo=>({...combo,items:(combo.modelIds||[]).map((id,priority)=>{const model=models.find(item=>item.id===id);return model?{...model,priority}:null}).filter(Boolean)})),keys=state.keys.map(({key_hash,...item})=>item),logs=await recentLogs();sendJson(res,200,{providerDefaults:PROVIDER_DEFAULTS,providers,models,combos,keys,logs,settings:state.settings,dataDir:DATA_DIR});}
async function testProvider(req,res){
  const body=req.body,id=String(body.id||'').trim().toLowerCase(),preset=PROVIDER_DEFAULTS[id],existing=state.providers.find(item=>item.id===id);
  const kind=String(body.kind||existing?.kind||preset?.kind||'openai'),name=String(body.name||existing?.name||preset?.name||id).trim();
  const requestedBase=id==='tokenrouter'?TOKENROUTER_BASE_URL:String(body.baseUrl||existing?.base_url||preset?.baseUrl||'');
  let baseUrl;try{baseUrl=normalizeProviderBase(requestedBase,kind,id)}catch(error){throw httpError(400,error.message)}
  let apiKey=String(body.apiKey||'').trim();if(!apiKey&&existing?.api_key_enc){try{apiKey=decrypt(existing.api_key_enc)}catch{}}
  if(!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id)||!name||!apiKey)throw httpError(400,'Provider id, name, and API key are required');
  if(!['openai','anthropic','google'].includes(kind))throw httpError(400,'Unsupported provider protocol');
  const temp={id,kind,base_url:baseUrl,api_key_enc:encrypt(apiKey)},pending=createUpstreamRequest(modelUrl(temp),{headers:{Accept:'application/json',...authHeaders(kind,apiKey)}});
  try{
    const response=await pending.response,text=await readUpstreamText(response,pending),data=safeJson(text);
    if(!response.ok)throw httpError(response.status,data?.error?.message||data?.message||text.slice(0,400)||'Provider request failed');
    const found=parseModels(kind,data);if(!found.length)throw httpError(502,'The provider returned no chat-capable models');
    const stamp=now(),record={id,name,kind,base_url:baseUrl,api_key_enc:encrypt(apiKey),enabled:true,last_tested_at:stamp,last_error:null,created_at:existing?.created_at||stamp,updated_at:stamp};
    if(existing)Object.assign(existing,record);else state.providers.push(record);
    state.models=state.models.filter(model=>model.provider_id!==id);
    for(const model of found)state.models.push({id:state.counters.model++,provider_id:id,model_id:model.id,display_name:model.name,metadata_json:JSON.stringify(model.metadata),created_at:stamp});
    await persistState();sendJson(res,200,{ok:true,count:found.length,baseUrl});
  }catch(error){pending.cleanup();if(existing){existing.last_tested_at=now();existing.last_error=String(error.message).slice(0,1000);existing.updated_at=now();persistState()}throw error;}
}
function modelsResponse(){const combos=state.combos,comboIds=new Set(combos.map(combo=>combo.alias.toLowerCase())),entries=[];for(const id of REQUIRED_CLIENT_MODELS)if(!comboIds.has(id))entries.push({id,display_name:id,owned_by:'switchboard'});for(const alias of Object.keys(MODEL_ALIASES))if(!comboIds.has(alias.toLowerCase())&&!REQUIRED_CLIENT_MODELS.includes(alias))entries.push({id:alias,display_name:alias,owned_by:'switchboard'});for(const model of state.models){const provider=state.providers.find(item=>item.id===model.provider_id);if(provider?.enabled!==false){entries.push({id:model.model_id,display_name:model.model_id,owned_by:provider.name});entries.push({id:provider.id+'/'+model.model_id,display_name:provider.id+'/'+model.model_id,owned_by:provider.name})}}for(const combo of combos)entries.push({id:combo.alias,display_name:combo.description||combo.alias,owned_by:'switchboard-combo',custom:true});const seen=new Set(),created=Math.floor(Date.now()/1000),data=[];for(const entry of entries){const key=entry.id.toLowerCase();if(!seen.has(key)){seen.add(key);data.push({id:entry.id,object:'model',type:'model',display_name:entry.display_name,created,created_at:new Date(created*1000).toISOString(),owned_by:entry.owned_by,custom:!!entry.custom})}}return {object:'list',data,has_more:false,first_id:data[0]?.id||null,last_id:data.at(-1)?.id||null};}
function normalizeApiPath(value){let pathname=String(value||'/').replace(/\/{2,}/g,'/');if(pathname.length>1)pathname=pathname.replace(/\/+$/,'');while(/^\/v1\/v1(?:\/|$)/i.test(pathname))pathname=pathname.replace(/^\/v1\/v1/i,'/v1');if(pathname==='/messages')pathname='/v1/messages';if(pathname==='/chat/completions')pathname='/v1/chat/completions';if(pathname==='/models')pathname='/v1/models';return pathname;}
async function handleRequest(req,res){decorateResponse(res);setSecurityHeaders(req,res);if(req.method==='OPTIONS'){res.statusCode=204;return res.end()}const url=new URL(req.url,'http://localhost'),originalPathname=url.pathname,pathname=normalizeApiPath(originalPathname);if(['POST','PUT','PATCH'].includes(req.method))req.body=await readJson(req);else req.body={};if(pathname.startsWith('/api/')&&!isLoopback(req))throw httpError(403,'Dashboard API is local-only');
  if(req.method==='GET'&&pathname==='/'){res.statusCode=200;res.type('html');return res.end(DASHBOARD)}
  if(req.method==='GET'&&pathname==='/api/state')return apiState(res);
  if(req.method==='POST'&&pathname==='/api/providers/test')return testProvider(req,res);
  if(req.method==='PATCH'&&pathname==='/api/settings'){const defaultRoute=String(req.body.defaultRoute||'').trim().slice(0,256);if(defaultRoute&&!configuredRouteTargets(defaultRoute).length)throw httpError(400,'Choose a saved combo or active provider model');state.settings={...state.settings,defaultRoute};await persistState();return sendJson(res,200,{ok:true,settings:state.settings});}
  let match=pathname.match(/^\/api\/providers\/([^/]+)$/);if(match&&req.method==='PATCH'){const provider=state.providers.find(item=>item.id===decodeURIComponent(match[1]));if(provider){provider.enabled=!!req.body.enabled;provider.updated_at=now();await persistState()}return sendJson(res,200,{ok:true})}if(match&&req.method==='DELETE'){const id=decodeURIComponent(match[1]);state.providers=state.providers.filter(item=>item.id!==id);const removed=new Set(state.models.filter(item=>item.provider_id===id).map(item=>item.id));state.models=state.models.filter(item=>item.provider_id!==id);for(const combo of state.combos)combo.modelIds=(combo.modelIds||[]).filter(modelId=>!removed.has(modelId));await persistState();return sendJson(res,200,{ok:true})}
  if(req.method==='POST'&&pathname==='/api/combos'){const alias=String(req.body.alias||'').trim(),description=String(req.body.description||'').trim(),modelIds=Array.isArray(req.body.modelIds)?req.body.modelIds.map(Number).filter(Number.isInteger):[];if(!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(alias)||!modelIds.length||new Set(modelIds).size!==modelIds.length)throw httpError(400,'Valid alias and a unique model queue are required');if(state.combos.some(item=>item.alias.toLowerCase()===alias.toLowerCase()))throw httpError(409,'That combo alias already exists');if(modelIds.some(id=>!state.models.some(model=>model.id===id)))throw httpError(400,'One or more models no longer exist');const stamp=now();state.combos.push({id:state.counters.combo++,alias,description,modelIds,created_at:stamp,updated_at:stamp});await persistState();return sendJson(res,200,{ok:true})}
  match=pathname.match(/^\/api\/combos\/(\d+)$/);if(match&&req.method==='PUT'){const combo=state.combos.find(item=>item.id===Number(match[1]));if(!combo)throw httpError(404,'Combo not found');const alias=String(req.body.alias||'').trim(),description=String(req.body.description||'').trim(),modelIds=Array.isArray(req.body.modelIds)?req.body.modelIds.map(Number).filter(Number.isInteger):[];if(!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(alias)||!modelIds.length||new Set(modelIds).size!==modelIds.length)throw httpError(400,'Valid alias and a unique model queue are required');if(state.combos.some(item=>item.id!==combo.id&&item.alias.toLowerCase()===alias.toLowerCase()))throw httpError(409,'That combo alias already exists');Object.assign(combo,{alias,description,modelIds,updated_at:now()});await persistState();return sendJson(res,200,{ok:true})}if(match&&req.method==='DELETE'){state.combos=state.combos.filter(item=>item.id!==Number(match[1]));await persistState();return sendJson(res,200,{ok:true})}
  if(req.method==='POST'&&pathname==='/api/keys'){const name=String(req.body.name||'Local client').trim().slice(0,80)||'Local client',key='sk-switchboard-'+crypto.randomBytes(32).toString('base64url');state.keys.push({id:state.counters.key++,name,key_hash:keyHash(key),key_prefix:key.slice(0,18),created_at:now(),last_used_at:null,revoked_at:null});await persistState();return sendJson(res,200,{key})}
  match=pathname.match(/^\/api\/keys\/(\d+)$/);if(match&&req.method==='DELETE'){const key=state.keys.find(item=>item.id===Number(match[1]));if(key)key.revoked_at=now();await persistState();return sendJson(res,200,{ok:true})}
  if(pathname.startsWith('/v1/')){if(!clientAuthorized(req))throw httpError(401,'A valid Switchboard key is required');res.setHeader('X-Switchboard-Auth',LOCAL_AUTH_BYPASS&&isLoopback(req)?'local-bypass':'key');}
  if(req.method==='GET'&&pathname==='/v1/models')return sendJson(res,200,modelsResponse());
  if(req.method==='POST'&&pathname==='/v1/chat/completions')return handleProxyRequest(req,res,'openai');
  if(req.method==='POST'&&pathname==='/v1/messages')return handleProxyRequest(req,res,'anthropic');
  throw httpError(404,'Route not found: '+req.method+' '+originalPathname);
}
function handleFatalRequestError(error,res,format='openai'){const status=Number(error.status||error.statusCode||500),safeStatus=status>=400&&status<600?status:500,requestId=crypto.randomUUID();try{console.error('[Switchboard] Request '+requestId+' failed safely:',error);}catch{}if(res.destroyed||res.writableEnded)return;if(res.headersSent){try{res.end()}catch{}return}const message=safeStatus<500?(error.message||'Invalid request'):'Switchboard could not complete the request';sendJson(res,safeStatus,format==='anthropic'?{type:'error',error:{type:safeStatus===400?'invalid_request_error':'api_error',message,request_id:requestId}}:{error:{type:safeStatus===400?'invalid_request_error':'server_error',message,request_id:requestId}});}
const SWITCHBOARD_ASCII=String.raw`
##### #   # ##### #####  ###  #   # #####  ###   ###  #####  ###
#     #   #   #     #   #   # #   # #   # #   # #   # #   # #  #
##### # # #   #     #   #     ##### ####  #   # ##### #####  #   #
    # ## ##   #     #   #   # #   # #   # #   # #   # #  #  #  #
##### #   # #####   #    ###  #   # #####  ###  #   # #   # ###`;
function cliStyle(code,text){return process.stdout.isTTY?'\u001b['+code+'m'+text+'\u001b[0m':text;}
function startupLine(label,value){const content=(label.padEnd(13)+String(value)).slice(0,68);return '| '+content.padEnd(68)+' |';}
function printStartupBanner(instance){
  const address=instance.address(),activePort=typeof address==='object'&&address?address.port:PORT,url='http://'+HOST+':'+activePort,encryption=MASTER_KEY.length===32?'AES-256-GCM / ACTIVE':'UNAVAILABLE',enabledProviders=state.providers.filter(provider=>provider.enabled!==false).length,route=state.settings?.defaultRoute||'Automatic fallback';
  const border='+'+'-'.repeat(70)+'+';
  console.log('\n'+cliStyle('1;36',SWITCHBOARD_ASCII));
  console.log(cliStyle('2','                         SWITCHBOARD'));
  console.log(cliStyle('36',border));
  console.log(startupLine('STATUS','ONLINE'));
  console.log(startupLine('LISTENING',HOST+':'+activePort));
  console.log(startupLine('DASHBOARD',url));
  console.log(startupLine('ENCRYPTION',encryption));
  console.log(startupLine('CONFIG','Dashboard only · '+enabledProviders+' provider(s)'));
  console.log(startupLine('CLAUDE ROUTE',route));
  console.log(cliStyle('36',border));
  console.log(cliStyle('2','Configuration: '+DATA_DIR+'\n'));
}
let server=null,shuttingDown=false,dashboardOpened=false;
function openDashboard(){if(!AUTO_OPEN||dashboardOpened)return;dashboardOpened=true;const url='http://'+HOST+':'+PORT;let command,args;if(process.platform==='win32'){command='cmd';args=['/c','start','',url]}else if(process.platform==='darwin'){command='open';args=[url]}else{command='xdg-open';args=[url]}try{const child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref()}catch{}}
function configureServer(instance){instance.requestTimeout=Math.max(TIMEOUT_MS+30000,120000);instance.keepAliveTimeout=65000;instance.headersTimeout=Math.min(instance.requestTimeout,70000);instance.maxRequestsPerSocket=0;instance.timeout=0;if('keepAliveTimeoutBuffer'in instance)instance.keepAliveTimeoutBuffer=1000;instance.on('connection',socket=>{socket.setNoDelay(true);socket.setKeepAlive(true,30000);});instance.on('clientError',(error,socket)=>{if(error.code!=='ECONNRESET')console.warn('[Switchboard] Client connection error:',error.message);if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')});}
function startServer(attempt=0){if(shuttingDown)return;const candidate=http.createServer((req,res)=>{Promise.resolve(handleRequest(req,res)).catch(error=>{let format='openai';try{format=normalizeApiPath(new URL(req.url,'http://localhost').pathname)==='/v1/messages'?'anthropic':'openai'}catch{}handleFatalRequestError(error,res,format)})});configureServer(candidate);candidate.once('listening',()=>{server=candidate;printStartupBanner(candidate);setTimeout(openDashboard,250).unref()});candidate.once('error',error=>{if(error.code==='EADDRINUSE'&&attempt<PORT_RETRY_COUNT){console.warn('Port '+PORT+' is in use. Retrying in '+PORT_RETRY_DELAY_MS+'ms ('+(attempt+1)+'/'+PORT_RETRY_COUNT+')...');return setTimeout(()=>startServer(attempt+1),PORT_RETRY_DELAY_MS)}console.error('[Switchboard] Unable to start:',error);process.exitCode=1});candidate.listen(PORT,HOST);}
function shutdown(signal){if(shuttingDown)return;shuttingDown=true;console.log('[Switchboard] '+signal+' received; draining requests and file writes...');const finish=async()=>{await Promise.allSettled([stateWriteQueue,logWriteQueue]);process.exitCode=0};const force=setTimeout(()=>{if(server?.closeAllConnections)server.closeAllConnections();server?.unref();finish()},SHUTDOWN_GRACE_MS);force.unref();if(!server){clearTimeout(force);return finish()}if(server.closeIdleConnections)server.closeIdleConnections();server.close(()=>{clearTimeout(force);server.unref();finish()});}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('uncaughtException',(error,origin)=>{try{console.error('[Switchboard] Uncaught exception contained:',origin,error)}catch{}});
process.on('unhandledRejection',reason=>{try{console.error('[Switchboard] Unhandled rejection contained:',reason)}catch{}});
startServer();
