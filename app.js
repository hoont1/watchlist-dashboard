(function () {
  "use strict";

  var STORAGE = {
    watchlist: "dashboard_watchlist_v1",
    memos: "dashboard_memos_v1",
    checklist: "dashboard_checklist_v1",
    checklistDate: "dashboard_checklist_date_v1"
  };

  var REASONS = ["실적기대", "신규이슈", "장기관심", "기타"];

  // ---- storage helpers (fall back to in-memory if localStorage is blocked, e.g. some file:// contexts) ----
  var memoryFallback = {};
  var storageOk = true;
  try {
    var t = "__test__";
    window.localStorage.setItem(t, "1");
    window.localStorage.removeItem(t);
  } catch (e) {
    storageOk = false;
  }

  function loadJSON(key, fallback) {
    if (!storageOk) return memoryFallback[key] || fallback;
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    if (!storageOk) { memoryFallback[key] = value; return; }
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  // for values placed inside an HTML attribute (e.g. value="…"), quotes must also be escaped
  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function todayKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function reasonOptionsHtml(selected) {
    return REASONS.map(function (r) {
      return '<option value="' + r + '"' + (r === selected ? " selected" : "") + '>' + r + '</option>';
    }).join("");
  }

  // ---- state ----
  var watchlist = loadJSON(STORAGE.watchlist, []);
  var memos = loadJSON(STORAGE.memos, []);
  var checklist = loadJSON(STORAGE.checklist, [
    { id: uid(), text: "전일 미국 증시 마감 시황 확인", done: false },
    { id: uid(), text: "관심종목 공시/뉴스 확인", done: false },
    { id: uid(), text: "오늘 발표 예정 지표/일정 확인", done: false }
  ]);

  var editingStockId = null;
  var editingMemoId = null;
  var editingCheckId = null;

  // daily reset: uncheck items when the calendar day rolls over, keep the item text
  var now = new Date();
  var lastDate = loadJSON(STORAGE.checklistDate, null);
  if (lastDate !== todayKey(now)) {
    checklist.forEach(function (item) { item.done = false; });
    saveJSON(STORAGE.checklistDate, todayKey(now));
    saveJSON(STORAGE.checklist, checklist);
  }

  // ---- header ----
  function renderHeader() {
    var d = new Date();
    var days = ["일", "월", "화", "수", "목", "금", "토"];
    var dateStr = d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + days[d.getDay()] + ")";
    document.getElementById("today-date").textContent = dateStr;

    var hour = d.getHours();
    var greeting;
    if (hour < 9) greeting = "좋은 아침입니다, 오늘 하루도 힘내세요 ☀️";
    else if (hour < 12) greeting = "안녕하세요, 시황 체크하고 하루 시작해볼까요 📈";
    else if (hour < 18) greeting = "안녕하세요, 오후도 화이팅입니다 💪";
    else greeting = "오늘 하루도 수고 많으셨습니다 🌙";
    document.getElementById("greeting").textContent = greeting;
  }

  // ---- watchlist ----
  function isDuplicateStock(name, code, excludeId) {
    var normName = name.trim().toLowerCase();
    var normCode = (code || "").trim();
    return watchlist.some(function (s) {
      if (excludeId && s.id === excludeId) return false;
      var sameName = s.name.trim().toLowerCase() === normName;
      var sameCode = normCode !== "" && (s.code || "").trim() === normCode;
      return sameName || sameCode;
    });
  }

  function renderWatchlist() {
    var box = document.getElementById("watchlist-cards");
    if (watchlist.length === 0) {
      box.innerHTML = '<div class="empty-state">아직 등록된 관심종목이 없습니다. 위에서 추가해보세요.</div>';
      return;
    }
    box.innerHTML = watchlist.map(function (s) {
      if (s.id === editingStockId) {
        return (
          '<div class="stock-card editing" data-id="' + s.id + '">' +
            '<form class="add-form inline-edit-form" data-action="save-stock-edit" data-id="' + s.id + '">' +
              '<input class="stock-name-input" name="name" type="text" value="' + escapeAttr(s.name) + '" required>' +
              '<input class="stock-code-input" name="code" type="text" value="' + escapeAttr(s.code || "") + '">' +
              '<select class="stock-reason-select" name="reason">' + reasonOptionsHtml(s.reason) + '</select>' +
              '<input class="stock-memo-input" name="memo" type="text" value="' + escapeAttr(s.memo || "") + '">' +
              '<div class="edit-actions">' +
                '<button type="submit">저장</button>' +
                '<button type="button" class="btn-ghost" data-action="cancel-stock-edit">취소</button>' +
              '</div>' +
            '</form>' +
          '</div>'
        );
      }
      return (
        '<div class="stock-card" data-id="' + s.id + '">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="name">' + escapeHtml(s.name) + '</div>' +
              (s.code ? '<div class="code">' + escapeHtml(s.code) + '</div>' : '') +
            '</div>' +
            '<div class="card-actions">' +
              '<button class="icon-btn" data-action="edit-stock" data-id="' + s.id + '" aria-label="관심종목 수정" title="수정">✎</button>' +
              '<button class="delete-btn" data-action="delete-stock" data-id="' + s.id + '" aria-label="관심종목 삭제" title="삭제">✕</button>' +
            '</div>' +
          '</div>' +
          '<span class="tag" data-reason="' + escapeHtml(s.reason) + '">' + escapeHtml(s.reason) + '</span>' +
          (s.memo ? '<div class="memo">' + escapeHtml(s.memo) + '</div>' : '') +
        '</div>'
      );
    }).join("");
  }

  document.getElementById("stock-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("stock-name").value.trim();
    if (!name) return;
    var code = document.getElementById("stock-code").value.trim();
    var reason = document.getElementById("stock-reason").value;
    var memo = document.getElementById("stock-memo").value.trim();
    if (isDuplicateStock(name, code, null)) {
      alert("이미 등록된 종목입니다 (같은 종목명 또는 종목코드가 존재합니다).");
      return;
    }
    watchlist.unshift({ id: uid(), name: name, code: code, reason: reason, memo: memo });
    saveJSON(STORAGE.watchlist, watchlist);
    this.reset();
    renderWatchlist();
  });

  document.getElementById("watchlist-cards").addEventListener("click", function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-stock"]');
    var editBtn = e.target.closest('[data-action="edit-stock"]');
    var cancelBtn = e.target.closest('[data-action="cancel-stock-edit"]');
    if (deleteBtn) {
      if (!confirm("이 관심종목을 삭제할까요?")) return;
      var id = deleteBtn.getAttribute("data-id");
      watchlist = watchlist.filter(function (s) { return s.id !== id; });
      saveJSON(STORAGE.watchlist, watchlist);
      renderWatchlist();
    } else if (editBtn) {
      editingStockId = editBtn.getAttribute("data-id");
      renderWatchlist();
    } else if (cancelBtn) {
      editingStockId = null;
      renderWatchlist();
    }
  });

  document.getElementById("watchlist-cards").addEventListener("submit", function (e) {
    var form = e.target.closest('[data-action="save-stock-edit"]');
    if (!form) return;
    e.preventDefault();
    var id = form.getAttribute("data-id");
    var name = form.elements["name"].value.trim();
    if (!name) return;
    var code = form.elements["code"].value.trim();
    var reason = form.elements["reason"].value;
    var memo = form.elements["memo"].value.trim();
    if (isDuplicateStock(name, code, id)) {
      alert("이미 등록된 종목입니다 (같은 종목명 또는 종목코드가 존재합니다).");
      return;
    }
    watchlist.forEach(function (s) {
      if (s.id === id) { s.name = name; s.code = code; s.reason = reason; s.memo = memo; }
    });
    saveJSON(STORAGE.watchlist, watchlist);
    editingStockId = null;
    renderWatchlist();
  });

  // ---- memos ----
  function renderMemos() {
    var box = document.getElementById("memo-list");
    if (memos.length === 0) {
      box.innerHTML = '<li class="empty-state">아직 기록된 메모가 없습니다.</li>';
      return;
    }
    box.innerHTML = memos.map(function (m) {
      if (m.id === editingMemoId) {
        return (
          '<li class="memo-item editing" data-id="' + m.id + '">' +
            '<form class="add-form inline-edit-form" data-action="save-memo-edit" data-id="' + m.id + '">' +
              '<textarea class="memo-textarea" name="text" required>' + escapeHtml(m.text) + '</textarea>' +
              '<div class="edit-actions">' +
                '<button type="submit">저장</button>' +
                '<button type="button" class="btn-ghost" data-action="cancel-memo-edit">취소</button>' +
              '</div>' +
            '</form>' +
          '</li>'
        );
      }
      return (
        '<li class="memo-item" data-id="' + m.id + '">' +
          '<div>' +
            '<span class="memo-time">' + escapeHtml(m.time) + '</span>' +
            '<div class="memo-body">' + escapeHtml(m.text) + '</div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="icon-btn" data-action="edit-memo" data-id="' + m.id + '" aria-label="메모 수정" title="수정">✎</button>' +
            '<button class="delete-btn" data-action="delete-memo" data-id="' + m.id + '" aria-label="메모 삭제" title="삭제">✕</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  document.getElementById("memo-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var textarea = document.getElementById("memo-text");
    var text = textarea.value.trim();
    if (!text) return;
    var d = new Date();
    var time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    memos.unshift({ id: uid(), text: text, time: time });
    saveJSON(STORAGE.memos, memos);
    textarea.value = "";
    renderMemos();
  });

  document.getElementById("memo-list").addEventListener("click", function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-memo"]');
    var editBtn = e.target.closest('[data-action="edit-memo"]');
    var cancelBtn = e.target.closest('[data-action="cancel-memo-edit"]');
    if (deleteBtn) {
      if (!confirm("이 메모를 삭제할까요?")) return;
      var id = deleteBtn.getAttribute("data-id");
      memos = memos.filter(function (m) { return m.id !== id; });
      saveJSON(STORAGE.memos, memos);
      renderMemos();
    } else if (editBtn) {
      editingMemoId = editBtn.getAttribute("data-id");
      renderMemos();
    } else if (cancelBtn) {
      editingMemoId = null;
      renderMemos();
    }
  });

  document.getElementById("memo-list").addEventListener("submit", function (e) {
    var form = e.target.closest('[data-action="save-memo-edit"]');
    if (!form) return;
    e.preventDefault();
    var id = form.getAttribute("data-id");
    var text = form.elements["text"].value.trim();
    if (!text) return;
    memos.forEach(function (m) { if (m.id === id) m.text = text; });
    saveJSON(STORAGE.memos, memos);
    editingMemoId = null;
    renderMemos();
  });

  // ---- checklist ----
  function renderChecklist() {
    var box = document.getElementById("checklist");
    var progress = document.getElementById("checklist-progress");
    var doneCount = checklist.filter(function (c) { return c.done; }).length;

    if (checklist.length === 0) {
      progress.textContent = "";
      box.innerHTML = '<li class="empty-state">체크리스트 항목을 추가해보세요.</li>';
      return;
    }
    progress.innerHTML = "오늘 진행률: <strong>" + doneCount + " / " + checklist.length + "</strong> 완료";
    box.innerHTML = checklist.map(function (c) {
      if (c.id === editingCheckId) {
        return (
          '<li class="check-item editing" data-id="' + c.id + '">' +
            '<form class="add-form inline-edit-form" data-action="save-check-edit" data-id="' + c.id + '">' +
              '<input class="check-input" name="text" type="text" value="' + escapeAttr(c.text) + '" required>' +
              '<div class="edit-actions">' +
                '<button type="submit">저장</button>' +
                '<button type="button" class="btn-ghost" data-action="cancel-check-edit">취소</button>' +
              '</div>' +
            '</form>' +
          '</li>'
        );
      }
      return (
        '<li class="check-item' + (c.done ? " done" : "") + '" data-id="' + c.id + '">' +
          '<label class="check-label">' +
            '<input type="checkbox" data-action="toggle-check" data-id="' + c.id + '" ' + (c.done ? "checked" : "") + '>' +
            '<span class="check-text">' + escapeHtml(c.text) + '</span>' +
          '</label>' +
          '<div class="card-actions">' +
            '<button class="icon-btn" data-action="edit-check" data-id="' + c.id + '" aria-label="체크리스트 항목 수정" title="수정">✎</button>' +
            '<button class="delete-btn" data-action="delete-check" data-id="' + c.id + '" aria-label="체크리스트 항목 삭제" title="삭제">✕</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  document.getElementById("check-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("check-text");
    var text = input.value.trim();
    if (!text) return;
    checklist.push({ id: uid(), text: text, done: false });
    saveJSON(STORAGE.checklist, checklist);
    input.value = "";
    renderChecklist();
  });

  document.getElementById("checklist").addEventListener("click", function (e) {
    var toggleBtn = e.target.closest('[data-action="toggle-check"]');
    var deleteBtn = e.target.closest('[data-action="delete-check"]');
    var editBtn = e.target.closest('[data-action="edit-check"]');
    var cancelBtn = e.target.closest('[data-action="cancel-check-edit"]');
    if (toggleBtn) {
      var id1 = toggleBtn.getAttribute("data-id");
      checklist.forEach(function (c) { if (c.id === id1) c.done = !c.done; });
      saveJSON(STORAGE.checklist, checklist);
      renderChecklist();
    } else if (deleteBtn) {
      if (!confirm("이 체크리스트 항목을 삭제할까요?")) return;
      var id2 = deleteBtn.getAttribute("data-id");
      checklist = checklist.filter(function (c) { return c.id !== id2; });
      saveJSON(STORAGE.checklist, checklist);
      renderChecklist();
    } else if (editBtn) {
      editingCheckId = editBtn.getAttribute("data-id");
      renderChecklist();
    } else if (cancelBtn) {
      editingCheckId = null;
      renderChecklist();
    }
  });

  document.getElementById("checklist").addEventListener("submit", function (e) {
    var form = e.target.closest('[data-action="save-check-edit"]');
    if (!form) return;
    e.preventDefault();
    var id = form.getAttribute("data-id");
    var text = form.elements["text"].value.trim();
    if (!text) return;
    checklist.forEach(function (c) { if (c.id === id) c.text = text; });
    saveJSON(STORAGE.checklist, checklist);
    editingCheckId = null;
    renderChecklist();
  });

  // ---- init ----
  renderHeader();
  renderWatchlist();
  renderMemos();
  renderChecklist();
})();
