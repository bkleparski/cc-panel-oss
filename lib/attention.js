 'use strict';
const { isBrainPane } = require('./mozg');
const { threadUrl } = require('../public/mozg-tabs');
const excluded = (item, workerLabel) => item.subagent === true || isBrainPane(item) || (!!workerLabel && item.workspace === workerLabel);
// extra: gotowe wpisy spoza sesji (limit planu z lib/usage-alerts.js usageAttention)
function attention(items, decisions, workerLabel, extra = []) {
  const result = [...extra];
  for (const item of items) {
    const approval = ['approval', 'blocked'].includes(item.status);
    if (!approval && (item.status !== 'idle' || excluded(item, workerLabel))) continue;
    // body: „o co prosi” (opis z transkryptu, zamaskowany i przycięty) - tylko przy zgodzie
    const body = approval && item.ask?.text ? item.ask.text : undefined;
    result.push({ id: item.key, title: `${approval ? '🔴' : '🟡'} ${item.name} ${approval ? 'prosi o zgodę' : 'czeka na polecenie'}`, body, url: item.url, priority: approval ? 0 : 1 });
  }
  for (const decision of decisions) result.push({ id: 'decision:' + decision.id, title: decision.thread_title ? `📡 ${decision.thread_title}: prosi o decyzję` : '📡 Dyspozytor prosi o decyzję', body: Array.from(decision.text || '').slice(0, 100).join(''), url: decision.thread_id ? threadUrl(decision.thread_id) : '/#/mozg', priority: 2 });
  return result.sort((a, b) => a.priority - b.priority);
}
// Status przycisku SESJE w nagłówku Dyspozytora: sesje agentów bez paneli samego Dyspozytora,
// "czeka" = pozycje z dzwonka bez decyzji Dyspozytora (te widać na zakładkach czatu)
function summary(items, workerLabel) {
  const own = items.filter(item => !isBrainPane(item));
  return { sessions: own.length, working: own.filter(item => item.status === 'working').length, attention: attention(items, [], workerLabel).length };
}
module.exports = { attention, excluded, summary };
