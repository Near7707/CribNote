const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const original = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
const source = original.replace('jQuery(() => init());', `globalThis.api = {
    settings, bindSettings, parseResult, cleanMessage, requestLLM, generate, cancel, init, makeSummary,
    currentTurnKey, loadStored, showStored, togglePanel,
    addCustomMood, removeCustomMood, allMoods, pickMood, buildMessages, cycleSetting,
    togglePin, getPins, useNote, getPending,
    state: () => ({ busy, summarizing }),
};`);

function setup(overrides = {}) {
    const elements = new Map();
    const events = new Map();
    function $(key) {
        if (!elements.has(key)) {
            const el = { value: '', html: '', text: '', checked: false, visible: false, data: {}, handlers: new Map() };
            const chain = {
                length: 1,
                0: { focus() {} },
                val(v) { if (v === undefined) return el.value; el.value = v; return chain; },
                text(v) { if (v === undefined) return el.text; el.text = v; return chain; },
                html(v) { if (v === undefined) return el.html; el.html = v; return chain; },
                empty() { el.html = ''; return chain; },
                append(v) { el.html += v; return chain; },
                prop(k, v) { if (v === undefined) return el[k]; el[k] = v; return chain; },
                on(names, selector, fn) {
                    const handler = fn || selector;
                    const suffix = fn ? ':' + selector : '';
                    for (const name of names.split(' ')) el.handlers.set(name + suffix, handler);
                    return chain;
                },
                data(k, v) { if (v === undefined) return el.data[k]; el.data[k] = v; return chain; },
                is() { return el.visible; },
                toggle(v) { el.visible = v ?? !el.visible; return chain; },
                trigger() { return chain; },
                each() { return chain; },
                map() { return { get: () => [] }; },
                addClass() { return chain; }, removeClass() { return chain; }, toggleClass() { return chain; },
                hide() { return chain; }, before() { return chain; }, prepend() { return chain; },
            };
            elements.set(key, { el, chain });
        }
        return elements.get(key).chain;
    }
    const context = {
        extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
        chat: [{ name: 'Character', mes: '"같이 갈래?"' }], characters: [],
        name1: 'User', name2: 'Character',
        event_types: {
            CHAT_CHANGED: 'chat', CONNECTION_PROFILE_CREATED: 'created',
            CONNECTION_PROFILE_UPDATED: 'updated', CONNECTION_PROFILE_DELETED: 'deleted',
            MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_EDITED: 'edited', MESSAGE_DELETED: 'message_deleted',
            GENERATION_STARTED: 'gen_started',
        },
        eventSource: { on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } },
        ...overrides,
    };
    const sandbox = { SillyTavern: { getContext: () => context }, $, jQuery() {},
        AbortController, structuredClone, console: { log() {}, error() {} },
        toastr: { info() {}, warning() {}, success() {} } };
    vm.runInNewContext(source, sandbox);
    return { api: sandbox.api, context, $, elements, events };
}

function emit(h, name, value, prop = 'value') {
    const entry = h.elements.get(name);
    entry.el[prop] = value;
    const target = { checked: entry.el.checked };
    h.elements.set(target, entry);
    entry.el.handlers.get('change').call(target);
}
const result = '{"replies":["하나","둘"],"ideas":["새 손님이 온다."]}';
const json = value => JSON.parse(JSON.stringify(value));

test('settings controls update live values after repeated settings reads', () => {
    const h = setup(); h.api.bindSettings();
    const st = h.api.settings();
    assert.equal(st, h.api.settings());
    emit(h, '#cuecard_reply_count', '7');
    emit(h, '#cuecard_max_tokens', '4200');
    emit(h, '#cuecard_profile', 'test-profile');
    emit(h, '#cuecard_use_persona', false, 'checked');
    emit(h, '#cuecard_language', 'en');
    assert.equal(h.api.settings().replyCount, 7);
    assert.equal(h.api.settings().maxTokens, 4200);
    assert.equal(h.api.settings().profileId, 'test-profile');
    assert.equal(h.api.settings().usePersona, false);
    assert.equal(h.api.settings().language, 'en');
    emit(h, '#cuecard_reply_count', '-9');
    assert.equal(h.api.settings().replyCount, 0);
});

