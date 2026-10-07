const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
let now=Date.now(),queries=0,lastQuery;
class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,Response,Request,URL,AbortSignal,Date:Clock,DurableObject:class{},fetch:async(url,options)=>{
  queries++;lastQuery=JSON.parse(options.body);return Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests:25000,errors:3}}]}]}}});
}});
vm.runInContext(fs.readFileSync(__dirname+'/monitor.js','utf8').replace(/^import[^\n]+/m,'').replace(/export /g,'')+'\nglobalThis.Monitor=SiteMonitor;globalThis.route=monitorRoute;',context);
const env={DEV_PANEL_PASSWORD:'test-only-secret',DEV_CF_ACCOUNT_ID:'test-account',DEV_CF_ANALYTICS_TOKEN:'test-token',DEV_CF_DAILY_REQUEST_LIMIT:'100000'};
const records=new Map();
const ctx={storage:{list:async({prefix})=>new Map([...records].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)])),put:async(k,v)=>records.set(k,structuredClone(v)),delete:async k=>records.delete(k)},blockConcurrencyWhile:fn=>fn()};
let monitor=new context.Monitor(ctx,env);
function request(path,body={},token='',origin='https://vvitalik25-ux.github.io'){return new Request('https://example.test/monitor/'+path,{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1',Authorization:'Bearer '+token},body:JSON.stringify(body)});}
const call=(path,body,token)=>monitor.fetch(request(path,body,token));
(async()=>{
  assert.equal((await call('stats')).status,401);
  assert.equal((await context.route(request('stats',{},'','https://evil.test'),env)).status,403);
  assert.equal((await call('login',{password:'bad'})).status,401);
  const login=await (await call('login',{password:env.DEV_PANEL_PASSWORD})).json();assert(login.token);
  const token=login.token;
  assert.equal((await call('heartbeat',{channel:'bad',id:'1234567890123456'})).status,400);
  await call('heartbeat',{channel:'dev',id:'1234567890123456'});await call('heartbeat',{channel:'dev',id:'1234567890123456'});
  await call('heartbeat',{channel:'stable',id:'1234567890123456'});
  let stats=await (await call('stats',{},token)).json();assert.deepEqual(stats.visitors,{dev:1,stable:1});
  assert.equal(stats.quota[1].percent,25);assert.equal(stats.quota[1].errors,3);assert.equal(stats.quota[0].error,'not_configured');
  assert(!JSON.stringify(stats).includes('test-token'));assert(!lastQuery.query.includes('scriptName'));assert(!lastQuery.query.includes('dimensions'));
  await Promise.all([call('stats',{},token),call('stats',{},token)]);assert.equal(queries,1);
  monitor=new context.Monitor(ctx,env);now+=31000;
  assert.equal((await call('stats',{},token)).status,200,'session survives object eviction');
  now+=91000;stats=await(await call('stats',{},token)).json();assert.deepEqual(stats.visitors,{dev:0,stable:0});
  now+=1800000;assert.equal((await call('stats',{},token)).status,200);
  now+=86400001;assert.equal((await call('stats',{},token)).status,401);
  for(let i=0;i<5;i++)assert.equal((await call('login',{password:'bad'})).status,401);
  assert.equal((await call('login',{password:env.DEV_PANEL_PASSWORD})).status,429);
  now+=61000;const token2=(await(await call('login',{password:env.DEV_PANEL_PASSWORD})).json()).token;
  env.DEV_PANEL_PASSWORD='rotated';assert.equal((await call('stats',{},token2)).status,401);
  const token3=(await(await call('login',{password:env.DEV_PANEL_PASSWORD})).json()).token;await call('logout',{},token3);monitor=new context.Monitor(ctx,env);assert.equal((await call('stats',{},token3)).status,401);
  assert.equal((await call('heartbeat',{id:'a'.repeat(3000)})).status,413);
  console.log('PASS: origin, authentication, deduplication, TTL, account quota, cache, token expiry/rotation/logout, rate limiting, body bounds');
})().catch(error=>{console.error(error);process.exitCode=1;});
