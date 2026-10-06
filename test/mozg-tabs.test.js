'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {sortThreads, marker, routeThread, threadUrl} = require('../public/mozg-tabs');
const {readThreads, latestBrain, pullNotifications, createMozg} = require('../lib/mozg');
const {attention} = require('../lib/attention');
test('general first, remaining tabs by descending activity, archived hidden', () => {
  assert.deepEqual(sortThreads([{id:'old',last_activity:2},{id:'general',last_activity:1},{id:'new',last_activity:3},{id:'archived',archived:1,last_activity:4}]).map(t=>t.id), ['general','new','old']);
});
test('one marker: decision before working before unread; user and activity do not make unread', () => {
  assert.equal(marker({open_decisions:1,busy:true,last_brain_at:10},0),'decision');
  assert.equal(marker({open_decisions:0,busy:true,last_brain_at:10},0),'busy');
  assert.equal(marker({busy:false,last_brain_at:10},9),'unread');
  assert.equal(marker({last_brain_at:10},10),'');
  assert.equal(latestBrain([{level:'user_message',created:30},{level:'activity',created:20},{level:'reply',created:10}]),10);
});
test('bare route uses last tab or general; thread URLs encode id', () => {
  assert.equal(routeThread('#/mozg','beacon'),'beacon');
  assert.equal(routeThread('#/mozg'),'general');
  assert.equal(routeThread('#/mozg',''),'general');
  assert.equal(routeThread('#/mozg/cc%20Panel'),'cc Panel');
  assert.equal(routeThread('#/','beacon'),'beacon');
  assert.equal(routeThread(''),'general');
  assert.equal(routeThread('#/sesje'),null);
  assert.equal(routeThread('#/s/x'),null);
  assert.equal(threadUrl('cc Panel'),'/#/mozg/cc%20Panel');
});
test('old socket becomes single General tab; actual offline error is not hidden', async () => {
  const calls=[];
  const list=await readThreads(async (method,params)=>{
    calls.push([method,params]);
    if(method==='threads') throw new Error('register first');
    return {busy:true,state:'working',messages:[{level:'reply',created:12}],open_decisions:[{id:'d'}]};
  },true);
  assert.equal(list.legacy,true);
  assert.deepEqual(list.threads.map(t=>t.id),['general']);
  assert.equal(list.threads[0].last_brain_at,12);
  assert.equal(list.threads[0].open_decisions,1);
  assert.deepEqual(calls[1],['thread',{limit:100}]);
  await assert.rejects(readThreads(async()=>{throw new Error('Mózg offline');}),/offline/);
});
test('all tabs supply their own decisions and last brain timestamp', async () => {
  const list=await readThreads(async (method,params)=> method==='threads' ? [{id:'general'},{id:'beacon'}] : {messages:[{level:'reply',created:params.thread_id==='beacon'?20:10}],open_decisions:[]},true);
  assert.equal(list.legacy,false);
  assert.deepEqual(list.threads.map(t=>t.last_brain_at),[10,20]);
});
test('decision attention targets tab and has tab title', () => {
  const item=attention([], [{id:'d',text:'choose',thread_id:'beacon',thread_title:'Beacon'}], 'workers')[0];
  assert.equal(item.url,'/#/mozg/beacon');
  assert.equal(item.title,'📡 Beacon: prosi o decyzję');
});
test('brain push targets tab and is marked sent after push', async () => {
  const calls=[];
  await pullNotifications({call:async method=>{calls.push(method);return method==='due_notifications'?[{notification_id:'thread-n',level:'decision',title:'Mózg: decyzja',text:'choose',thread_id:'beacon',thread_title:'Beacon'}]:{};}},{notify:async(type,n)=>{
    assert.equal(n.url,'/#/mozg/beacon');assert.equal(n.title,'📡 Beacon: prosi o decyzję');calls.push('push');
  }});
  assert.deepEqual(calls,['due_notifications','push','mark_sent']);
});
test('client status aggregates all tabs and scoped calls support modern and old sockets', async t => {
  const net=require('net'), fs=require('fs/promises'), os=require('os'), path=require('path');
  for (const legacy of [false,true]) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc19-'));
    const sock=path.join(dir,'socket'), calls=[];
    const server=net.createServer(socket=>socket.once('data',data=>{
      const request=JSON.parse(data);calls.push(request);
      if(legacy && request.method==='threads') return socket.end(JSON.stringify({id:1,error:'register first'})+'\n');
      const result=request.method==='threads'?[{id:'general',busy:false},{id:'beacon',busy:true}]:{busy:false,messages:[],open_decisions:[]};
      socket.end(JSON.stringify({id:1,result})+'\n');
    }));
    await new Promise(resolve=>server.listen(sock,resolve));
    try {
      const client=createMozg(sock);
      assert.equal((await client.status()).busy,!legacy);
      assert.equal((await client.status('general')).busy,false);
      await client.scoped('thread',{limit:1},legacy?'general':'beacon');
      const params=calls.at(-1).params;
      assert.deepEqual(params,legacy?{limit:1}:{limit:1,thread_id:'beacon'});
      if(legacy) await assert.rejects(client.scoped('thread',{limit:1},'beacon'),/tylko Ogólne/);
    } finally {
      await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
    }
  }
});