test('mutable defaults are isolated between contexts', () => {
    const a = setup().api.settings(); const b = setup().api.settings();
    a.randomMoods.pop(); a.charSummaries.x = { text: 'test' };
    assert.equal(b.randomMoods.length, 5);
    assert.equal(b.charSummaries.x, undefined);
});

test('valid JSON, reasoning and code fences produce clean lists respecting counts', () => {
    const { api } = setup();
    assert.deepEqual(json(api.parseResult('<think>hidden</think>```json\n' + result + '\n```', { replyCount: 1, ideaCount: 1 })), {
        replies: ['하나'], ideas: ['새 손님이 온다.'],
    });
    assert.deepEqual(json(api.parseResult(result, { replyCount: 0, ideaCount: 1 })), {
        replies: [], ideas: ['새 손님이 온다.'],
    });
});

test('truncated JSON, plain text, wrong types and empty results fail without bogus cards', () => {
    const { api } = setup();
    for (const raw of [result.slice(0, -2), '1. reply\n2. idea', '{"replies":{},"ideas":[]}',
        '{"replies":[{"text":5},null,{}],"ideas":[]}', '{"replies":[],"ideas":[]}']) {
        assert.throws(() => api.parseResult(raw), /응답이 잘렸거나/);
    }
});

test('status blocks and private thoughts are excluded while story text remains', () => {
    const { api } = setup();
    for (const block of [
        '<infoblock><Timeline Info>2086-05-14<Inner_Info>SECRET</Inner_Info></Timeline Info></infoblock>',
        '<Inner_Info class="status">SECRET</Inner_Info>',
        '<Timeline Info>SECRET</Timeline Info>',
        '<details><summary>status</summary>SECRET</details>',
        '<thinking data-x="1">SECRET</thinking>',
    ]) assert.equal(api.cleanMessage(block + '\n"같이 가자."'), '"같이 가자."');
    assert.equal(api.cleanMessage('"먼저 가."\n<Inner_Info>SECRET'), '"먼저 가."');
});

test('profile requests receive their own signal and per-request token override', async () => {
    let args;
    const h = setup({ ConnectionManagerRequestService: { async sendRequest(...a) { args = a; return { content: result }; } } });
    h.api.settings().profileId = 'p';
    const controller = new AbortController();
    await h.api.requestLLM([], { signal: controller.signal, maxTokens: 2500 });
    assert.equal(args[0], 'p'); assert.equal(args[2], 2500); assert.equal(args[3].signal, controller.signal);
    assert.equal(h.api.settings().maxTokens, 1500);
});

test('current chat completion preserves current-settings path and receives an independent signal', async () => {
    let args; let request;
    const h = setup({ mainApi: 'openai', getChatCompletionModel: () => 'model',
        chatCompletionSettings: { chat_completion_source: 'custom' },
        stopGeneration() { assert.fail('must not stop the main RP'); },
        generateRaw() { assert.fail('must use cancellable service'); },
        ChatCompletionService: {
            async presetToGeneratePayload(...a) { args = a; return { ...a[2], temperature: 0.8 }; },
            async sendRequest(...a) { request = a; return { content: result }; },
        },
    });
    const controller = new AbortController();
    await h.api.requestLLM([{ role: 'user', content: 'test' }], { signal: controller.signal });
    assert.equal(args[2].model, 'model'); assert.equal(args[2].chat_completion_source, 'custom');
    assert.equal(request[0].temperature, 0.8); assert.equal(request[0].max_tokens, 1500);
    assert.equal(request[2], controller.signal);
});

