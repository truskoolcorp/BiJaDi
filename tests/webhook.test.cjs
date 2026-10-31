const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac,webcrypto}=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=stripTypeScriptTypes(readFileSync(path.join(__dirname,'../supabase/functions/webhook/index.ts'),'utf8').replace(/^import .*;\n/gm,''));
const orderId='10101010-1010-4010-8010-101010101010';
const session={id:'cs_mock',mode:'payment',status:'complete',payment_status:'paid',amount_total:4500,currency:'usd',livemode:true,metadata:{order_id:orderId},payment_intent:'pi_mock'};
const order={id:orderId,stripe_session_id:'cs_mock',payment_method:'stripe',total_cents:4500,payment_status:'pending'};
const event={id:'evt_mock',type:'checkout.session.completed',livemode:true,data:{object:{id:'cs_mock',metadata:{order_id:orderId}}}};
function setup(options={}){
 let handler;const calls={rpc:[],fetch:[],lookup:0};
 const supabase={from(table){assert.equal(table,'orders');return {select(){return this},eq(){return this},maybeSingle:async()=>{calls.lookup++;return {data:options.order===null?null:{...order,...options.order},error:options.lookupError}}}},rpc:async(name,args)=>{calls.rpc.push({name,args});return {data:'applied',error:options.rpcError}}};
 const env={SUPABASE_URL:'https://mock.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'mock_service',STRIPE_WEBHOOK_SECRET:'mock_signing_secret',STRIPE_SECRET_KEY:'mock_stripe_key',...options.env};
 vm.runInNewContext(source,{createClient:()=>supabase,Deno:{env:{get:k=>env[k]},serve:f=>handler=f},crypto:webcrypto,TextEncoder,Uint8Array,URL,AbortSignal,Response,Request,console:{error(){}},fetch:async(url,init)=>{calls.fetch.push({url,init});if(options.fetchError)throw Error('mock unavailable');return Response.json({...session,...options.session},{status:options.fetchStatus||200})}});
 return {calls,run:async(overrides={},reqOptions={})=>{
  let payload=reqOptions.raw??JSON.stringify({...event,...overrides});const t=Math.floor(Date.now()/1000);const signature=createHmac('sha256','mock_signing_secret').update(t+'.'+payload).digest('hex');
  return handler(new Request('https://mock.invalid/webhook?provider='+ (reqOptions.provider||'stripe'),{method:reqOptions.method||'POST',body:reqOptions.method==='GET'?undefined:payload,headers:{'stripe-signature':reqOptions.unsigned?'':`t=${t},v1=${signature}`}}));}};
}
test('unsigned rejected before lookup or payment writes',async()=>{const s=setup();assert.equal((await s.run({}, {unsigned:true})).status,400);assert.equal(s.calls.fetch.length,0);assert.equal(s.calls.rpc.length,0)});
test('GET is 405',async()=>{const s=setup();assert.equal((await s.run({}, {method:'GET'})).status,405);assert.equal(s.calls.rpc.length,0)});
test('signed malformed JSON is 400',async()=>{const s=setup();assert.equal((await s.run({}, {raw:'{'})).status,400);assert.equal(s.calls.rpc.length,0)});
test('missing signing config fails closed',async()=>{const s=setup({env:{STRIPE_WEBHOOK_SECRET:''}});assert.equal((await s.run()).status,503)});
test('missing payment config fails closed',async()=>{const s=setup({env:{STRIPE_SECRET_KEY:''}});assert.equal((await s.run()).status,503);assert.equal(s.calls.rpc.length,0)});
test('current unpaid session never marks paid, even when event says paid',async()=>{const s=setup({session:{payment_status:'unpaid'}});const r=await s.run({data:{object:{...event.data.object,payment_status:'paid'}}});assert.equal(r.status,200);assert.equal((await r.json()).payment_pending,true);assert.equal(s.calls.rpc.length,0)});
test('paid session uses current verified intent',async()=>{const s=setup();assert.equal((await s.run({data:{object:{...event.data.object,payment_intent:'pi_stale'}}})).status,200);assert.equal(s.calls.rpc.length,1);assert.equal(s.calls.rpc[0].args.p_payment_intent,'pi_mock');assert.equal(s.calls.rpc[0].args.p_order_id,orderId)});
test('delayed success preserves original event type',async()=>{const s=setup();assert.equal((await s.run({type:'checkout.session.async_payment_succeeded'})).status,200);assert.equal(s.calls.rpc[0].args.p_event_type,'checkout.session.async_payment_succeeded')});
test('zero total no-payment-required accepted',async()=>{const s=setup({session:{amount_total:0,payment_status:'no_payment_required',payment_intent:null},order:{total_cents:0}});assert.equal((await s.run()).status,200);assert.equal(s.calls.rpc[0].args.p_payment_intent,null)});
test('expired session may fail only a pending order through RPC',async()=>{const s=setup({session:{status:'expired',payment_status:'unpaid',payment_intent:null}});assert.equal((await s.run({type:'checkout.session.expired'})).status,200);assert.equal(s.calls.rpc[0].args.p_event_type,'checkout.session.expired')});
test('stale expiry cannot overwrite current paid state',async()=>{const s=setup();assert.equal((await s.run({type:'checkout.session.expired'})).status,200);assert.equal(s.calls.rpc.length,0)});
for(const [label,options]of Object.entries({
 'Stripe transport failure':{fetchError:true},'Stripe HTTP failure':{fetchStatus:503},'session mismatch':{session:{id:'cs_other'}},'wrong mode':{session:{mode:'subscription'}},'test/live mismatch':{session:{livemode:false}},'metadata mismatch':{session:{metadata:{order_id:'20202020-2020-4020-8020-202020202020'}}},'missing order':{order:null},'order lookup failure':{lookupError:{message:'mock'}},'order session mismatch':{order:{stripe_session_id:'cs_other'}},'wrong order provider':{order:{payment_method:'manual'}},'amount mismatch':{session:{amount_total:4400}},'currency mismatch':{session:{currency:'eur'}},'invalid stored total':{order:{total_cents:-1}},'missing intent':{session:{payment_intent:null}}
}))test(label+' returns retryable failure with no state write',async()=>{const s=setup(options);assert.equal((await s.run()).status,500);assert.equal(s.calls.rpc.length,0)});
test('transaction error is not acknowledged',async()=>{const s=setup({rpcError:{message:'mock database failure'}});assert.equal((await s.run()).status,500);assert.equal(s.calls.rpc.length,1)});
test('unrelated signed event ignored without Stripe/database lookup',async()=>{const s=setup();assert.equal((await s.run({type:'customer.updated'})).status,200);assert.equal(s.calls.fetch.length,0);assert.equal(s.calls.lookup,0);assert.equal(s.calls.rpc.length,0)});
test('unverified crypto callbacks remain unavailable',async()=>{const s=setup();assert.equal((await s.run({}, {provider:'coinbase'})).status,503);assert.equal(s.calls.rpc.length,0)});
