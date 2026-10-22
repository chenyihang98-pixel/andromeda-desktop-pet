import {mountAndromeda} from './andromeda.mjs';
const guide = mountAndromeda({avoidSelectors: ['#open-guide', '#finish-note'], reading: {kind: 'project', id: 'sdk-integration-v1', selector: '#integration', title: '站宠接入说明'}, tour: [
  {selector: '#possibilities', title: '先认识一下星璇', text: '这里列出了她的三种陪伴方式。我们先从找路、安静和互动开始。'},
  {selector: '#workbench', title: '专注时，我会让开', text: '在便笺里写点东西。输入获得焦点后，星璇会暂时收成小入口。'},
  {selector: '#integration', title: '把她带到你的网站', text: '组件可以独立挂载，也可以完整销毁。公开信息和私人任务之间保留清楚的边界。'},
]});
window.demoGuide = guide;
document.querySelector('#open-guide').addEventListener('click', guide.open);
document.querySelector('#tour-button').addEventListener('click', guide.open);
document.querySelector('#collapse-button').addEventListener('click', guide.collapse);
document.querySelector('#wave-button').addEventListener('click', () => { guide.restore(); guide.play('greet'); });
document.querySelector('#finish-note').addEventListener('click', () => {
  document.querySelector('#demo-status').textContent = '这一小步完成了。内容仍只在当前页面中，刷新后清空。';
  guide.say('记下了一个新想法。下一步，可以让它慢慢长大。', {action: 'happy', force: true});
});
document.querySelector('#test-scope').addEventListener('click', () => {
  const accepted = guide.receiveTask({userId: 'someone-else', eventId: 'demo-event', taskId: 'private-task', status: 'completed', text: '这条私人消息不应该显示。'});
  document.querySelector('#demo-status').textContent = accepted ? '范围检查异常。' : '已拒绝：匿名访客不能接收私人任务；也不会借用站长身份。';
});
window.addEventListener('pagehide', event => { if (!event.persisted) guide.destroy(); });
