/** Public website knowledge. Keep private memories, credentials and account data out. */
export const SITE_CONTENT = Object.freeze({
  name: '星匠 Starwright',
  origin: 'https://starwright.xyz',
  character: '星璇',
  description: '把 AI 创作工具，做成能直接用的东西。',
  goals: [
    {label: '我想玩游戏', query: '游戏'},
    {label: '我想做 3D 模型', query: '模型'},
    {label: '我想找桌面陪伴', query: '桌宠'},
  ],
  tools: [
    {id: 'game', name: '小人乱斗', tags: ['游戏', '格斗', '键盘', '游玩'], href: '/tools/xiaoren-luandou/', summary: '横版一对一格斗游戏。电脑浏览器可以直接玩，也提供 Windows 版。', help: '先点击游戏画面取得键盘焦点，再按 Enter 开始。游戏支持电脑对战和训练模式。'},
    {id: 'modelwright', name: '模匠 Modelwright', tags: ['3D', '模型', 'Unity', '图片', '生成'], href: '/tools/modelwright/', summary: '把图片或文字变成游戏可用的 3D 模型，并送进 Unity 工程。', help: '下载 Windows 版。首次体验可以使用离线演示；真实生成使用你在服务商处配置的 API 密钥。'},
    {id: 'andromeda', name: '星璇 Andromeda', tags: ['桌宠', '站宠', '陪伴', '下载'], href: '/tools/xingxuan/', summary: '同一个星璇，陪在桌面与网页。默认安静，随时可以收起。', help: '桌面能力以当前发行说明为准。网站向导提供公开内容和本浏览器偏好；两者不会自动共享私人资料。'},
  ],
  links: {
    home: 'https://starwright.xyz/',
    about: 'https://starwright.xyz/about/',
    releases: 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases',
    issues: 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/issues',
    modelwrightDocs: 'https://chenyihang98-pixel.github.io/Modelwright/',
  },
  faq: [
    {id: 'download', question: '在哪里下载桌宠？', answer: '打开星璇的 GitHub 发行页，选择适合自己电脑的发行包，并阅读该版本的安装说明。这里始终链接发行页，不缓存可能过期的版本号。', tags: ['Windows', '版本', '安装', '更新'], href: 'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases'},
    {id: 'privacy', question: '会共享我的桌面资料吗？', answer: '这个站宠 SDK 默认只把外观、位置和互动偏好保存在本浏览器。它不主动读取桌面文件、调用 AI、录音或收集浏览记录。宿主网站的其他数据处理，以网站自己的说明为准。', tags: ['隐私', '数据', '账号'], href: 'https://starwright.xyz/about/'},
    {id: 'hide', question: '挡住内容了怎么办？', answer: '拖动星璇到左右边缘即可停靠；点击面板中的“收起”保留一个小入口。输入文字和全屏时会自动避让。', tags: ['关闭', '移动', '遮挡', '手机']},
    {id: 'sync', question: '网页和桌面会同步吗？', answer: '目前可以手动导入、导出白名单内的偏好。位置和私人记忆不包含在导出中。自动账号同步需要宿主接入真实登录服务，SDK 不会假装你已登录。', tags: ['登录', '偏好', '导入', '导出']},
    {id: 'models', question: '可以变成 Live2D 或 3D 吗？', answer: '当前站宠使用原创精灵图集。Live2D 和 3D 需要对应模型、动作及授权；静态 GLB 展示模型不等于已经有可驱动的骨骼和表情。', tags: ['模型', 'VRM', '资产']},
  ],
});

/** Adapt the host's existing public catalog instead of maintaining duplicate version text. */
export function createSiteContent({tools = SITE_CONTENT.tools, origin = SITE_CONTENT.origin} = {}) {
  const normalized = tools.filter(tool => tool && typeof tool.name === 'string' && typeof tool.href === 'string').map(tool => {
    const known = SITE_CONTENT.tools.find(item => item.href === tool.href);
    const summary = typeof tool.summary === 'string' ? tool.summary : known?.summary || '';
    return {id: String(tool.id || tool.name), name: tool.en ? `${tool.name} ${tool.en}` : tool.name, href: tool.href,
      tags: Array.isArray(tool.tags) ? tool.tags.filter(tag => typeof tag === 'string') : [...(known?.tags || []), ...(Array.isArray(tool.badges) ? tool.badges.filter(tag => typeof tag === 'string') : [])],
      summary, help: `${tool.version ? `当前公开发行版本：${tool.version}。` : ''}${summary}${known ? ` ${known.help}` : ''}`};
  });
  return {...SITE_CONTENT, origin, tools: normalized};
}

export function searchSiteContent(query = '', content = SITE_CONTENT) {
  const words = String(query).normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const records = [
    ...content.tools.map(tool => ({id: tool.id, title: tool.name, text: tool.help || tool.summary, href: new URL(tool.href, content.origin).href, tags: tool.tags})),
    ...content.faq.map(faq => ({id: faq.id, title: faq.question, text: faq.answer, href: faq.href, tags: faq.tags})),
  ];
  return records.map(record => ({...record, score: words.reduce((score, word) => score + (`${record.title} ${record.tags.join(' ')} ${record.text}`.toLocaleLowerCase().includes(word) ? 1 : 0), 0)}))
    .filter(record => !words.length || record.score === words.length).sort((a, b) => b.score - a.score).slice(0, 8);
}

export function pageContent(pathname = '/', content = SITE_CONTENT) {
  const tool = content.tools.find(item => pathname.startsWith(item.href.replace(/\/$/, '')));
  return tool ? {title: tool.name, text: tool.help, href: new URL(tool.href, content.origin).href} : {title: '今天想做点什么？', text: content.description, href: content.links.home};
}