test('current text completion uses instruct formatting and receives a signal', async () => {
    let request; const instruct = { enabled: true, name: 'template' };
    const h = setup({ mainApi: 'textgenerationwebui', powerUserSettings: { instruct },
        TextCompletionService: {
            constructPrompt(messages, preset) { assert.equal(preset, instruct); return 'formatted'; },
            presetToGeneratePayload(a, b, data) { return data; },
            async sendRequest(...a) { request = a; return { content: result }; },
        },
    });
    const controller = new AbortController();
    await h.api.requestLLM([], { signal: controller.signal });
    assert.equal(request[0].prompt, 'formatted'); assert.equal(request[0].max_new_tokens, 1500);
    assert.equal(request[2], controller.signal);
});

test('aborted request is never sent', async () => {
    const h = setup({ generateRaw() { assert.fail('must not send'); } });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.api.requestLLM([], { signal: controller.signal }), { name: 'AbortError' });
});

test('cancel aborts only the profile request, ignores late data and unlocks afterwards', async () => {
    let receivedSignal; let finish; let calls = 0;
    const h = setup({ ConnectionManagerRequestService: { sendRequest(p, m, n, options) {
        calls++; receivedSignal = options.signal; return new Promise(resolve => { finish = resolve; });
    } } });
    h.api.settings().profileId = 'p';
    const pending = h.api.generate();
    h.api.cancel();
    assert.equal(receivedSignal.aborted, true);
    await h.api.generate();
    assert.equal(calls, 1); assert.equal(h.api.state().busy, true);
    finish({ content: result }); await pending;
    assert.equal(h.api.state().busy, false);
    assert.equal(h.context.chatMetadata.cuecard, undefined);
});

