import { DurableObject } from 'cloudflare:workers';

const ORIGIN = 'https://vvitalik25-ux.github.io';
const TTL = 90000;
const reply = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{
  'Content-Type':'application/json', 'Cache-Control':'no-store',
  'Access-Control-Allow-Origin':ORIGIN, 'Access-Control-Allow-Methods':'POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization', 'Vary':'Origin'
}});
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,'0')).join('');

export async function monitorRoute(request, env) {
  if (request.headers.get('Origin') !== ORIGIN) return reply({error:'origin'},403);
  if (request.method === 'OPTIONS') return reply({});
  if (request.method !== 'POST') return reply({error:'method'},405);
  if (!env.SITE_MONITOR) return reply({error:'not_configured'},503);
  return env.SITE_MONITOR.get(env.SITE_MONITOR.idFromName('site-monitor-v1')).fetch(request);
}

export class SiteMonitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.env=env; this.visitors=new Map(); this.sessions=new Map();
    this.attempts=new Map(); this.quotaCache=new Map(); this.quotaPending=new Map();
  }
  clean(now) {
    for (const [key,value] of this.visitors) if(now-value.at>TTL) this.visitors.delete(key);
    for (const [key,value] of this.sessions) if(now>value.expires) this.sessions.delete(key);
    for (const [key,value] of this.attempts) if(now>value.until) this.attempts.delete(key);
  }
  async fetch(request) {
    const now=Date.now(); this.clean(now);
    const path=new URL(request.url).pathname;
    let body;
    try {
      const reader=request.body?.getReader(); let chunks=[],size=0;
      if(reader) for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return reply({error:'too_large'},413);}chunks.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      body=JSON.parse(new TextDecoder().decode(bytes)||'{}');
      if(!body || typeof body!=='object' || Array.isArray(body)) throw Error();
    } catch { return reply({error:'body'},400); }
    if(path==='/monitor/heartbeat') {
      if(!['stable','dev'].includes(body.channel)||!/^[-\w]{16,64}$/.test(body.id||'')) return reply({error:'visitor'},400);
      const key=body.channel+':'+body.id;
      if(!this.visitors.has(key)&&this.visitors.size>=10000) return reply({error:'capacity'},503);
      this.visitors.set(key,{channel:body.channel,at:now});
      return reply({ok:true});
    }
    if(path==='/monitor/login') {
      if(!this.env.DEV_PANEL_PASSWORD) return reply({error:'not_configured'},503);
      const key=await digest(request.headers.get('CF-Connecting-IP')||'unknown');
      let attempt=this.attempts.get(key);
      if(attempt?.count>=5) return reply({error:'rate_limit'},429);
      if(!attempt){if(this.attempts.size>=10000)return reply({error:'rate_limit'},429);attempt={count:0,until:now+60000};this.attempts.set(key,attempt);}
      attempt.count++;
      if(typeof body.password!=='string'||body.password.length>256) return reply({error:'password'},401);
      const [given,expected]=await Promise.all([digest(body.password),digest(this.env.DEV_PANEL_PASSWORD)]);
      let mismatch=0;for(let i=0;i<given.length;i++)mismatch|=given.charCodeAt(i)^expected.charCodeAt(i);
      if(mismatch) return reply({error:'password'},401);
      if(this.sessions.size>=100) return reply({error:'capacity'},503);
      const token=crypto.randomUUID()+crypto.randomUUID();
      // Store only a digest of the bearer token; rotating the password invalidates sessions.
      this.sessions.set(await digest(token),{expires:now+1800000,passwordHash:expected});
      return reply({token,expires:now+1800000});
    }
    const key=await digest(request.headers.get('Authorization')?.replace(/^Bearer /,'')||'');
    const session=this.sessions.get(key);
    if(!session || session.passwordHash!==await digest(this.env.DEV_PANEL_PASSWORD||''))return reply({error:'auth'},401);
    if(path==='/monitor/logout'){this.sessions.delete(key);return reply({ok:true});}
    if(path!=='/monitor/stats') return reply({error:'not_found'},404);
    const visitors={stable:0,dev:0};for(const visitor of this.visitors.values())visitors[visitor.channel]++;
    const quota=await Promise.all(['stable','dev'].map(channel=>this.quota(channel)));
    return reply({now:Date.now(),visitors,presenceWindowSeconds:90,quota});
  }
  async quota(channel) {
    const cached=this.quotaCache.get(channel),now=Date.now();
    if(cached && now-cached.checkedAt<60000)return cached;
    if(this.quotaPending.has(channel))return this.quotaPending.get(channel);
    const task=this.loadQuota(channel).then(value=>{this.quotaCache.set(channel,value);return value;}).finally(()=>this.quotaPending.delete(channel));
    this.quotaPending.set(channel,task);return task;
  }
  async loadQuota(channel) {
    const prefix=channel.toUpperCase(),checkedAt=Date.now();
    const account=this.env[prefix+'_CF_ACCOUNT_ID'],token=this.env[prefix+'_CF_ANALYTICS_TOKEN'];
    const limit=Number(this.env[prefix+'_CF_DAILY_REQUEST_LIMIT']);
    if(!account||!token||!Number.isFinite(limit)||limit<=0)return {channel,checkedAt,error:'not_configured'};
    const start=new Date();start.setUTCHours(0,0,0,0);
    // No script filter or dimensions: account-wide aggregation, not the first N scripts.
    const query=`query Quota($account: string, $start: string, $end: string) { viewer { accounts(filter: {accountTag: $account}) { workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests errors } } } } }`;
    try {
      const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query,variables:{account,start:start.toISOString(),end:new Date(checkedAt).toISOString()}}),signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error();const result=await response.json();
      const rows=result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
      if(result.errors?.length||!Array.isArray(rows))throw Error();
      const requests=rows.reduce((sum,row)=>sum+row.sum.requests,0),errors=rows.reduce((sum,row)=>sum+row.sum.errors,0);
      if(!Number.isFinite(requests)||requests<0||!Number.isFinite(errors))throw Error();
      return {channel,checkedAt,requests,errors,limit,percent:requests/limit*100,resetAt:start.getTime()+86400000,estimated:true};
    }catch{return {channel,checkedAt,error:'analytics_unavailable'};}
  }
}
