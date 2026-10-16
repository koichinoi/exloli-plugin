import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

// Exercise the real handlers without a running Yunzai, Redis or external website.
async function setup({ agreed = true, master = true } = {}) {
    const cache = new Map(agreed ? [['Yz:exloli-security', '1']] : []);
    const replies = [], requests = [], contexts = [], writes = [];
    const context = createContext({
        redis: {
            get: async key => cache.get(key),
            set: async (key, value, options) => {
                cache.set(key, value);
                writes.push({ key, options });
            },
            del: async key => cache.delete(key)
        },
        Bot: { makeForwardMsg: messages => messages }
    });
    class Plugin {
        constructor(options) { Object.assign(this, options); }
        setContext(...args) { contexts.push(args); }
        finish(...args) { contexts.push(['finish', ...args]); }
    }
    class Client {
        constructor(isEx) { this.isEx = isEx; }
        handleParam(params) { return params; }
        async requestPage(params) {
            requests.push({ params, isEx: this.isEx });
            return { comicList: [] };
        }
    }
    const pluginModule = new SyntheticModule(['default'], function () {
        this.setExport('default', Plugin);
    }, { context });
    const coreModule = new SyntheticModule(['default', 'CATEGORY'], function () {
        this.setExport('default', Client);
        this.setExport('CATEGORY', { 1: 'Doujinshi', 2: 'Manga' });
    }, { context });
    async function load(file) {
        const module = new SourceTextModule(await readFile(new URL(file, import.meta.url), 'utf8'), { context });
        await module.link(specifier => specifier.endsWith('plugin.js') ? pluginModule : coreModule);
        await module.evaluate();
        return module.namespace;
    }
    const { Search } = await load('../apps/Search.js');
    const { Security } = await load('../apps/Security.js');
    const search = new Search(), security = new Security();
    const event = { user_id: 123, isMaster: master, isGroup: true, reply: async message => replies.push(message) };
    search.e = event;
    // Yunzai continues to the next matching handler when it returns false.
    async function dispatch(message) {
        event.msg = message;
        for (const handler of [security, search]) {
            for (const rule of handler.rule) {
                if (!new RegExp(rule.reg).test(message)) continue;
                if (await handler[rule.fnc](event) !== false) return handler.name;
            }
        }
    }
    async function input(message) { event.msg = message; await search.getInfo(); }
    const params = () => JSON.parse(cache.get('Yz:Exloli-plugin:search:123'));
    return { dispatch, input, params, cache, replies, requests, contexts, writes };
}

test('reported command passes security and retains keyword 1 through all search steps', async () => {
    const app = await setup();
    assert.equal(await app.dispatch('#exloli搜索 1'), 'ExLoli-搜索');
    assert.deepEqual(app.params(), { step: 1, search_param: ['1'] });
    assert.match(app.replies[0], /漫画类型/);
    assert.deepEqual(app.contexts[0], ['getInfo', true, 60, '操作已超时，请重新发送指令']);
    assert.equal(app.writes[0].options.EX, 60);
    await app.input('全选');
    await app.input('默认');
    await app.input('否');
    assert.deepEqual(JSON.parse(JSON.stringify(app.requests[0].params)), {
        step: -1, search_param: ['1'], category: { Doujinshi: true, Manga: true }, f_srdd: 0, isEx: false
    });
    assert.equal(app.requests[0].isEx, false);
    assert.equal(app.cache.has('Yz:Exloli-plugin:search:123'), false);
    assert.equal(app.replies.at(-1), '未搜索到结果');
});

test('bare and whitespace-only commands still ask for search terms', async () => {
    for (const command of ['#exloli搜索', 'exloli搜索', '#exloli搜索   ']) {
        const app = await setup();
        await app.dispatch(command);
        assert.deepEqual(app.params(), { step: 0 });
        assert.match(app.replies[0], /请输入你要搜索的词条/);
        await app.input('1');
        assert.deepEqual(app.params(), { step: 1, search_param: ['1'] });
        assert.match(app.replies[1], /漫画类型/);
    }
});

test('inline terms support optional prefix, spacing, commas and existing defaults', async () => {
    for (const [command, terms] of [
        ['exloli搜索1', ['1']],
        ['#exloli搜索   alpha，beta,gamma   ', ['alpha', 'beta', 'gamma']],
        ['#exloli搜索 默认', []],
        ['#exloli搜索 无', ['']]
    ]) {
        const app = await setup();
        await app.dispatch(command);
        assert.deepEqual(app.params(), { step: 1, search_param: terms });
        assert.match(app.replies[0], /漫画类型/);
    }
});

test('security gate still blocks unconfirmed installations', async () => {
    const app = await setup({ agreed: false });
    assert.equal(await app.dispatch('#exloli搜索 1'), 'ExLoli-安全验证');
    assert.match(app.replies[0], /还未阅读并同意/);
    assert.equal(app.writes.length, 0);
    assert.equal(app.contexts.length, 0);
});

test('search remains restricted to the bot master', async () => {
    const app = await setup({ master: false });
    await app.dispatch('#exloli搜索 1');
    assert.equal(app.replies.length, 1);
    assert.equal(app.writes.length, 0);
    assert.equal(app.contexts.length, 0);
});
