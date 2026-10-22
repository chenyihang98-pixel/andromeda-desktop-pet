import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionEngine, LIMITS} from '../src/shared/companion.mjs';
import {validateCompanionBackup} from '../src/backup.mjs';

test('generated completion text preserves Unicode and merged notification details across save and restore', () => {
  const engine=createCompanionEngine();
  const texts=['先完成一件小事', 'a'.repeat(495)+'😀', 'a'.repeat(494)+'😀', '😀'.repeat(250)];
  for(const text of texts){
    const todo=engine.dispatch({type:'todo.add',text}).state.todos.at(-1);
    const result=engine.dispatch({type:'todo.complete',id:todo.id});
    assert.equal(result.events.length,1);
    assert.ok(result.events[0].text.isWellFormed());assert.ok(result.events[0].text.length<=LIMITS.text);
    const notification=result.state.notifications[0];
    assert.ok(notification.text.isWellFormed());assert.ok(notification.items.every(item=>item.text.isWellFormed()));
  }
  const saved=engine.serialize(), reopened=createCompanionEngine(saved).snapshot();
  assert.equal(saved.notifications.length,1);assert.equal(saved.notifications[0].count,4);
  assert.equal(saved.notifications[0].items[1].text,'完成了：'+'a'.repeat(495));
  assert.equal(saved.notifications[0].items[2].text,'完成了：'+'a'.repeat(494)+'😀');
  assert.deepEqual(reopened.notifications,saved.notifications);
  const backup=validateCompanionBackup({schema:'andromeda.backup/v1',companion:saved});
  assert.equal(backup.summary.discarded.total,0);assert.deepEqual(backup.state.notifications,saved.notifications);
});
