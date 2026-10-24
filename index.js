// Crib Note v0.8.1 — 이야기 맥락을 읽고 답변 후보 + 전개 아이디어를 추천하는 실리태번 확장
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
    };

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
        const moodChecks = MOODS.map(m => `
            <label class="checkbox_label">
                <input type="checkbox" class="cuecard_randmood" value="${m.id}"> ${m.label}
            </label>`).join('');

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

                    <label class="checkbox_label"><input id="cuecard_use_persona" type="checkbox"> 페르소나 설명 참고</label>
                    <label class="checkbox_label"><input id="cuecard_auto_close" type="checkbox"> 추천을 고르면 패널 자동으로 닫기</label>
                    <label class="checkbox_label"><input id="cuecard_close_outside" type="checkbox"> 패널 바깥을 누르면 닫기</label>
                    <label class="checkbox_label"><input id="cuecard_use_character" type="checkbox"> 캐릭터 카드 참고</label>
                    <small>📇 캐릭터 요약을 만들어두면 카드 원문 대신 요약을 써요. 추천 패널의 카드 버튼에서 만들 수 있어요.</small>

                    <small>📝 내 캐릭터 메모는 채팅방마다 따로 적어요. 추천 패널의 연필 버튼을 눌러보세요.</small>

                    <label>🎲 랜덤에 포함할 분위기</label>
                    <div class="cuecard-moodchecks">${moodChecks}</div>

                    <div id="cuecard_view_prompt_s" class="menu_button">👁 보낸 프롬프트 보기</div>
                  </div>
                </div>
            </div>
        </div>`;
    }

    function bindSettings() {
        const st = settings();

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

        $('#cuecard_language').val(st.language).on('change', function () { st.language = $(this).val(); save(); refreshLangChip(); });
        $('#cuecard_idea_language').val(st.ideaLanguage).on('change', function () { st.ideaLanguage = $(this).val(); save(); });
        $('#cuecard_use_persona').prop('checked', st.usePersona).on('change', function () { st.usePersona = this.checked; save(); });
        $('#cuecard_use_character').prop('checked', st.useCharacter).on('change', function () { st.useCharacter = this.checked; save(); });
        $('#cuecard_auto_close').prop('checked', st.autoClose).on('change', function () { st.autoClose = this.checked; save(); });
        $('#cuecard_close_outside').prop('checked', st.closeOnOutside).on('change', function () { st.closeOnOutside = this.checked; save(); });
        $('#cuecard_view_prompt_s').on('click', showPrompt);

        $('.cuecard_randmood').each(function () {
            $(this).prop('checked', st.randomMoods.includes(this.value));
        }).on('change', () => {
            st.randomMoods = $('.cuecard_randmood:checked').map((_, el) => el.value).get();
            save();
        });
    }

    // ---------- 패널 UI ----------
    function buildPanel() {
        const chips = MOODS.map(m =>
            `<div class="cuecard-chip" data-mood="${m.id}">${m.label}</div>`).join('');
        return `
        <div id="cuecard_panel" style="display:none">
          <div class="cuecard-frame">
           <div class="cuecard-head">
            <div class="cuecard-moods">
                ${chips}
                <div class="cuecard-chip" data-mood="random">🎲 랜덤</div>
                <div id="cuecard_lang_chip" class="cuecard-chip cuecard-lang" title="답변 후보 언어 바꾸기"></div>
            </div>
            <div class="cuecard-actions">
                <input id="cuecard_direction" class="text_pole" type="text"
                    placeholder="추가 요청 (선택) 예: 탈출하는 쪽으로">
                <div id="cuecard_go" class="menu_button">쪽지 받기</div>
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

    const LANG_LABEL = { ko: '답변: 한글', en: '답변: EN', auto: '답변: 대화 따라' };
    function refreshLangChip() {
        $('#cuecard_lang_chip').text(LANG_LABEL[settings().language] || LANG_LABEL.ko);
    }

    function togglePanel(force) {
        const $p = $('#cuecard_panel');
        const show = force ?? !$p.is(':visible');
        $p.toggle(show);
        if (show) { refreshChips(); refreshLangChip(); if (!busy) showStored(); }
    }

    function setStatus(html) { $('#cuecard_results').html(`<div class="cuecard-status">${html}</div>`); }

    // 같은 턴에서는 유지하되 다음 메시지/스와이프에서는 만료해요.
    function currentTurnKey() {
        const chat = ctx().chat || [];
        const last = chat[chat.length - 1];
        return JSON.stringify([
            chat.length, last?.send_date ?? null, last?.name ?? '',
            !!last?.is_user, last?.swipe_id ?? null, hashStr(String(last?.mes || '')),
        ]);
    }

    function loadStored() {
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
        c.chatMetadata[MODULE] = data;
        (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
    }

    function expireResults() {
        if (busy) cancel();
        const c = ctx();
        if (c.chatMetadata?.[MODULE]) {
            delete c.chatMetadata[MODULE];
            (c.saveMetadataDebounced || c.saveMetadata)?.call(c);
        }
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

    // ---------- 캐릭터 요약 ----------
    function currentChar() {
        const c = ctx();
        if (c.groupId || c.characterId === undefined) return null;
        return c.characters?.[c.characterId] || null;
    }
    function charRaw(ch) {
        const c = ctx();
        const sub = (t) => (c.substituteParams ? c.substituteParams(t) : t);
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
        const changed = sum.hash !== hashStr(charRaw(ch));
        const d = new Date(sum.date);
        const when = isNaN(d) ? '' : ` (${d.getMonth() + 1}/${d.getDate()} 만듦)`;
        $st.html(`${escapeHtml(ch.name)}: 요약 사용 중${when}` +
            (changed ? ' <b class="cuecard-warn">· 카드가 바뀌었어요. 다시 만드는 걸 추천해요</b>' : ''));
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
        const userName = ctx().name1 || 'User';
        const messages = [
            { role: 'system', content:
`You condense a roleplay character sheet into a compact reference card.
Keep only what matters for writing believable story continuations:
- identity (name, age/role, a few key appearance traits)
- core personality and how it shows in behavior
- speech style (tone, honorifics, verbal habits, sample phrasing if given)
- relationship to ${userName} and other important people
- key setting/world facts, goals, secrets or conflicts
Drop decoration, repetition and minor trivia. Do not invent anything.
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

    function renderResults(data) {
        const used = data.used || { reply: [], idea: [] };
        let html = `<div class="cuecard-moodtag">분위기: ${escapeHtml(data.moodLabel || '')}</div>`;
        if (data.replies.length) {
            html += '<div class="cuecard-section">💬 대사 쪽지</div>';
            data.replies.forEach((t, i) => {
                const u = used.reply.includes(i) ? ' used' : '';
                html += `<div class="cuecard-card${u}" data-type="reply" data-idx="${i}" data-text="${escapeHtml(t)}">${escapeHtml(t)}</div>`;
            });
        }
        if (data.ideas.length) {
            html += '<div class="cuecard-section">🎬 전개 쪽지</div>';
            data.ideas.forEach((t, i) => {
                const u = used.idea.includes(i) ? ' used' : '';
                html += `<div class="cuecard-card idea${u}" data-type="idea" data-idx="${i}" data-text="${escapeHtml(t)}">${escapeHtml(t)}</div>`;
            });
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

    // 상태창·정보블록 걸러내기
    function cleanMessage(text) {
        let t = String(text || '');
        t = t.replace(/<(think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        t = t.replace(/```[\s\S]*?```/g, '');                                   // 코드블록
        t = t.replace(/<(infoblock|inner_info|timeline(?:\s+info)?|details|style|script|table|pre|code|statusbar|status|info)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        t = t.replace(/<!--[\s\S]*?-->/g, '');
        t = t.replace(/<[^>]+>/g, '');                                            // 남은 태그
        t = t.split('\n').filter(line => {
            const l = line.trim();
            if (!l) return true;
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
        if (st.lastMood !== 'random') return MOODS.find(m => m.id === st.lastMood) || MOODS[0];
        const pool = MOODS.filter(m => st.randomMoods.includes(m.id));
        const list = pool.length ? pool : MOODS;
        return list[Math.floor(Math.random() * list.length)];
    }

    function buildMessages(mood, direction) {
        const c = ctx();
        const st = settings();
        const sub = (t) => (c.substituteParams ? c.substituteParams(t) : t);
        const userName = c.name1 || 'User';
        const charName = c.name2 || 'Character';

        const blocks = [];

        const summary = st.useCharacter ? getSummary(currentChar()) : null;
        if (summary) {
            blocks.push(`<character name="${currentChar().name}">\n${summary.text}\n</character>`);
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

        const prep = (mes) => cleanMessage(mes);
        const visible = (c.chat || []).filter(m => !m.is_system && m.mes);
        const chat = visible
            .slice(-st.contextMessages)
            .map(m => `${m.name}: ${clip(prep(m.mes), 2500)}`)
            .join('\n\n');
        blocks.push(`<recent_chat>\n${chat || '(no messages yet)'}\n</recent_chat>`);

        // 유저가 실제로 쓴 최근 메시지 = 말투 참고용
        const userSamples = visible.filter(m => m.is_user).slice(-2)
            .map(m => clip(prep(m.mes), 800)).filter(Boolean);
        if (userSamples.length) {
            blocks.push(`<user_style_reference>\n${userSamples.join('\n---\n')}\n</user_style_reference>`);
        }

        const langName = (v) => v === 'ko' ? 'Korean' : v === 'en' ? 'English' : 'the same language as the recent chat';
        const replyLang = langName(st.language);
        const ideaLang = langName(st.ideaLanguage);

        const tasks = [];
        if (st.replyCount > 0) {
            tasks.push(`- "replies": exactly ${st.replyCount} different candidate messages that ${userName} could send next. ` +
                `Write ONLY ${userName}'s own dialogue and actions, in ${userName}'s voice and personality. ` +
                `Never decide ${charName}'s reactions or other characters' actions. ` +
                `Match the formatting style of the recent chat (quotes for speech, asterisks for actions, etc.). ` +
                `Make each candidate meaningfully different in approach. Keep each 1-4 sentences. ` +
                `Write the replies in ${replyLang}.`);
        }
        if (st.ideaCount > 0) {
            tasks.push(`- "ideas": exactly ${st.ideaCount} short story-development ideas (one sentence each) for what could happen next ` +
                `— an event, a new arrival, a change in the environment, a discovery, etc. ` +
                `Write them as neutral director's notes, not as dialogue. Write the ideas in ${ideaLang}.`);
        }

        const system =
`You are a creative assistant helping a user continue an ongoing roleplay story.
The user plays ${userName}. The AI plays ${charName}${c.groupId ? ' and others' : ''}.
Read the context and suggest how the story could continue from the latest message.

Produce:
${tasks.join('\n')}

Desired mood: ${mood.desc}.${direction ? `\nAdditional request from the user: ${direction}` : ''}
Stay consistent with established facts, characters and setting. Do not repeat things that already happened.
For "replies", follow ${userName}'s own writing style shown in <user_style_reference> if present.
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
            const payload = tc.presetToGeneratePayload({}, {}, {
                stream: false, prompt, max_tokens: maxTokens, max_new_tokens: maxTokens,
            });
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

    async function generate() {
        if (busy) { cancel(); return; }
        if (summarizing) { toastr.info('캐릭터 요약이 끝난 뒤 다시 눌러주세요.', 'Crib Note'); return; }
        const c = ctx();
        if (!c.chat || !c.chat.length) {
            toastr.info('먼저 채팅방을 열어주세요.', 'Crib Note');
            return;
        }
        const st = settings();
        if (st.replyCount <= 0 && st.ideaCount <= 0) {
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
        const counts = { replyCount: st.replyCount, ideaCount: st.ideaCount };
        setGoButton('busy');
        const mood = pickMood();
        const moodLabel = st.lastMood === 'random' ? `🎲 → ${mood.label}` : mood.label;
        setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> 몰래 쪽지 쓰는 중… (${escapeHtml(moodLabel)})`);

        try {
            const direction = String($('#cuecard_direction').val() || '').trim();
            const messages = buildMessages(mood, direction);
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
            const data = { ...parseResult(raw, counts), moodLabel, turnKey: sourceTurn, used: { reply: [], idea: [] } };
            storeResult(data);
            renderResults(data);
        } catch (err) {
            if (myRun !== runId) return;
            console.error('[Crib Note]', err);
            setStatus(`⚠️ 추천을 만들지 못했어요: ${escapeHtml(err?.message || err)}`);
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
            $('#cuecard_note_box').toggle();
        });
        $('#cuecard_char_btn').on('click', () => {
            refreshCharBox();
            $('#cuecard_note_box').hide();
            $('#cuecard_char_box').toggle();
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
        $('#cuecard_go').on('click', generate);
        $('#cuecard_direction').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); generate(); } });

        $('#cuecard_panel').on('click', '#cuecard_lang_chip', function (e) {
            e.stopPropagation();
            const order = ['ko', 'en', 'auto'];
            const st = settings();
            st.language = order[(order.indexOf(st.language) + 1) % order.length];
            save();
            refreshLangChip();
            $('#cuecard_language').val(st.language);
        });

        $('#cuecard_panel').on('click', '.cuecard-chip[data-mood]', function () {
            settings().lastMood = $(this).data('mood');
            save();
            refreshChips();
        });

        $('#cuecard_panel').on('click', '.cuecard-card', function () {
            const stored = loadStored();
            if (!stored) { showStored(); return; }
            const type = $(this).data('type');
            const idx = Number($(this).data('idx'));
            const text = (type === 'idea' ? stored.ideas : stored.replies)?.[idx];
            if (typeof text !== 'string') return;
            insertText(type === 'idea' ? `(OOC: ${text})` : text);
            if (settings().autoClose) togglePanel(false);
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
        for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
            if (c.event_types[name]) c.eventSource.on(c.event_types[name], expireResults);
        }
        c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
            if (busy) cancel();
            lastSent = null;
            $('#cuecard_direction').val('');
            $('#cuecard_note_box').hide();
            $('#cuecard_char_box').hide();
            refreshNote();
            refreshCharBox();
            showStored();
            if (busy) $('#cuecard_go').addClass('cuecard-cancel').text('취소 중…');
        });
        refreshNote();
        refreshCharBox();
        showStored();

        console.log('[Crib Note] loaded');
    }

    jQuery(() => init());
})();

