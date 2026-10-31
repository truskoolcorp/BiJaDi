const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(require('node:path').join(__dirname,'../supabase/functions/checkout/index.ts'),'utf8').replace(/^import .*;\n/gm,''));
const product={id:'p1',slug:'be-tee',name:'Be Tee',price_cents:4500,currency:'usd',sizes:['M','L'],colors:['Black'],status:'preorder',max_quantity:4};
const valid={items:[{slug:'be-tee',size:'M',color:'Black',quantity:1}],customer:{name:'Audit Example',email:'audit@example.invalid'},payment_method:'stripe'};
function setup(options={}){
 let handler,writes=[],calls=[],lookups=0;
 const client={from(table){return {select(){return this},in(){return this},neq(){lookups++;return Promise.resolve({data:options.products??[product],error:options.lookupError})},insert(row){writes.push({table,row});return {select(){return {single:async()=>({data:{id:'order1',order_number:'B1'}})}}}},update(row){return {eq:async()=>{writes.push({table,row});return {error:null}}}}}}};
 vm.runInNewContext(source,{Deno:{env:{get:k=>({SUPABASE_URL:'https://example.supabase.co',STRIPE_SECRET_KEY:'mock_key',STRIPE_WEBHOOK_SECRET:options.missingSigningSecret?'':'mock_signing_secret'}[k]||'')},serve:f=>handler=f},createClient:()=>client,Request,Response,URLSearchParams,Map,Set,Date,fetch:async(url,options)=>{calls.push({url,params:new URLSearchParams(options.body)});return Response.json({id:'cs_mock',url:'https://checkout.stripe.com/mock'})}});
 return {run:async(body)=>handler(new Request('https://example.invalid',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)})),writes,calls,get lookups(){return lookups}};
}
for(const [label,change]of [
 ['disabled crypto',b=>b.payment_method='coinbase'],['fractional quantity',b=>b.items[0].quantity=1.5],['negative quantity',b=>b.items[0].quantity=-1],['string quantity',b=>b.items[0].quantity='1'],['bad email',b=>b.customer.email='invalid'],['arbitrary redirect',b=>b.return_url='https://attacker.invalid'],['invalid size',b=>b.items[0].size='fake'],['invalid color',b=>b.items[0].color='fake'],['unknown product',b=>b.items.push({...b.items[0],slug:'unknown'})],['aggregate quantity cap',b=>{b.items[0].quantity=3;b.items.push({...b.items[0],size:'L'})}]
])test(label+' rejects without writes or payment calls',async()=>{let b=structuredClone(valid);change(b);const s=setup();assert.equal((await s.run(b)).status,400);assert.equal(s.writes.length,0);assert.equal(s.calls.length,0)});
test('catalog outage fails closed',async()=>{const s=setup({lookupError:{message:'private detail'}});let r=await s.run(valid);assert.equal(r.status,500);assert.equal(s.writes.length,0);assert.ok(!(await r.text()).includes('private detail'))});
test('malformed JSON is 400',async()=>{const s=setup();assert.equal((await s.run('{')).status,400);assert.equal(s.lookups,0)});
test('valid selected option uses catalog price and canonical redirects',async()=>{const s=setup();const b=structuredClone(valid);b.items[0].price_cents=1;const r=await s.run(b);assert.equal(r.status,200);assert.equal(s.writes[0].row.total_cents,4500);assert.equal(s.writes[0].row.items[0].size,'M');assert.equal(s.calls[0].params.get('line_items[0][price_data][unit_amount]'),'4500');assert.equal(s.calls[0].params.get('cancel_url'),'https://www.bijadi.net/shop.html?cancelled=true');assert.match(s.calls[0].params.get('success_url'),/^https:\/\/example.supabase.co\/functions\/v1\/order-confirmation\?order=/)});

test('missing webhook configuration creates no order, discount use or payment call',async()=>{const s=setup({missingSigningSecret:true});const r=await s.run(valid);assert.equal(r.status,503);assert.equal(s.writes.length,0);assert.equal(s.calls.length,0);assert.equal(s.lookups,0);assert.match((await r.json()).error,/Card checkout is being connected/)});