test('legacy cancellation reports result-only mode and prevents overlapping retries', async () => {
    let finish; let calls = 0;
    const h = setup({ generateRaw() { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const pending = h.api.generate(); h.api.cancel();
    assert.match(h.$('#cuecard_results').html(), /개별 중단을 지원하지 않아/);
    await h.api.generate(); assert.equal(calls, 1);
    finish(result); await pending;
    assert.equal(h.api.state().busy, false);
    assert.equal(h.context.chatMetadata.cuecard, undefined);
});

test('malformed generation preserves saved cards and displays actionable error', async () => {
    const previous = { replies: ['기존 카드'], ideas: [], used: { reply: [], idea: [] } };
    const h = setup({ chatMetadata: { cuecard: previous }, generateRaw: async () => result.slice(0, -2) });
    await h.api.generate();
    assert.equal(h.context.chatMetadata.cuecard, previous);
    assert.match(h.$('#cuecard_results').html(), /최대 응답 토큰/);
    assert.equal(h.api.state().busy, false);
});

test('chat switch aborts request and never saves old results in the new chat', async () => {
    let finish;
    const h = setup({ generateRaw() { return new Promise(resolve => { finish = resolve; }); } });
    h.api.init(); const pending = h.api.generate();
    h.context.chatMetadata = {};
    for (const handler of h.events.get('chat')) handler();
    finish(result); await pending;
    assert.equal(h.context.chatMetadata.cuecard, undefined);
});

test('profile list is refreshed by events, never by reopening the native select', () => {
    const h = setup(); h.api.init();
    const handlers = h.elements.get('#cuecard_profile').el.handlers;
    assert.equal(handlers.has('focus'), false); assert.equal(handlers.has('mousedown'), false);
    assert.equal(h.events.get('created').length, 1);
    assert.equal(h.events.get('updated').length, 1);
    assert.equal(h.events.get('deleted').length, 1);
});

test('summary token override leaves saved settings unchanged even when request fails', async () => {
    let tokens;
    const h = setup({ characterId: 0, characters: [{ name: 'Alt', avatar: 'alt.png', description: 'A gamer.' }],
        generateRaw: async data => { tokens = data.responseLength; throw new Error('API failed'); } });
    await h.api.makeSummary();
    assert.equal(tokens, 2500); assert.equal(h.api.settings().maxTokens, 1500);
    assert.equal(h.api.state().summarizing, false);
});

test('cards survive panel close/reopen and reload during the same turn', async () => {
    const h = setup({ generateRaw: async () => result });
    h.api.init(); await h.api.generate();
    const saved = h.context.chatMetadata.cuecard;
    assert.equal(saved.turnKey, h.api.currentTurnKey());
    h.api.togglePanel(false); h.api.togglePanel(true);
    assert.match(h.$('#cuecard_results').html(), /하나/);
    assert.equal(h.context.chatMetadata.cuecard, saved);
    const reloaded = setup({ chat: json(h.context.chat), chatMetadata: json(h.context.chatMetadata) });
    reloaded.api.init();
    assert.match(reloaded.$('#cuecard_results').html(), /하나/);
});

test('new messages, swipe, edit and delete clear both types of cards without deleting notes or summaries', async () => {
    for (const event of ['sent', 'received', 'swiped', 'edited', 'message_deleted']) {
        const h = setup({ generateRaw: async () => result }); h.api.init();
        h.context.chatMetadata.cuecard_note = '내 메모';
        h.api.settings().charSummaries.avatar = { text: '저장된 요약' };
        await h.api.generate();
        for (const handler of h.events.get(event)) handler();
        assert.equal(h.context.chatMetadata.cuecard, undefined, event);
        assert.equal(h.$('#cuecard_results').html(), '', event);
        assert.equal(h.context.chatMetadata.cuecard_note, '내 메모');
        assert.equal(h.api.settings().charSummaries.avatar.text, '저장된 요약');
        assert.equal(h.$('#cuecard_go').text(), '쪽지 받기');
    }
});

test('card selection replaces existing input and other choices; sending removes only cards', async () => {
    const h = setup({ generateRaw: async () => result }); h.api.init(); await h.api.generate();
    const card = {};
    h.$(card).data('type', 'reply').data('idx', 0);
    const click = h.elements.get('#cuecard_panel').el.handlers.get('click:.cuecard-card');
    h.$('#send_textarea').val('이미 작성한 입력');
    click.call(card);
    assert.equal(h.$('#send_textarea').val(), '하나');
    assert.equal(h.context.chatMetadata.cuecard.used.reply[0], 0);
    assert.equal(h.context.chatMetadata.cuecard.replies.length, 2);
    h.$(card).data('idx', 1); click.call(card);
    assert.equal(h.$('#send_textarea').val(), '둘');
    click.call(card);
    assert.equal(h.$('#send_textarea').val(), '둘');
    h.$(card).data('type', 'idea').data('idx', 0); click.call(card);
    assert.equal(h.$('#send_textarea').val(), '(OOC: 새 손님이 온다.)');
    h.$(card).data('type', 'reply').data('idx', 0); click.call(card);
    assert.equal(h.$('#send_textarea').val(), '하나');
    h.context.chat.push({ name: 'User', is_user: true, mes: '하나' });
    for (const handler of h.events.get('sent')) handler();
    assert.equal(h.$('#send_textarea').val(), '하나');
    assert.equal(h.context.chatMetadata.cuecard, undefined);
});

test('reload discards expired and legacy cards and never restores them when rewinding', async () => {
    const h = setup({ generateRaw: async () => result }); h.api.init(); await h.api.generate();
    const meta = json(h.context.chatMetadata);
    const next = setup({ chatMetadata: meta, chat: [...json(h.context.chat), { name: 'User', is_user: true, mes: '다음' }] });
    next.api.init();
    assert.equal(next.context.chatMetadata.cuecard, undefined);
    next.context.chat.pop(); next.api.showStored();
    assert.equal(next.$('#cuecard_results').html(), '');
    const legacy = setup({ chatMetadata: { cuecard: { replies: ['old'], ideas: [] } } });
    legacy.api.init(); assert.equal(legacy.context.chatMetadata.cuecard, undefined);
});

test('turn change while waiting aborts and never renders the late cards', async () => {
    let finish; let signal;
    const h = setup({ ConnectionManagerRequestService: { sendRequest(p, m, t, options) {
        signal = options.signal; return new Promise(resolve => { finish = resolve; });
    } } });
    h.api.init(); h.api.settings().profileId = 'p';
    const pending = h.api.generate();
    h.context.chat.push({ name: 'User', is_user: true, mes: '보냄' });
    for (const handler of h.events.get('sent')) handler();
    assert.equal(signal.aborted, true);
    finish({ content: result }); await pending;
    assert.equal(h.context.chatMetadata.cuecard, undefined);
    assert.equal(h.$('#cuecard_results').html(), '');
    assert.equal(h.api.state().busy, false);
});

test('late responses and stale clicks are rejected even if a chat event was missed', async () => {
    for (const mutate of [
        h => h.context.chat.push({ name: 'User', is_user: true, mes: '보냄' }),
        h => { h.context.chat[0].mes = '다른 스와이프'; h.context.chat[0].swipe_id = 1; },
    ]) {
        let finish;
        const h = setup({ generateRaw: () => new Promise(resolve => { finish = resolve; }) });
        const pending = h.api.generate(); mutate(h); finish(result); await pending;
        assert.equal(h.context.chatMetadata.cuecard, undefined);
    }
    const h = setup({ generateRaw: async () => result }); h.api.init(); await h.api.generate();
    h.context.chat[0].mes = '바뀐 답변';
    const card = {}; h.$(card).data('type', 'reply').data('idx', 0);
    h.elements.get('#cuecard_panel').el.handlers.get('click:.cuecard-card').call(card);
    assert.equal(h.$('#send_textarea').val(), '');
    assert.equal(h.context.chatMetadata.cuecard, undefined);
});

const fire = (h, name, ...args) => { for (const handler of h.events.get(name) || []) handler(...args); };

test('custom moods join chips, random pool and prompt; deleting resets the selection', () => {
    const h = setup(); h.api.init();
    h.$('#cuecard_custom_label').val('도깨비 장난');
    h.$('#cuecard_custom_desc').val('도깨비가 몰래 장난을 쳐서 일이 꼬임');
    h.api.addCustomMood();
    const mood = h.api.allMoods().at(-1);
    assert.equal(mood.label, '도깨비 장난');
    assert.ok(h.api.settings().randomMoods.includes(mood.id));
    assert.match(h.$('#cuecard_moods').html(), /도깨비 장난/);
    h.api.settings().lastMood = mood.id;
    assert.equal(h.api.pickMood().id, mood.id);
    const system = h.api.buildMessages(mood, '')[0].content;
    assert.match(system, /도깨비 장난 — 도깨비가 몰래 장난을 쳐서 일이 꼬임/);
    h.$('#cuecard_custom_label').val('도깨비 장난'); h.api.addCustomMood();
    assert.equal(h.api.settings().customMoods.length, 1);
    h.api.removeCustomMood(mood.id);
    assert.equal(h.api.settings().lastMood, 'normal');
    assert.equal(h.api.settings().randomMoods.includes(mood.id), false);
});

test('length and form chips cycle and change the reply instructions', () => {
    const h = setup(); h.api.init();
    const mood = h.api.allMoods()[0];
    assert.match(h.api.buildMessages(mood, '')[0].content, /Keep each 1-4 sentences/);
    h.api.cycleSetting('lastLength'); assert.equal(h.api.settings().lastLength, 'short');
    h.api.cycleSetting('lastForm'); assert.equal(h.api.settings().lastForm, 'dialogue');
    const system = h.api.buildMessages(mood, '')[0].content;
    assert.match(system, /very short/); assert.match(system, /ONLY spoken lines/);
    h.api.cycleSetting('lastLength'); h.api.cycleSetting('lastForm');
    const next = h.api.buildMessages(mood, '')[0].content;
    assert.match(next, /4-7 sentences/); assert.match(next, /no spoken dialogue/);
    h.api.cycleSetting('ideaMode'); assert.equal(h.api.settings().ideaMode, 'hidden');
});

test('one note can be rewritten alone while the others stay', async () => {
    const calls = [];
    const h = setup({ generateRaw: async (data) => {
        calls.push(data.systemPrompt);
        return calls.length === 1 ? result : '{"replies":["짧은 둘"]}';
    } });
    h.api.init(); await h.api.generate();
    h.context.chatMetadata.cuecard.used.reply.push(1);
    await h.api.generate({ type: 'reply', idx: 1, variant: 'shorter', oldText: '둘' });
    const saved = h.context.chatMetadata.cuecard;
    assert.deepEqual(json(saved.replies), ['하나', '짧은 둘']);
    assert.deepEqual(json(saved.ideas), ['새 손님이 온다.']);
    assert.equal(saved.used.reply.includes(1), false);
    assert.match(calls[1], /exactly 1 different candidate/);
    assert.match(calls[1], /shorter, punchier version .*"둘"/);
    assert.doesNotMatch(calls[1], /"ideas": exactly/);
    assert.equal(h.api.state().busy, false);
});

test('a failed rewrite keeps the original note', async () => {
    let n = 0;
    const h = setup({ generateRaw: async () => (++n === 1 ? result : 'broken') });
    h.api.init(); await h.api.generate();
    await h.api.generate({ type: 'idea', idx: 0, variant: 'again', oldText: '새 손님이 온다.' });
    assert.deepEqual(json(h.context.chatMetadata.cuecard.ideas), ['새 손님이 온다.']);
    assert.match(h.$('#cuecard_results').html(), /새 손님이 온다/);
});

test('pinned notes survive the turn and can be removed', async () => {
    const h = setup({ generateRaw: async () => result }); h.api.init(); await h.api.generate();
    h.api.togglePin('reply', '하나'); h.api.togglePin('idea', '새 손님이 온다.');
    assert.equal(h.api.getPins().length, 2);
    assert.match(h.$('#cuecard_results').html(), /fa-thumbtack pinned/);
    h.context.chat.push({ name: 'User', is_user: true, mes: '보냄' }); fire(h, 'sent');
    assert.equal(h.context.chatMetadata.cuecard, undefined);
    assert.equal(h.api.getPins().length, 2);
    assert.match(h.$('#cuecard_pin_list').html(), /하나/);
    h.api.togglePin('reply', '하나');
    assert.deepEqual(json(h.api.getPins()), [{ type: 'idea', text: '새 손님이 온다.' }]);
});

test('hidden idea mode injects once, keeps the input clean and clears after the reply', async () => {
    const prompts = [];
    const h = setup({ generateRaw: async () => result,
        setExtensionPrompt: (...a) => prompts.push(a) });
    h.api.init(); await h.api.generate();
    h.api.settings().ideaMode = 'hidden';
    h.$('#send_textarea').val('내 대사');
    h.api.useNote('idea', '새 손님이 온다.');
    assert.equal(h.$('#send_textarea').val(), '내 대사');
    assert.match(prompts.at(-1)[1], /새 손님이 온다/);
    assert.equal(prompts.at(-1)[0], 'cribnote_direction');
    // 생성 전에 끝난 답(예: 이미 진행 중이던 답)은 지우지 않아요
    fire(h, 'received');
    assert.equal(h.api.getPending().text, '새 손님이 온다.');
    fire(h, 'gen_started', 'quiet', {}, false);
    fire(h, 'gen_started', 'normal', {}, true);
    fire(h, 'received');
    assert.ok(h.api.getPending());
    fire(h, 'gen_started', 'normal', {}, false);
    fire(h, 'received');
    assert.equal(h.api.getPending(), null);
    assert.equal(prompts.at(-1)[1], '');
});

test('hidden idea mode falls back to OOC when the API is missing', () => {
    const h = setup(); h.api.init();
    h.api.settings().ideaMode = 'hidden';
    h.api.useNote('idea', '비가 온다.');
    assert.equal(h.$('#send_textarea').val(), '(OOC: 비가 온다.)');
    assert.equal(h.api.getPending(), null);
});

test('the main button starts a full request even though jQuery passes an event object', async () => {
    const h = setup({ generateRaw: async () => result }); h.api.init();
    await h.elements.get('#cuecard_go').el.handlers.get('click')({ type: 'click', target: {} });
    assert.deepEqual(json(h.context.chatMetadata.cuecard.replies), ['하나', '둘']);
});
