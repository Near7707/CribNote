// Crib Note v0.9.4 — 이야기 맥락을 읽고 답변 후보 + 전개 아이디어를 추천하는 실리태번 확장
(() => {
    'use strict';

    const MODULE = 'cuecard';
    const ctx = () => SillyTavern.getContext();

    const MOODS = [
        { id: 'normal',  label: '평범',   desc: 'a natural, everyday continuation of the current scene' },
        { id: 'tense',   label: '긴장',   desc: 'tension, suspense, danger or conflict' },
        { id: 'romance', label: '로맨스', desc: 'romance, emotional closeness, flirting, intimacy of feelings' },
        { id: 'comic',   label: '코믹',   desc: 'humor, lightheartedness, playful mishaps' },
        { id: 'twist',   label: '반전',   desc: 'an unexpected twist, surprising revelation or sudden change' },
    ];

    const DEFAULTS = {
        profileId: '',
        replyCount: 3,
        ideaCount: 2,
        contextMessages: 10,
        usePersona: true,
        useCharacter: true,
        language: 'ko',        // 답변 후보 언어
        ideaLanguage: 'ko',    // 전개 아이디어 언어
        maxTokens: 1500,
        randomMoods: MOODS.map(m => m.id),
        autoClose: true,       // 쪽지를 고르면 패널 닫기
        closeOnOutside: false, // 패널 바깥을 누르면 닫기
        lastMood: 'normal',
        charSummaries: {},     // 캐릭터별 요약 { avatar: {text, hash, date} }
        customMoods: [],       // 내 분위기 [{id, label, desc}]
        lastLength: 'normal',  // short | normal | long
        lastForm: 'free',      // free | dialogue | action
        ideaMode: 'ooc',       // ooc: 입력창에 OOC로 / hidden: 다음 답변에 몰래 반영
    };

    const LENGTHS = { normal: '길이: 보통', short: '길이: 짧게', long: '길이: 길게' };
    const FORMS = { free: '형식: 자유', dialogue: '형식: 대사만', action: '형식: 행동만' };
    const LANGS = { ko: '답변: 한글', en: '답변: EN', auto: '답변: 대화 따라' };
    const IDEA_MODES = { ooc: '전개: OOC', hidden: '전개: 몰래' };
    const CYCLES = {
        lastLength: { labels: LENGTHS, select: null },
        lastForm: { labels: FORMS, select: null },
        language: { labels: LANGS, select: '#cuecard_language' },
        ideaMode: { labels: IDEA_MODES, select: '#cuecard_idea_mode' },
    };

    const PIN_KEY = 'cuecard_pins';
    const PIN_TURN_KEY = 'cuecard_pins_turn';
    const SWIPE_NOTES_KEY = 'cuecard_swipe_notes';
    const PENDING_KEY = 'cuecard_pending';
    const EXT_PROMPT_KEY = 'cribnote_direction';

    function allMoods() {
        return [...MOODS, ...(settings().customMoods || [])];
    }

    const ICON_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-8 16 16)"><path d="M7 5h13l5 5v17H7z" fill="#FAEEDA" stroke="#BA7517" stroke-width="1.3" stroke-linejoin="round"/><path d="M20 5v5h5" fill="#FAC775" stroke="#BA7517" stroke-width="1.1" stroke-linejoin="round"/><path d="M10 14h9M10 18h10M10 22h6" stroke="#BA7517" stroke-width="1" stroke-linecap="round"/></g><path d="M22 23.5c-2.5-1.8-3-3.6-2-4.5.8-.7 1.7-.3 2 .4.3-.7 1.2-1.1 2-.4 1 .9.5 2.7-2 4.5z" fill="#ED93B1" stroke="#D4537E" stroke-width="0.8"/></svg>';

    let busy = false;
    let runId = 0;              // 취소용: 진행 중인 요청 번호
    let abortCtl = null;
    let cancelMode = 'request';
    let lastSent = null;        // 마지막으로 보낸 프롬프트
    let summarizing = false;

    // ---------- 설정 ----------
    function settings() {
        const all = ctx().extensionSettings;
        const st = all[MODULE] ??= {};
        // 이벤트 핸들러가 참조하는 객체를 교체하지 않고 빠진 기본값만 채워요.
        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (st[key] === undefined) st[key] = structuredClone(value);
        }
        // v0.8.1: '바깥 누르면 닫기' 기본값을 끔으로 바꿨어요. 예전 기본값(켜짐)으로 저장된 경우 한 번만 끔으로 맞춰요.
        if (!st.closeOnOutsideReset) {
            st.closeOnOutside = false;
            st.closeOnOutsideReset = true;
        }
        return st;
    }
    function save() { ctx().saveSettingsDebounced(); }

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getProfiles() {
        return ctx().extensionSettings?.connectionManager?.profiles || [];
    }

    function fillProfileSelect() {
        const st = settings();
        const $sel = $('#cuecard_profile');
        $sel.empty();
        $sel.append('<option value="">(현재 연결된 API 사용)</option>');
        const profiles = getProfiles();
        for (const p of profiles) {
            $sel.append(`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`);
        }
        // 목록에 없어도 저장값은 지우지 않아요.
        // (불러오는 순간 목록이 비어 있으면 선택이 초기화되던 문제 방지)
        if (st.profileId && !profiles.some(p => p.id === st.profileId)) {
            $sel.append(`<option value="${escapeHtml(st.profileId)}">⚠️ 찾을 수 없는 프로필 — 다시 골라주세요</option>`);
        }
        $sel.val(st.profileId);
    }

    function buildSettingsHtml() {
        return `
        <div class="cuecard-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b class="cuecard-title"><span class="cuecard-title-icon">${ICON_SVG}</span>Crib Note</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                  <div class="cuecard-inner">
                    <label for="cuecard_profile">추천에 쓸 연결 프로필</label>
                    <select id="cuecard_profile" class="text_pole"></select>
                    <small>비워두면 지금 대화에 연결된 API를 그대로 써요.</small>

                    <div class="cuecard-row">
                        <div>
                            <label for="cuecard_reply_count">답변 후보 개수</label>
                            <input id="cuecard_reply_count" type="number" min="0" max="8" class="text_pole">
                        </div>
                        <div>
                            <label for="cuecard_idea_count">전개 아이디어 개수</label>
                            <input id="cuecard_idea_count" type="number" min="0" max="8" class="text_pole">
                        </div>
                    </div>

                    <div class="cuecard-row">
                        <div>
                            <label for="cuecard_context">읽을 최근 메시지 수</label>
                            <input id="cuecard_context" type="number" min="1" max="60" class="text_pole">
                        </div>
                        <div>
                            <label for="cuecard_max_tokens">최대 응답 토큰</label>
                            <input id="cuecard_max_tokens" type="number" min="200" max="8000" step="100" class="text_pole">
                        </div>
                    </div>

                    <div class="cuecard-row">
                        <div>
                            <label for="cuecard_language">답변 후보 언어</label>
                            <select id="cuecard_language" class="text_pole">
                                <option value="ko">한국어</option>
                                <option value="en">English</option>
                                <option value="auto">대화 언어 따라가기</option>
                            </select>
                        </div>
                        <div>
                            <label for="cuecard_idea_language">전개 아이디어 언어</label>
                            <select id="cuecard_idea_language" class="text_pole">
                                <option value="ko">한국어</option>
                                <option value="en">English</option>
                                <option value="auto">대화 언어 따라가기</option>
                            </select>
                        </div>
                    </div>
                    <small>답변 후보 언어는 추천 패널에서도 바로 바꿀 수 있어요.</small>

                    <label for="cuecard_idea_mode">전개 쪽지를 고르면</label>
                    <select id="cuecard_idea_mode" class="text_pole">
                        <option value="ooc">입력창에 (OOC: …)로 넣기</option>
                        <option value="hidden">다음 답변에 몰래 반영 (채팅에 안 남음)</option>
                    </select>
                    <small>몰래 반영은 작가 노트처럼 AI한테만 보이고, 다음 답변 한 번만 적용돼요. 패널에서도 바꿀 수 있어요.</small>

                    <label class="checkbox_label"><input id="cuecard_use_persona" type="checkbox"> 페르소나 설명 참고</label>
                    <label class="checkbox_label"><input id="cuecard_auto_close" type="checkbox"> 추천을 고르면 패널 자동으로 닫기</label>
                    <label class="checkbox_label"><input id="cuecard_close_outside" type="checkbox"> 패널 바깥을 누르면 닫기</label>
                    <label class="checkbox_label"><input id="cuecard_use_character" type="checkbox"> 캐릭터 카드 참고</label>
                    <small>📇 캐릭터 요약을 만들어두면 카드 원문 대신 요약을 써요. 추천 패널의 카드 버튼에서 만들 수 있어요.</small>

                    <small>📝 내 캐릭터 메모는 채팅방마다 따로 적어요. 추천 패널의 연필 버튼을 눌러보세요.</small>

                    <label>🎨 내 분위기</label>
                    <div id="cuecard_custom_list" class="cuecard-custom-list"></div>
                    <div class="cuecard-custom-add">
                        <input id="cuecard_custom_label" class="text_pole" type="text" maxlength="12" placeholder="이름 (예: 도깨비 장난)">
                        <input id="cuecard_custom_desc" class="text_pole" type="text" maxlength="200" placeholder="설명 (선택) 예: 도깨비가 몰래 장난을 쳐서 일이 꼬임">
                        <div id="cuecard_custom_add" class="menu_button">추가</div>
                    </div>
                    <small>설명을 적으면 AI가 분위기를 더 잘 알아들어요. 비우면 이름만 보내요.</small>

                    <label>🎲 랜덤에 포함할 분위기</label>
                    <div id="cuecard_moodchecks" class="cuecard-moodchecks"></div>

                    <div id="cuecard_view_prompt_s" class="menu_button">👁 보낸 프롬프트 보기</div>
                  </div>
                </div>
            </div>
        </div>`;
    }

    function renderMoodSettings() {
        const st = settings();
        $('#cuecard_moodchecks').html(allMoods().map(m => `
            <label class="checkbox_label">
                <input type="checkbox" class="cuecard_randmood" value="${escapeHtml(m.id)}"${st.randomMoods.includes(m.id) ? ' checked' : ''}> ${escapeHtml(m.label)}
            </label>`).join(''));
        $('#cuecard_custom_list').html(st.customMoods.length
            ? st.customMoods.map(m => `
                <div class="cuecard-custom-item">
                    <b>${escapeHtml(m.label)}</b>
                    <small>${escapeHtml(m.desc || '')}</small>
                    <span class="cuecard-custom-del fa-solid fa-trash" data-id="${escapeHtml(m.id)}" title="삭제"></span>
                </div>`).join('')
            : '<small class="cuecard-empty">아직 없어요. 아래에서 추가해보세요.</small>');
    }

    function addCustomMood() {
        const st = settings();
        const label = String($('#cuecard_custom_label').val() || '').trim().slice(0, 12);
        const desc = String($('#cuecard_custom_desc').val() || '').trim().slice(0, 200);
        if (!label) { toastr.info('분위기 이름을 적어주세요.', 'Crib Note'); return; }
        if (allMoods().some(m => m.label === label)) { toastr.info('이미 있는 분위기예요.', 'Crib Note'); return; }
        const id = 'c' + Date.now().toString(36);
        st.customMoods.push({ id, label, desc });
        st.randomMoods.push(id);
        save();
        $('#cuecard_custom_label').val('');
        $('#cuecard_custom_desc').val('');
        renderMoodSettings();
        renderMoodChips();
    }

    function removeCustomMood(id) {
        const st = settings();
        st.customMoods = st.customMoods.filter(m => m.id !== id);
        st.randomMoods = st.randomMoods.filter(x => x !== id);
        if (st.lastMood === id) st.lastMood = 'normal';
        save();
        renderMoodSettings();
        renderMoodChips();
    }

    function bindSettings() {
        const st = settings();
        renderMoodSettings();

        fillProfileSelect();
        $('#cuecard_profile').on('change', function () { st.profileId = $(this).val(); save(); });

        const num = (id, key, min, max) => {
            $(id).val(st[key]).on('change', function () {
                let v = parseInt($(this).val(), 10);
                if (isNaN(v)) v = DEFAULTS[key];
                v = Math.max(min, Math.min(max, v));
                $(this).val(v);
                st[key] = v;
                save();
            });
        };
        num('#cuecard_reply_count', 'replyCount', 0, 8);
        num('#cuecard_idea_count', 'ideaCount', 0, 8);
        num('#cuecard_context', 'contextMessages', 1, 60);
        num('#cuecard_max_tokens', 'maxTokens', 200, 8000);

        $('#cuecard_language').val(st.language).on('change', function () { st.language = $(this).val(); save(); refreshCycleChips(); });
        $('#cuecard_idea_mode').val(st.ideaMode).on('change', function () { st.ideaMode = $(this).val(); save(); refreshCycleChips(); });
        $('#cuecard_idea_language').val(st.ideaLanguage).on('change', function () { st.ideaLanguage = $(this).val(); save(); });
        $('#cuecard_use_persona').prop('checked', st.usePersona).on('change', function () { st.usePersona = this.checked; save(); });
        $('#cuecard_use_character').prop('checked', st.useCharacter).on('change', function () { st.useCharacter = this.checked; save(); });
        $('#cuecard_auto_close').prop('checked', st.autoClose).on('change', function () { st.autoClose = this.checked; save(); });
        $('#cuecard_close_outside').prop('checked', st.closeOnOutside).on('change', function () { st.closeOnOutside = this.checked; save(); });
        $('#cuecard_view_prompt_s').on('click', showPrompt);

        $('#cuecard_moodchecks').on('change', '.cuecard_randmood', () => {
            settings().randomMoods = $('.cuecard_randmood:checked').map((_, el) => el.value).get();
            save();
        });
        $('#cuecard_custom_add').on('click', addCustomMood);
        $('#cuecard_custom_desc').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomMood(); } });
        $('#cuecard_custom_list').on('click', '.cuecard-custom-del', function () {
            const id = String($(this).data('id'));
            const m = settings().customMoods.find(x => x.id === id);
            if (m && confirm(`'${m.label}' 분위기를 지울까요?`)) removeCustomMood(id);
        });
    }

    // ---------- 패널 UI ----------
    function buildPanel() {
        const cycle = (key, title) => `<div class="cuecard-chip cuecard-cycle" data-key="${key}" title="${title}"></div>`;
        return `
        <div id="cuecard_panel" style="display:none">
          <div class="cuecard-frame">
           <div class="cuecard-head">
            <div id="cuecard_moods" class="cuecard-moods"></div>
            <div class="cuecard-opts">
                ${cycle('lastLength', '대사 쪽지 길이')}
                ${cycle('lastForm', '대사 쪽지 형식')}
                ${cycle('language', '대사 쪽지 언어')}
                ${cycle('ideaMode', '전개 쪽지를 고르면 어떻게 할지')}
            </div>
            <div id="cuecard_pending" class="cuecard-pending" style="display:none"></div>
            <div class="cuecard-actions">
                <input id="cuecard_direction" class="text_pole" type="text"
                    placeholder="추가 요청 (선택) 예: 탈출하는 쪽으로">
                <div id="cuecard_go" class="menu_button">쪽지 받기</div>
                <div id="cuecard_pin_btn" class="menu_button fa-solid fa-thumbtack" title="쪽지 보관함"></div>
                <div id="cuecard_char_btn" class="menu_button fa-solid fa-address-card" title="캐릭터 요약"></div>
                <div id="cuecard_note_btn" class="menu_button fa-solid fa-pen" title="이 채팅방의 내 캐릭터 메모"></div>
                <div id="cuecard_view_prompt" class="menu_button fa-solid fa-eye" title="보낸 프롬프트 보기"></div>
                <div id="cuecard_close" class="menu_button fa-solid fa-xmark" title="닫기"></div>
            </div>
           </div>
           <div class="cuecard-body">
            <div id="cuecard_char_box" class="cuecard-box" style="display:none">
                <div class="cuecard-note-title">📇 캐릭터 요약 <small>(이 캐릭터의 모든 채팅방에 적용)</small></div>
                <div id="cuecard_char_status" class="cuecard-char-status"></div>
                <textarea id="cuecard_char_summary" class="text_pole" rows="6"
                    placeholder="아직 요약이 없어요. '요약 만들기'를 누르면 캐릭터 카드를 읽고 짧게 정리해요. 직접 고쳐도 돼요."></textarea>
                <div class="cuecard-char-actions">
                    <div id="cuecard_char_make" class="menu_button">요약 만들기</div>
                    <div id="cuecard_char_clear" class="menu_button">요약 지우기</div>
                </div>
            </div>
            <div id="cuecard_note_box" class="cuecard-box" style="display:none">
                <div class="cuecard-note-title">📝 내 캐릭터 메모 <small>(이 채팅방에만 적용)</small></div>
                <textarea id="cuecard_note" class="text_pole" rows="3"
                    placeholder="예: 겉으론 무뚝뚝하지만 속으로 걱정 많음. 반말 씀. 위험하면 먼저 나서는 편."></textarea>
            </div>
            <div id="cuecard_pin_box" class="cuecard-box" style="display:none">
                <div class="cuecard-note-title">📌 쪽지 보관함 <small>(이번 턴에만 유지)</small></div>
                <div id="cuecard_pin_list"></div>
            </div>
            <div id="cuecard_results"></div>
           </div>
          </div>
        </div>`;
    }

    function refreshChips() {
        const st = settings();
        $('#cuecard_panel .cuecard-chip').removeClass('selected');
        $(`#cuecard_panel .cuecard-chip[data-mood="${st.lastMood}"]`).addClass('selected');
    }

    function renderMoodChips() {
        $('#cuecard_moods').html(allMoods().map(m =>
            `<div class="cuecard-chip" data-mood="${escapeHtml(m.id)}">${escapeHtml(m.label)}</div>`).join('') +
            '<div class="cuecard-chip" data-mood="random">🎲 랜덤</div>');
        refreshChips();
    }

    function refreshCycleChips() {
        const st = settings();
        for (const [key, cfg] of Object.entries(CYCLES)) {
            const label = cfg.labels[st[key]] || Object.values(cfg.labels)[0];
            $(`#cuecard_panel .cuecard-cycle[data-key="${key}"]`).text(label)
                .toggleClass('selected', key === 'ideaMode' ? st[key] === 'hidden'
                    : key === 'language' ? false : st[key] !== Object.keys(cfg.labels)[0]);
        }
    }

    function cycleSetting(key) {
        const cfg = CYCLES[key];
        if (!cfg) return;
        const st = settings();
        const order = Object.keys(cfg.labels);
        st[key] = order[(order.indexOf(st[key]) + 1) % order.length];
        save();
        if (cfg.select) $(cfg.select).val(st[key]);
        refreshCycleChips();
    }

    function togglePanel(force) {
        const $p = $('#cuecard_panel');
        const show = force ?? !$p.is(':visible');
        $p.toggle(show);
        if (show) { refreshChips(); refreshCycleChips(); refreshPending(); refreshPins(); if (!busy) showStored(); }
    }

    function scrollPanelTop() {
        const body = $('#cuecard_panel .cuecard-body')[0];
        if (body) body.scrollTop = 0;
    }

    function setStatus(html) { $('#cuecard_results').html(`<div class="cuecard-status">${html}</div>`); }

    // 같은 메시지의 스와이프는 복구하고, 다음 메시지로 진행하면 정리해요.
    function currentTurnKey() {
        const chat = ctx().chat || [];
        const last = chat[chat.length - 1];
        return JSON.stringify([
            chat.length, last?.send_date ?? null, last?.name ?? '',
            !!last?.is_user, last?.swipe_id ?? null, hashStr(String(last?.mes || '')),
        ]);
    }

    function swipeNoteKey(turnKey) {
        if (arguments.length === 0) turnKey = currentTurnKey();
        try {
            const [count, , name, isUser, swipeId, textHash] = JSON.parse(turnKey);
            if (!Number.isInteger(count) || typeof textHash !== 'string') return null;
            // 첫 스와이프 때 생기는 swipe_id: 0, 바뀔 수 있는 표시 시각은 같은 응답으로 취급해요.
            return JSON.stringify([count, name, !!isUser, swipeId ?? 0, textHash]);
        } catch { return null; }
    }

    function sameMessageSlot(a, b) {
        if (!a || !b) return false;
        const x = JSON.parse(a), y = JSON.parse(b);
        return x[0] === y[0] && x[2] === y[2];
    }

    function swipeMessageScope() {
        const chat = ctx().chat || [];
        const prev = chat[chat.length - 2];
        return JSON.stringify([chat.length, !!chat[chat.length - 1]?.is_user,
            prev?.name ?? '', prev?.send_date ?? null, hashStr(String(prev?.mes || ''))]);
    }

    function syncSwipeNotes() {
        const meta = ctx().chatMetadata;
        if (!meta) return;
        const key = swipeNoteKey(), scope = swipeMessageScope(), turn = currentTurnKey();
        let cache = meta[SWIPE_NOTES_KEY];
        if (cache && cache.scope !== scope) {
            // 다른 메시지 위치의 기록은 이어받지 않아요.
            delete meta[SWIPE_NOTES_KEY];
            delete meta[MODULE]; delete meta[PIN_KEY]; delete meta[PIN_TURN_KEY];
            saveMeta();
            return;
        }
        let changed = false;
        if (!cache) {
            const resultKey = swipeNoteKey(meta[MODULE]?.turnKey);
            const pins = meta[PIN_KEY];
            const pinKey = Array.isArray(pins) && pins.length
                ? (meta[PIN_TURN_KEY] ? swipeNoteKey(meta[PIN_TURN_KEY]) : key) : null;
            const activeKey = sameMessageSlot(resultKey, key) ? resultKey
                : sameMessageSlot(pinKey, key) ? pinKey : null;
            if (!activeKey) return;
            cache = meta[SWIPE_NOTES_KEY] = { scope, activeKey, entries: {} };
            changed = true;
        }
        if (cache.activeKey !== key) {
            const result = swipeNoteKey(meta[MODULE]?.turnKey) === cache.activeKey ? meta[MODULE] : null;
            const pins = Array.isArray(meta[PIN_KEY])
                && (!meta[PIN_TURN_KEY] || swipeNoteKey(meta[PIN_TURN_KEY]) === cache.activeKey) ? meta[PIN_KEY] : [];
            if (result || pins.length) cache.entries[cache.activeKey] = structuredClone({ result, pins });
            else delete cache.entries[cache.activeKey];
            const restored = cache.entries[key];
            delete meta[MODULE]; delete meta[PIN_KEY]; delete meta[PIN_TURN_KEY];
            if (restored?.result) meta[MODULE] = { ...structuredClone(restored.result), turnKey: turn };
            if (restored?.pins?.length) {
                meta[PIN_KEY] = structuredClone(restored.pins);
                meta[PIN_TURN_KEY] = turn;
            }
            cache.activeKey = key;
            changed = true;
        }
        if (meta[MODULE] && swipeNoteKey(meta[MODULE].turnKey) === key && meta[MODULE].turnKey !== turn) {
            meta[MODULE].turnKey = turn;
            changed = true;
        }
        if (meta[PIN_TURN_KEY] && swipeNoteKey(meta[PIN_TURN_KEY]) === key && meta[PIN_TURN_KEY] !== turn) {
            meta[PIN_TURN_KEY] = turn;
            changed = true;
        }
        if (changed) saveMeta();
    }

    function onSwipeChanged(messageId) {
        if (Number.isInteger(messageId) && messageId !== (ctx().chat?.length || 0) - 1) {
            expireResults();
            return;
        }
        if (busy) cancel();
        syncSwipeNotes();
        refreshPins();
        showStored();
        if (busy) $('#cuecard_go').addClass('cuecard-cancel').text('취소 중…');
    }

    function loadStored() {
        syncSwipeNotes();
        const c = ctx();
        const stored = c.chatMetadata?.[MODULE];
        if (stored && stored.turnKey !== currentTurnKey()) {
            // 이전 버전의 턴 정보 없는 카드도 여기서 한 번 정리해요.
            delete c.chatMetadata[MODULE];
            (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
            return null;
        }
        return stored || null;
    }
    function storeResult(data) {
        const c = ctx();
        if (!c.chatMetadata) return;
        syncSwipeNotes();
        c.chatMetadata[MODULE] = data;
        syncSwipeNotes();
        (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
    }

    function expireResults() {
        if (busy) cancel();
        const c = ctx();
        if (c.chatMetadata && (c.chatMetadata[MODULE] || c.chatMetadata[PIN_KEY] || c.chatMetadata[PIN_TURN_KEY] || c.chatMetadata[SWIPE_NOTES_KEY])) {
            delete c.chatMetadata[MODULE];
            delete c.chatMetadata[PIN_KEY];
            delete c.chatMetadata[PIN_TURN_KEY];
            delete c.chatMetadata[SWIPE_NOTES_KEY];
            (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
        }
        refreshPins();
        $('#cuecard_results').empty();
        if (busy) $('#cuecard_go').addClass('cuecard-cancel').text('취소 중…');
        else setGoButton('idle');
    }

    // 채팅방별 내 캐릭터 메모
    const NOTE_KEY = 'cuecard_note';
    function getNote() {
        return String(ctx().chatMetadata?.[NOTE_KEY] || '');
    }
    function setNote(text) {
        const c = ctx();
        if (!c.chatMetadata) return;
        c.chatMetadata[NOTE_KEY] = text;
        (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
    }
    function refreshNote() {
        const note = getNote();
        $('#cuecard_note').val(note);
        $('#cuecard_note_btn').toggleClass('cuecard-has-note', !!note.trim());
    }

    // ---------- 쪽지 보관함 (채팅방별, 이번 턴만) ----------
    function saveMeta() {
        const c = ctx();
        (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
    }
    function getPins() {
        syncSwipeNotes();
        const meta = ctx().chatMetadata;
        const pins = meta?.[PIN_KEY];
        if (!Array.isArray(pins) || !pins.length) return [];
        const turn = currentTurnKey();
        // 이전 버전에서 보관한 쪽지는 현재 턴에 한 번 연결해요.
        if (!meta[PIN_TURN_KEY]) {
            meta[PIN_TURN_KEY] = turn;
            saveMeta();
        } else if (meta[PIN_TURN_KEY] !== turn) {
            clearPins();
            return [];
        }
        return pins;
    }
    function clearPins() {
        const meta = ctx().chatMetadata;
        if (!meta || (!meta[PIN_KEY] && !meta[PIN_TURN_KEY])) return;
        delete meta[PIN_KEY];
        delete meta[PIN_TURN_KEY];
        saveMeta();
    }
    function isPinned(type, text) {
        return getPins().some(p => p.type === type && p.text === text);
    }
    function togglePin(type, text) {
        const c = ctx();
        if (!c.chatMetadata) return;
        const pins = getPins();
        const i = pins.findIndex(p => p.type === type && p.text === text);
        if (i >= 0) pins.splice(i, 1);
        else pins.push({ type, text });
        if (pins.length) {
            c.chatMetadata[PIN_KEY] = pins;
            c.chatMetadata[PIN_TURN_KEY] = currentTurnKey();
            syncSwipeNotes();
            saveMeta();
        } else clearPins();
        refreshPins();
        const stored = loadStored();
        if (stored && !busy) renderResults(stored);
    }
    function removePin(i) {
        const c = ctx();
        const pins = getPins();
        if (!c.chatMetadata || !pins[i]) return;
        pins.splice(i, 1);
        if (pins.length) {
            c.chatMetadata[PIN_KEY] = pins;
            saveMeta();
        } else clearPins();
        refreshPins();
        const stored = loadStored();
        if (stored && !busy) renderResults(stored);
    }
    function refreshPins() {
        const pins = getPins();
        $('#cuecard_pin_btn').toggleClass('cuecard-has-note', pins.length > 0);
        $('#cuecard_pin_box').toggle(pins.length > 0);
        $('#cuecard_pin_list').html(pins.length
            ? pins.map((p, i) => `
                <div class="cuecard-card cuecard-pinned${p.type === 'idea' ? ' idea' : ''}" data-pin="${i}">
                    <div class="cuecard-card-text">${p.type === 'idea' ? '🎬 ' : '💬 '}${escapeHtml(p.text)}</div>
                    <div class="cuecard-tools">
                        <span class="cuecard-tool cuecard-unpin fa-solid fa-xmark" data-pin="${i}" title="보관함에서 빼기"></span>
                    </div>
                </div>`).join('')
            : '<small class="cuecard-empty">쪽지의 📌 압정을 누르면 여기 모여요.</small>');
    }

    // ---------- 전개 쪽지 몰래 반영 (작가 노트처럼) ----------
    function getPending() {
        return ctx().chatMetadata?.[PENDING_KEY] || null;
    }
    // 실리태번 프롬프트에 지시를 붙이거나('' 이면) 떼요.
    // 고르는 순간이 아니라, 본편 답변을 만들기 시작할 때만 붙여요.
    function setDirectionPrompt(text) {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function') return false;
        c.setExtensionPrompt(EXT_PROMPT_KEY,
            text ? `[Story direction for this reply only — weave this in naturally and never mention this note: ${text}]` : '',
            c.extension_prompt_types?.IN_CHAT ?? 1, 1, false, c.extension_prompt_roles?.SYSTEM ?? 0);
        return true;
    }
    // 본편 답변: 일반 전송·재생성·스와이프·이어쓰기. 대사 대신 쓰기(impersonate)·quiet 등은 제외.
    const MAIN_GEN_TYPES = ['normal', 'regenerate', 'swipe', 'continue'];
    function isMainGeneration(type) {
        return !type || MAIN_GEN_TYPES.includes(type);
    }
    function onGenerationStarted(type, _opts, dryRun) {
        const p = getPending();
        if (p && !dryRun && isMainGeneration(type)) {
            setDirectionPrompt(p.text);
            if (!p.armed) { p.armed = true; saveMeta(); }
        } else {
            setDirectionPrompt('');
        }
    }
    function onGenerationEnded() {
        // 지시는 매 생성마다 다시 붙이니까 끝나면 일단 떼요. 쪽지 정리는 MESSAGE_RECEIVED에서 해요.
        setDirectionPrompt('');
    }
    function onGenerationStopped() {
        // 중간에 멈추면 지시만 떼고 쪽지는 다음 답변을 위해 남겨둬요.
        setDirectionPrompt('');
        const p = getPending();
        if (p?.armed) { p.armed = false; saveMeta(); }
    }
    function setPending(text) {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function' || !c.chatMetadata) return false;
        c.chatMetadata[PENDING_KEY] = { text, armed: false };
        saveMeta();
        refreshPending();
        return true;
    }
    function clearPending() {
        const c = ctx();
        if (c.chatMetadata?.[PENDING_KEY]) {
            delete c.chatMetadata[PENDING_KEY];
            saveMeta();
        }
        setDirectionPrompt('');
        refreshPending();
    }
    function resetPendingForChat() {
        // 다른 채팅방 지시가 남지 않게 떼고, 이전 세션에서 '사용 중'으로 남은 표시는 풀어요.
        setDirectionPrompt('');
        const p = getPending();
        if (p?.armed) { p.armed = false; saveMeta(); }
        refreshPending();
    }
    function refreshPending() {
        const p = getPending();
        $('#cuecard_pending').html(p
            ? `<span>🤫 다음 답변에 몰래 반영: ${escapeHtml(p.text)}</span><span class="cuecard-pending-x fa-solid fa-xmark" title="반영 취소"></span>`
            : '').toggle(!!p);
        $('#cuecard_button').toggleClass('cuecard-has-pending', !!p);
    }

    function useNote(type, text) {
        if (type === 'idea' && settings().ideaMode === 'hidden') {
            if (setPending(text)) {
                toastr.success('다음 답변에 몰래 반영할게요. 평소처럼 메시지를 보내세요.', 'Crib Note');
            } else {
                insertText(`(OOC: ${text})`);
                toastr.warning('이 실리태번 버전에선 몰래 반영을 쓸 수 없어서 OOC로 넣었어요.', 'Crib Note');
            }
        } else {
            insertText(type === 'idea' ? `(OOC: ${text})` : text);
        }
        if (settings().autoClose) togglePanel(false);
    }

    // ---------- 캐릭터 요약 ----------
    function currentChar() {
        const c = ctx();
        if (c.groupId || c.characterId === undefined) return null;
        return c.characters?.[c.characterId] || null;
    }
    // {{user}}는 그대로 두고 나머지 매크로만 바꿔요. 페르소나가 바뀌어도 요약을 그대로 쓸 수 있게요.
    function subKeepUser(t) {
        const c = ctx();
        const marked = String(t || '').replace(/\{\{user\}\}|<USER>/gi, '\u0001');
        const out = c.substituteParams ? c.substituteParams(marked) : marked;
        return String(out).replace(/\u0001/g, '{{user}}');
    }
    function charRaw(ch) {
        const sub = subKeepUser;
        const parts = [];
        if (ch.description) parts.push(`Description:\n${sub(ch.description)}`);
        if (ch.personality) parts.push(`Personality:\n${sub(ch.personality)}`);
        if (ch.scenario) parts.push(`Scenario:\n${sub(ch.scenario)}`);
        return parts.join('\n\n');
    }
    function hashStr(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
        return String(h);
    }
    function getSummary(ch) {
        return ch ? settings().charSummaries[ch.avatar] || null : null;
    }
    function setSummary(ch, text, hash) {
        const st = settings();
        if (!ch) return;
        if (text && text.trim()) {
            const old = st.charSummaries[ch.avatar] || {};
            st.charSummaries[ch.avatar] = {
                text,
                hash: hash ?? old.hash ?? hashStr(charRaw(ch)),
                date: hash ? new Date().toISOString() : (old.date || new Date().toISOString()),
                v: hash ? 2 : (old.v ?? (Object.keys(old).length ? undefined : 2)),
            };
        } else {
            delete st.charSummaries[ch.avatar];
        }
        save();
    }

    function refreshCharBox() {
        const ch = currentChar();
        const $st = $('#cuecard_char_status');
        if (!ch) {
            $st.text('그룹 채팅이거나 캐릭터가 선택되지 않았어요.');
            $('#cuecard_char_summary').val('').prop('disabled', true);
            $('#cuecard_char_btn').removeClass('cuecard-has-note');
            return;
        }
        $('#cuecard_char_summary').prop('disabled', false);
        const sum = getSummary(ch);
        $('#cuecard_char_btn').toggleClass('cuecard-has-note', !!sum);
        if (!sum) {
            $st.text(`${ch.name}: 요약 없음 → 지금은 카드 원문을 앞에서부터 잘라서 넣어요.`);
            $('#cuecard_char_summary').val('');
            $('#cuecard_char_make').text('요약 만들기');
            return;
        }
        const legacy = sum.v !== 2;
        const changed = !legacy && sum.hash !== hashStr(charRaw(ch));
        const d = new Date(sum.date);
        const when = isNaN(d) ? '' : ` (${d.getMonth() + 1}/${d.getDate()} 만듦)`;
        const warn = legacy
            ? ' <b class="cuecard-warn">· 이전 버전 요약이라 그때 쓰던 페르소나 이름이 들어 있을 수 있어요. 다시 만드는 걸 추천해요</b>'
            : changed ? ' <b class="cuecard-warn">· 카드가 바뀌었어요. 다시 만드는 걸 추천해요</b>' : '';
        $st.html(`${escapeHtml(ch.name)}: 요약 사용 중${when}${warn}` +
            '<br><small>요약 속 {{user}}는 지금 페르소나 이름으로 바뀌어 들어가요.</small>');
        $('#cuecard_char_summary').val(sum.text);
        $('#cuecard_char_make').text('다시 만들기');
    }

    async function makeSummary() {
        if (summarizing) return;
        if (busy) { toastr.info('쪽지를 쓰는 중이에요. 끝난 뒤 요약을 만들어주세요.', 'Crib Note'); return; }
        const ch = currentChar();
        if (!ch) { toastr.info('캐릭터 채팅방에서 쓸 수 있어요.', 'Crib Note'); return; }
        const raw = charRaw(ch);
        if (!raw.trim()) { toastr.warning('캐릭터 카드에 설명이 비어 있어요.', 'Crib Note'); return; }

        summarizing = true;
        $('#cuecard_char_make').text('요약 중…');
        $('#cuecard_char_status').html('<i class="fa-solid fa-spinner fa-spin"></i> 캐릭터 시트 읽는 중…');
        const messages = [
            { role: 'system', content:
`You condense a roleplay character sheet into a compact reference card.
Keep only what matters for writing believable story continuations:
- identity (name, age/role, a few key appearance traits)
- core personality and how it shows in behavior
- speech style (tone, honorifics, verbal habits, sample phrasing if given)
- relationship to {{user}} and other important people
- key setting/world facts, goals, secrets or conflicts
Drop decoration, repetition and minor trivia. Do not invent anything.
{{user}} is a placeholder for whoever the user plays. Keep it written exactly as {{user}} — never replace it with a name.
Write in the same language as the sheet. Use short bullet points under these headings. Aim for under 1500 characters.
Output only the summary.` },
            { role: 'user', content: `<character name="${ch.name}">\n${clip(raw, 30000)}\n</character>` },
        ];
        try {
            const st = settings();
            // 요약용 토큰 한도는 이번 요청에만 적용해요.
            let out = await requestLLM(messages, { maxTokens: Math.max(st.maxTokens, 2500) });
            out = String(out || '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '').replace(/```\w*/g, '').trim();
            if (!out) throw new Error('빈 응답이 왔어요.');
            if (currentChar()?.avatar === ch.avatar) {
                setSummary(ch, out, hashStr(raw));
                refreshCharBox();
            } else {
                setSummary(ch, out, hashStr(raw));
            }
            toastr.success(`${ch.name} 요약 완료`, 'Crib Note');
        } catch (err) {
            console.error('[Crib Note]', err);
            $('#cuecard_char_status').text(`⚠️ 요약을 만들지 못했어요: ${err?.message || err}`);
        } finally {
            summarizing = false;
            if (!$('#cuecard_char_status').text().startsWith('⚠️')) refreshCharBox();
            else $('#cuecard_char_make').text(getSummary(ch) ? '다시 만들기' : '요약 만들기');
        }
    }

    function cardHtml(type, t, i, used, loading) {
        const u = used[type]?.includes(i) ? ' used' : '';
        const busyCls = loading && loading.type === type && loading.idx === i ? ' loading' : '';
        const pin = isPinned(type, t) ? ' pinned' : '';
        const text = busyCls ? '<i class="fa-solid fa-spinner fa-spin"></i> 고쳐 쓰는 중…' : escapeHtml(t);
        return `<div class="cuecard-card${type === 'idea' ? ' idea' : ''}${u}${busyCls}" data-type="${type}" data-idx="${i}">
            <div class="cuecard-card-text">${text}</div>
            <div class="cuecard-tools">
                <span class="cuecard-tool fa-solid fa-thumbtack${pin}" data-act="pin" title="보관함에 고정"></span>
                <span class="cuecard-tool fa-solid fa-rotate" data-act="again" title="이 쪽지만 다시"></span>
                <span class="cuecard-tool fa-solid fa-scissors" data-act="shorter" title="더 짧게"></span>
                <span class="cuecard-tool fa-solid fa-fire" data-act="bolder" title="더 대담하게"></span>
            </div>
        </div>`;
    }

    function renderResults(data, loading = null) {
        const used = data.used || { reply: [], idea: [] };
        let html = `<div class="cuecard-moodtag">분위기: ${escapeHtml(data.moodLabel || '')}</div>`;
        if (data.replies.length) {
            html += '<div class="cuecard-section">💬 대사 쪽지</div>';
            data.replies.forEach((t, i) => { html += cardHtml('reply', t, i, used, loading); });
        }
        if (data.ideas.length) {
            html += '<div class="cuecard-section">🎬 전개 쪽지</div>';
            data.ideas.forEach((t, i) => { html += cardHtml('idea', t, i, used, loading); });
        }
        if (!data.replies.length && !data.ideas.length) {
            html += '<div class="cuecard-status">쪽지가 번져서 못 읽었어요. 한 장 더 받아볼까요?</div>';
        }
        $('#cuecard_results').html(html);
    }

    function insertText(text) {
        const $ta = $('#send_textarea');
        $ta.val(text).trigger('input');
        $ta[0]?.focus();
    }

    // ---------- 프롬프트 ----------
    function clip(s, n) {
        s = String(s || '').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    // 앞부분 조금 + 끝부분 많이. 마지막 질문·행동이 잘리지 않게요.
    function clipEnds(s, n) {
        s = String(s || '').trim();
        if (s.length <= n) return s;
        const head = Math.floor(n * 0.3);
        return s.slice(0, head) + '\n…(중략)…\n' + s.slice(-(n - head));
    }

    // 별도 표시한 캐릭터 속마음은 추천 API에 보내기 전에 내용까지 제외해요.
    function stripPrivateThoughts(text) {
        const privateName = /^(?:inner[_-]?info|(?:inner|internal|private)[_-]?(?:thoughts?|monologue)|thoughts?)(?:[_-](?:box|panel|content|block|container))?$/i;
        const isPrivate = (name, tag) => {
            if (privateName.test(name)) return true;
            const attributes = tag.matchAll(/\s(?:class|id|data-type)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/gi);
            return Array.from(attributes).some(a => (a[1] ?? a[2] ?? a[3]).split(/\s+/).some(v => privateName.test(v)));
        };
        // div 같은 같은 이름의 태그가 중첩돼도 바깥 속마음 블록 전체를 제외해요.
        const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:.-]*)\b[^>]*>/gi;
        const voidTags = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
        let out = '', cursor = 0;
        const hidden = [];
        for (const match of text.matchAll(tags)) {
            const tag = match[0], name = match[1]?.toLowerCase();
            if (!hidden.length) out += text.slice(cursor, match.index);
            if (name && hidden.length) {
                if (/^<\//.test(tag)) {
                    const depth = hidden.lastIndexOf(name);
                    if (depth >= 0) hidden.length = depth;
                } else if (!voidTags.test(name) && !/\/\s*>$/.test(tag)) hidden.push(name);
            } else if (name && !/^<\//.test(tag) && isPrivate(name, tag)) {
                if (!voidTags.test(name) && !/\/\s*>$/.test(tag)) hidden.push(name);
                out += '\n';
            } else if (!hidden.length) out += tag;
            cursor = match.index + tag.length;
        }
        if (!hidden.length) out += text.slice(cursor);
        return out;
    }

    // 상태창·정보블록 걸러내기. 유저 자신의 속마음은 말투·행동 참고에 남겨요.
    function cleanMessage(text, excludeThoughts = true) {
        let t = String(text || '');
        if (excludeThoughts) t = stripPrivateThoughts(t);
        t = t.replace(/<(think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        t = t.replace(/```[\s\S]*?```/g, '');                                   // 코드블록
        t = t.replace(/<(infoblock|timeline(?:\s+info)?|details|style|script|table|pre|code|statusbar|status|info)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        t = t.replace(/<!--[\s\S]*?-->/g, '');
        t = t.replace(/<[^>]+>/g, '');                                            // 남은 태그
        t = t.split('\n').filter(line => {
            const l = line.trim();
            if (!l) return true;
            const label = l.replace(/^(?:>\s*|[-+]\s+)*/, '').replace(/[*_`]/g, '');
            const thoughtLine = /^💭/u.test(label) || /^(?:\[\s*(?:속마음|내면\s*독백|inner\s*thoughts?|private\s*thoughts?)\s*\]|(?:속마음|속생각|내면(?:의)?\s*(?:생각|독백)|마음속(?:의)?\s*생각|(?:inner|private|internal)?[\s-]*thoughts?)\s*[:：])/i.test(label);
            if (thoughtLine) return !excludeThoughts;
            if (/^[|┃│╔╗╚╝═─━┌┐└┘├┤]/.test(l)) return false;                    // 표·박스 줄
            if (/^\[[^\]]{0,80}\]$/.test(l)) return false;                       // [날짜: …] 같은 한 줄 태그
            if (/^[^\w가-힣"'*「『(“‘]{1,3}\s*[^:：]{1,15}[:：]/.test(l) && l.length < 80) return false; // 📍장소: … 📅날짜: …
            return true;
        }).join('\n');
        return t.replace(/\n{3,}/g, '\n\n').trim();
    }

    function cleanSuggestion(text) {
        return String(text || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/<[^>]+>/g, '')
            .trim();
    }

    function pickMood() {
        const st = settings();
        const moods = allMoods();
        if (st.lastMood !== 'random') return moods.find(m => m.id === st.lastMood) || MOODS[0];
        const pool = moods.filter(m => st.randomMoods.includes(m.id));
        const list = pool.length ? pool : MOODS;
        return list[Math.floor(Math.random() * list.length)];
    }

    function moodText(mood) {
        if (MOODS.some(m => m.id === mood.id)) return mood.desc;
        return mood.desc ? `${mood.label} — ${mood.desc}` : mood.label;
    }

    function buildMessages(mood, direction, opts = {}) {
        const c = ctx();
        const st = settings();
        const counts = opts.counts || { replyCount: st.replyCount, ideaCount: st.ideaCount };
        const sub = (t) => (c.substituteParams ? c.substituteParams(t) : t);
        const userName = c.name1 || 'User';
        const charName = c.name2 || 'Character';

        const blocks = [];

        const summary = st.useCharacter ? getSummary(currentChar()) : null;
        if (summary) {
            blocks.push(`<character name="${currentChar().name}">\n${sub(summary.text)}\n</character>`);
        } else if (st.useCharacter && !c.groupId && c.characterId !== undefined && c.characters?.[c.characterId]) {
            const ch = c.characters[c.characterId];
            const parts = [];
            if (ch.description) parts.push(`Description: ${clip(sub(ch.description), 3000)}`);
            if (ch.personality) parts.push(`Personality: ${clip(sub(ch.personality), 1000)}`);
            if (ch.scenario) parts.push(`Scenario: ${clip(sub(ch.scenario), 1000)}`);
            if (parts.length) blocks.push(`<character name="${ch.name}">\n${parts.join('\n')}\n</character>`);
        }

        if (st.usePersona) {
            const persona = c.powerUserSettings?.persona_description;
            if (persona && persona.trim()) {
                blocks.push(`<persona name="${userName}">\n${clip(sub(persona), 2000)}\n</persona>`);
            }
        }

        const note = getNote();
        if (note.trim()) {
            blocks.push(`<user_note about="${userName}">\n${clip(note, 1000)}\n</user_note>`);
        }

        const prep = (m) => cleanMessage(m.mes, !m.is_user);
        const visible = (c.chat || []).filter(m => !m.is_system && m.mes);
        const recent = visible.slice(-st.contextMessages);
        const chat = recent
            .map((m, i) => `${m.name}: ${clipEnds(prep(m), i === recent.length - 1 ? 6000 : 2500)}`)
            .join('\n\n');
        blocks.push(`<recent_chat>\n${chat || '(no messages yet)'}\n</recent_chat>`);

        // 유저가 실제로 쓴 최근 메시지 = 말투 참고용
        const userSamples = visible.filter(m => m.is_user).slice(-2)
            .map(m => clip(prep(m), 800)).filter(Boolean);
        if (userSamples.length) {
            blocks.push(`<user_style_reference>\n${userSamples.join('\n---\n')}\n</user_style_reference>`);
        }

        const langName = (v) => v === 'ko' ? 'Korean' : v === 'en' ? 'English' : 'the same language as the recent chat';
        const replyLang = langName(st.language);
        const ideaLang = langName(st.ideaLanguage);

        const lengthRule = {
            short: 'Keep each one very short: 1-2 brief sentences.',
            long: 'Make each one richer: about 4-7 sentences with more action, feeling and detail.',
        }[st.lastLength] || 'Keep each 1-4 sentences.';
        const formRule = {
            dialogue: `Write ONLY spoken lines of ${userName} — no narration, no action descriptions.`,
            action: `Write ONLY ${userName}'s actions, gestures and expressions as narration — no spoken dialogue at all.`,
        }[st.lastForm] || `Mix dialogue and actions freely.`;

        const tasks = [];
        if (counts.replyCount > 0) {
            tasks.push(`- "replies": exactly ${counts.replyCount} different candidate messages that ${userName} could send next. ` +
                `Write ONLY ${userName}'s own dialogue and actions, in ${userName}'s voice and personality. ` +
                `Never decide ${charName}'s reactions or other characters' actions. ` +
                `Match the formatting style of the recent chat (quotes for speech, asterisks for actions, etc.). ` +
                `${formRule} ` +
                `Make each candidate meaningfully different in approach. ${lengthRule} ` +
                `Write the replies in ${replyLang}.`);
        }
        if (counts.ideaCount > 0) {
            tasks.push(`- "ideas": exactly ${counts.ideaCount} short story-development ideas (one sentence each) for what could happen next ` +
                `— an event, a new arrival, a change in the environment, a discovery, etc. ` +
                `Write them as neutral director's notes, not as dialogue. Write the ideas in ${ideaLang}.`);
        }

        const system =
`You are a creative assistant helping a user continue an ongoing roleplay story.
The user plays ${userName}. The AI plays ${charName}${c.groupId ? ' and others' : ''}.
Read the context and suggest how the story could continue from the latest message.

Produce:
${tasks.join('\n')}

Desired mood: ${moodText(mood)}.${direction ? `\nAdditional request from the user: ${direction}` : ''}${opts.rewrite ? `\n${opts.rewrite}` : ''}
Stay consistent with established facts, characters and setting. Do not repeat things that already happened.
For "replies", follow ${userName}'s own writing style shown in <user_style_reference> if present.
Base ${userName}'s replies on dialogue and events they could perceive. Never treat another character's private thoughts, unspoken intentions or secrets as something ${userName} heard or knows.
The chat may contain status windows, info boxes, dates/locations headers, trackers, HTML or code blocks. These are UI decorations — NEVER imitate or include them. Write only plain story text.
Follow the language specified for each list exactly, even if the chat is in another language.

Output ONLY valid JSON, no explanations, no code fences:
{"replies": ["..."], "ideas": ["..."]}`;

        return [
            { role: 'system', content: system },
            { role: 'user', content: blocks.join('\n\n') + '\n\nNow output the JSON.' },
        ];
    }

    // ---------- 요청 & 파싱 ----------
    async function requestLLM(messages, options = {}) {
        const c = ctx();
        const st = settings();
        const profileId = options.profileId ?? st.profileId;
        const maxTokens = options.maxTokens ?? st.maxTokens;
        const signal = options.signal;
        signal?.throwIfAborted();
        const content = res => typeof res === 'string' ? res : (res?.content ?? '');

        if (profileId) {
            const svc = c.ConnectionManagerRequestService;
            if (!svc) throw new Error('이 실리태번 버전에선 연결 프로필 요청을 쓸 수 없어요.');
            const res = await svc.sendRequest(profileId, messages, maxTokens, {
                stream: false,
                signal,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            });
            return content(res);
        }

        // 현재 연결도 전용 요청으로 보내요. 전역 stopGeneration()은 본편 RP까지 중단해요.
        const cc = c.ChatCompletionService;
        if (c.mainApi === 'openai' && cc?.presetToGeneratePayload && cc?.sendRequest) {
            const payload = await cc.presetToGeneratePayload({}, {}, {
                stream: false,
                messages,
                max_tokens: maxTokens,
                model: c.getChatCompletionModel(),
                chat_completion_source: c.chatCompletionSettings.chat_completion_source,
            });
            signal?.throwIfAborted();
            return content(await cc.sendRequest(payload, true, signal));
        }

        const tc = c.TextCompletionService;
        if (c.mainApi === 'textgenerationwebui' && tc?.presetToGeneratePayload && tc?.sendRequest && tc?.constructPrompt) {
            const instruct = c.powerUserSettings?.instruct;
            const prompt = instruct?.enabled
                ? tc.constructPrompt(messages, instruct)
                : messages.map(m => m.content).join('\n\n');
            const payload = await tc.presetToGeneratePayload({}, {}, {
                stream: false, prompt, max_tokens: maxTokens, max_new_tokens: maxTokens,
            });
            // API마다 길이 필드 이름이 달라요 (KoboldCpp max_length, llama.cpp n_predict, Ollama num_predict).
            // 이미 들어 있는 필드만 같은 값으로 맞춰요. 없는 필드를 새로 넣지는 않아요.
            const LENGTH_KEYS = ['max_tokens', 'max_new_tokens', 'max_length', 'n_predict', 'num_predict'];
            for (const target of [payload, payload?.options]) {
                if (!target || typeof target !== 'object') continue;
                for (const k of LENGTH_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(target, k)) target[k] = maxTokens;
                }
            }
            signal?.throwIfAborted();
            return content(await tc.sendRequest(payload, true, signal));
        }

        // 구형/기타 API의 generateRaw는 개별 AbortSignal을 지원하지 않아요.
        // 이 경우 결과만 취소하고 요청이 끝나기 전 재요청을 막아요.
        options.onCancelMode?.('result');
        const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
        const prompt = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
        const result = await c.generateRaw({ systemPrompt, prompt, responseLength: maxTokens });
        signal?.throwIfAborted();
        return result;
    }

    function toList(v) {
        if (!Array.isArray(v)) return [];
        return v.map(x => typeof x === 'string' ? x : (typeof x?.text === 'string' ? x.text : ''))
            .map(x => x.trim()).filter(Boolean);
    }

    function parseResult(raw, counts = settings()) {
        let text = String(raw || '')
            .replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '')
            .replace(/```(json)?/gi, '')
            .trim();

        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const j = JSON.parse(m[0]);
                if (!j || Array.isArray(j)
                    || (counts.replyCount > 0 && !Array.isArray(j.replies))
                    || (counts.ideaCount > 0 && !Array.isArray(j.ideas))) throw new Error('Invalid result shape');
                const data = {
                    replies: toList(j.replies).map(cleanSuggestion).filter(Boolean).slice(0, counts.replyCount),
                    ideas: toList(j.ideas).map(cleanSuggestion).filter(Boolean).slice(0, counts.ideaCount),
                };
                if (data.replies.length || data.ideas.length) return data;
            } catch { /* 아래로 */ }
        }

        throw new Error('응답이 잘렸거나 카드 형식을 읽지 못했어요. 최대 응답 토큰을 늘리거나 추천 개수를 줄여 다시 시도해주세요.');
    }

    function setGoButton(state) {
        const $b = $('#cuecard_go');
        if (state === 'busy') $b.addClass('cuecard-cancel').text('취소');
        else $b.removeClass('cuecard-cancel').text(state === 'again' ? '한 장 더' : '쪽지 받기');
    }

    function cancel() {
        if (!busy || abortCtl?.signal.aborted) return;
        runId++;                       // 진행 중 결과는 무시
        try { abortCtl?.abort(); } catch { /* 무시 */ }
        $('#cuecard_go').text('취소 중…');
        setStatus(cancelMode === 'result'
            ? '결과를 취소했어요. 이 API는 개별 중단을 지원하지 않아 요청이 끝날 때까지 기다려요.'
            : '요청을 중단하는 중…');
    }

    const REWRITES = {
        again: (t) => `Write ONE fresh alternative that takes a clearly different approach from this one: "${t}"`,
        shorter: (t) => `Rewrite this ONE suggestion as a noticeably shorter, punchier version that keeps its intent: "${t}"`,
        bolder: (t) => `Rewrite this ONE suggestion to be bolder and more daring or dramatic, while staying in character: "${t}"`,
    };

    async function generate(single = null) {
        if (busy) { if (!single) cancel(); return; }
        if (summarizing) { toastr.info('캐릭터 요약이 끝난 뒤 다시 눌러주세요.', 'Crib Note'); return; }
        const c = ctx();
        if (!c.chat || !c.chat.length) {
            toastr.info('먼저 채팅방을 열어주세요.', 'Crib Note');
            return;
        }
        const st = settings();
        let base = null;
        if (single) {
            base = loadStored();
            if (!base) { showStored(); return; }
        } else if (st.replyCount <= 0 && st.ideaCount <= 0) {
            toastr.warning('설정에서 답변 후보나 전개 아이디어 개수를 1 이상으로 해주세요.', 'Crib Note');
            return;
        }

        busy = true;
        const myRun = ++runId;
        const controller = new AbortController();
        abortCtl = controller;
        cancelMode = 'request';
        const sourceTurn = currentTurnKey();
        const sourceMetadata = c.chatMetadata;
        const counts = single
            ? { replyCount: single.type === 'reply' ? 1 : 0, ideaCount: single.type === 'idea' ? 1 : 0 }
            : { replyCount: st.replyCount, ideaCount: st.ideaCount };
        setGoButton('busy');
        const mood = (single && allMoods().find(m => m.id === base.moodId)) || pickMood();
        const moodLabel = single ? base.moodLabel : (st.lastMood === 'random' ? `🎲 → ${mood.label}` : mood.label);
        if (single) renderResults(base, single);
        else setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> 몰래 쪽지 쓰는 중… (${escapeHtml(moodLabel)})`);

        try {
            const direction = String($('#cuecard_direction').val() || '').trim();
            const rewrite = single ? (REWRITES[single.variant] || REWRITES.again)(single.oldText) : '';
            const messages = buildMessages(mood, direction, { counts, rewrite });
            lastSent = { messages, moodLabel, profile: st.profileId, time: new Date() };
            const raw = await requestLLM(messages, {
                signal: controller.signal,
                maxTokens: st.maxTokens,
                profileId: st.profileId,
                onCancelMode: mode => { cancelMode = mode; },
            });
            if (myRun !== runId) return;   // 취소됨
            if (sourceMetadata !== ctx().chatMetadata || sourceTurn !== currentTurnKey()) {
                cancel();
                return;
            }
            const parsed = parseResult(raw, counts);
            if (single) {
                const cur = loadStored();
                if (!cur) { showStored(); return; }
                const list = single.type === 'idea' ? cur.ideas : cur.replies;
                const fresh = (single.type === 'idea' ? parsed.ideas : parsed.replies)[0];
                if (fresh && list[single.idx] !== undefined) {
                    list[single.idx] = fresh;
                    cur.used[single.type] = (cur.used[single.type] || []).filter(i => i !== single.idx);
                    storeResult(cur);
                }
                renderResults(cur);
                return;
            }
            const data = { ...parsed, moodLabel, moodId: mood.id, turnKey: sourceTurn, used: { reply: [], idea: [] } };
            storeResult(data);
            renderResults(data);
        } catch (err) {
            if (myRun !== runId) return;
            console.error('[Crib Note]', err);
            if (single) {
                const cur = loadStored();
                if (cur) renderResults(cur); else showStored();
                toastr.warning(`쪽지를 고쳐 쓰지 못했어요: ${err?.message || err}`, 'Crib Note');
            } else {
                setStatus(`⚠️ 추천을 만들지 못했어요: ${escapeHtml(err?.message || err)}`);
            }
        } finally {
            if (abortCtl === controller) {
                busy = false;
                abortCtl = null;
                setGoButton('again');
                if (controller.signal.aborted && myRun !== runId) showStored();
            }
        }
    }

    // ---------- 프롬프트 보기 ----------
    function showPrompt() {
        let info = lastSent;
        let note = '';
        if (!info) {
            const c = ctx();
            if (!c.chat || !c.chat.length) {
                toastr.info('아직 보낸 프롬프트가 없어요. 채팅방에서 쪽지를 한 번 받아보세요.', 'Crib Note');
                return;
            }
            const mood = pickMood();
            info = { messages: buildMessages(mood, String($('#cuecard_direction').val() || '').trim()), moodLabel: mood.label };
            note = '(아직 보낸 게 없어서, 지금 뽑으면 보낼 내용을 미리 보여줘요)\n\n';
        }
        const profName = info.profile
            ? (getProfiles().find(p => p.id === info.profile)?.name || info.profile)
            : '현재 연결';
        const body = note + `연결: ${profName} / 분위기: ${info.moodLabel}\n\n` +
            info.messages.map(m => `===== ${m.role.toUpperCase()} =====\n${m.content}`).join('\n\n');
        const html = `<div class="cuecard-prompt-view"><b class="cuecard-title"><span class="cuecard-title-icon">${ICON_SVG}</span>Crib Note 프롬프트</b><pre>${escapeHtml(body)}</pre></div>`;
        const c = ctx();
        if (c.callGenericPopup && c.POPUP_TYPE) {
            c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
        } else {
            alert(body);
        }
    }

    function showStored() {
        const stored = loadStored();
        if (stored && (stored.replies?.length || stored.ideas?.length)) {
            renderResults(stored);
            setGoButton('again');
        } else {
            $('#cuecard_results').empty();
            setGoButton('idle');
        }
    }

    // ---------- 시작 ----------
    function init() {
        settings();

        $('#extensions_settings2').append(buildSettingsHtml());
        bindSettings();

        $('#send_form').before(buildPanel());
        renderMoodChips();
        refreshCycleChips();
        const icon = `<div id="cuecard_button" class="interactable" title="Crib Note: 몰래 쪽지 받기" tabindex="0">
            ${ICON_SVG}
        </div>`;
        if ($('#send_but').length) $('#send_but').before(icon);
        else $('#rightSendForm').prepend(icon);

        $('#cuecard_button').on('click', () => togglePanel());
        $('#cuecard_close').on('click', () => togglePanel(false));
        if (typeof document !== 'undefined') $(document).on('pointerdown', (e) => {
            if (!settings().closeOnOutside || !$('#cuecard_panel').is(':visible')) return;
            // 패널·버튼·팝업·알림 안을 누른 건 무시
            if ($(e.target).closest('#cuecard_panel, #cuecard_button, .popup, dialog, #toast-container, .toast').length) return;
            togglePanel(false);
        });
        $('#cuecard_view_prompt').on('click', showPrompt);
        $('#cuecard_note_btn').on('click', () => {
            if (!ctx().chatMetadata || !ctx().chat?.length) {
                toastr.info('먼저 채팅방을 열어주세요.', 'Crib Note');
                return;
            }
            refreshNote();
            $('#cuecard_char_box').hide();
            $('#cuecard_pin_box').hide();
            $('#cuecard_note_box').toggle();
            scrollPanelTop();
        });
        $('#cuecard_char_btn').on('click', () => {
            refreshCharBox();
            $('#cuecard_note_box').hide();
            $('#cuecard_pin_box').hide();
            $('#cuecard_char_box').toggle();
            scrollPanelTop();
        });
        $('#cuecard_pin_btn').on('click', () => {
            const show = !$('#cuecard_pin_box').is(':visible');
            refreshPins();
            $('#cuecard_note_box').hide();
            $('#cuecard_char_box').hide();
            $('#cuecard_pin_box').toggle(show);
            scrollPanelTop();
        });
        $('#cuecard_char_make').on('click', makeSummary);
        $('#cuecard_char_clear').on('click', () => {
            const ch = currentChar();
            if (!ch || !getSummary(ch)) return;
            if (!confirm(`${ch.name}의 요약을 지울까요?`)) return;
            setSummary(ch, '');
            refreshCharBox();
        });
        $('#cuecard_char_summary').on('input', function () {
            const ch = currentChar();
            if (ch) setSummary(ch, $(this).val());
            $('#cuecard_char_btn').toggleClass('cuecard-has-note', !!String($(this).val()).trim());
        });
        $('#cuecard_note').on('input', function () {
            setNote($(this).val());
            $('#cuecard_note_btn').toggleClass('cuecard-has-note', !!String($(this).val()).trim());
        });
        $('#cuecard_go').on('click', () => generate());
        $('#cuecard_direction').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); generate(); } });

        $('#cuecard_panel').on('click', '.cuecard-cycle', function () {
            cycleSetting(String($(this).data('key')));
        });
        $('#cuecard_panel').on('click', '.cuecard-pending-x', () => clearPending());

        // 쪽지 도구: 고정 / 다시 / 짧게 / 대담하게
        $('#cuecard_panel').on('click', '.cuecard-tool[data-act]', function (e) {
            e.stopPropagation();
            const $card = $(this).closest('.cuecard-card');
            const type = $card.data('type');
            const idx = Number($card.data('idx'));
            const act = String($(this).data('act'));
            const stored = loadStored();
            if (!stored) { showStored(); return; }
            const text = (type === 'idea' ? stored.ideas : stored.replies)?.[idx];
            if (typeof text !== 'string') return;
            if (act === 'pin') { togglePin(type, text); return; }
            if (busy) { toastr.info('지금 쪽지를 쓰는 중이에요. 끝난 뒤 다시 눌러주세요.', 'Crib Note'); return; }
            generate({ type, idx, variant: act, oldText: text });
        });

        // 보관함
        $('#cuecard_panel').on('click', '.cuecard-unpin', function (e) {
            e.stopPropagation();
            removePin(Number($(this).data('pin')));
        });
        $('#cuecard_panel').on('click', '.cuecard-pinned', function () {
            const p = getPins()[Number($(this).data('pin'))];
            if (p) useNote(p.type, p.text);
            else refreshPins();
        });

        $('#cuecard_panel').on('click', '.cuecard-chip[data-mood]', function () {
            settings().lastMood = $(this).data('mood');
            save();
            refreshChips();
        });

        $('#cuecard_panel').on('click', '.cuecard-card', function () {
            if ($(this).data('pin') !== undefined) return;   // 보관함 쪽지는 따로 처리
            const stored = loadStored();
            if (!stored) { showStored(); return; }
            const type = $(this).data('type');
            const idx = Number($(this).data('idx'));
            const text = (type === 'idea' ? stored.ideas : stored.replies)?.[idx];
            if (typeof text !== 'string') return;
            useNote(type, text);
            $(this).addClass('used');
            if (stored.used?.[type] && !stored.used[type].includes(idx)) {
                stored.used[type].push(idx);
                storeResult(stored);
            }
        });

        const c = ctx();
        for (const name of ['CONNECTION_PROFILE_LOADED', 'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'SETTINGS_LOADED']) {
            if (c.event_types[name]) c.eventSource.on(c.event_types[name], fillProfileSelect);
        }
        for (const name of ['MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
            if (c.event_types[name]) c.eventSource.on(c.event_types[name], expireResults);
        }
        if (c.event_types.MESSAGE_SWIPED) c.eventSource.on(c.event_types.MESSAGE_SWIPED, onSwipeChanged);
        if (c.event_types.MESSAGE_RECEIVED) c.eventSource.on(c.event_types.MESSAGE_RECEIVED, (messageId, type) => {
            if (type === 'swipe') onSwipeChanged(messageId);
            else expireResults();
        });
        // 몰래 반영: 본편 답변 생성 때만 지시를 붙이고, 답이 오면 정리
        if (c.event_types.GENERATION_STARTED) c.eventSource.on(c.event_types.GENERATION_STARTED, onGenerationStarted);
        if (c.event_types.MESSAGE_RECEIVED) c.eventSource.on(c.event_types.MESSAGE_RECEIVED, () => {
            if (getPending()?.armed) clearPending();
        });
        if (c.event_types.GENERATION_ENDED) c.eventSource.on(c.event_types.GENERATION_ENDED, onGenerationEnded);
        if (c.event_types.GENERATION_STOPPED) c.eventSource.on(c.event_types.GENERATION_STOPPED, onGenerationStopped);
        c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
            if (busy) cancel();
            lastSent = null;
            $('#cuecard_direction').val('');
            $('#cuecard_note_box').hide();
            $('#cuecard_char_box').hide();
            $('#cuecard_pin_box').hide();
            refreshNote();
            refreshCharBox();
            refreshPins();
            resetPendingForChat();
            showStored();
            if (busy) $('#cuecard_go').addClass('cuecard-cancel').text('취소 중…');
        });
        refreshNote();
        refreshCharBox();
        refreshPins();
        resetPendingForChat();
        showStored();

        console.log('[Crib Note] loaded');
    }

    jQuery(() => init());
})();


