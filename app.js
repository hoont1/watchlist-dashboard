(function () {
  "use strict";

  var SUPABASE_URL = "https://gbjozahbwvrdspskxxcx.supabase.co";
  var SUPABASE_KEY = "sb_publishable_EdPru57DKX1iH7w6_F0K-A_CLb2u7Pu";
  var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var DEVIATION_THRESHOLD = 5; // %p
  var OVERDUE_DAYS = 7; // "주 1회" cadence — flag a client once this many days pass since their last check
  var DEFAULT_ASSET_CLASSES = ["국내주식", "해외주식", "채권", "현금성자산", "대체투자", "기타"];

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
  function fmtWeight(n) {
    return Number(n).toFixed(1);
  }
  function fmtAmount(n) {
    return Number(n).toFixed(2);
  }
  function deviationOf(h) {
    return Number(h.actual_weight) - Number(h.target_weight);
  }
  function daysSince(dateStr) {
    var reviewDate = new Date(dateStr + "T00:00:00");
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((today - reviewDate) / 86400000);
  }
  function reportError(err) {
    console.error(err);
    alert("저장소(Supabase)와 통신 중 오류가 발생했습니다: " + (err && err.message ? err.message : err));
  }

  // ---- state (in-memory cache of the last fetch from Supabase) ----
  var clients = [];
  var holdings = []; // all holdings, across all clients — needed for the rebalance list
  var personalEvents = [];
  var selectedClientId = null;
  var editingHoldingId = null;
  var clientSearchQuery = "";
  var clientSortOption = "review-oldest"; // "review-oldest" | "deviation-desc" | "name"
  var openEventDate = null; // "YYYY-MM-DD" of the day shown in the event modal, null when closed
  var confirmResolve = null; // pending Promise resolver for the generic confirm modal, null when closed

  var STATUS_META = {
    danger:  { emoji: "🔴", label: "리밸런싱 필요" },
    warning: { emoji: "🟡", label: "점검 임박" },
    ok:      { emoji: "🟢", label: "정상" }
  };

  // ---- header ----
  function renderHeader() {
    var d = new Date();
    var days = ["일", "월", "화", "수", "목", "금", "토"];
    var dateStr = d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + days[d.getDay()] + ")";
    document.getElementById("today-date").textContent = dateStr;
  }

  // ---- 오늘의 급등락 종목 (대시보드 상단, /api/stocks 서버리스 함수가 네이버 금융을 대신 조회) ----
  function renderStockList(rows, direction) {
    if (!rows || rows.length === 0) return '<div class="empty-state">데이터가 없습니다.</div>';
    return '<ul class="stock-list">' + rows.map(function (s) {
      var sign = s.changePercent > 0 ? "+" : "";
      return (
        '<li class="stock-item">' +
          '<span class="stock-name">' + escapeHtml(s.name) + '</span>' +
          '<span class="stock-price">' + escapeHtml(s.price) + '</span>' +
          '<span class="stock-change ' + direction + '">' + sign + s.changePercent.toFixed(2) + '%</span>' +
        '</li>'
      );
    }).join("") + '</ul>';
  }

  function renderStocks(state) {
    var content = document.getElementById("stocks-content");
    var updated = document.getElementById("stocks-updated");
    if (state.status === "loading") {
      updated.textContent = "";
      content.innerHTML = '<div class="empty-state">시세 정보를 불러오는 중...</div>';
      return;
    }
    if (state.status === "error") {
      updated.textContent = "";
      content.innerHTML =
        '<div class="empty-state">시세 정보를 불러오지 못했습니다.' +
          '<div class="stock-retry-row"><button type="button" id="stocks-retry">다시 시도</button></div>' +
        '</div>';
      return;
    }
    var d = new Date(state.data.updatedAt);
    updated.textContent = "업데이트 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " 기준";
    content.innerHTML =
      '<div class="stock-columns">' +
        '<div class="stock-col">' +
          '<h3 class="stock-col-title">급등</h3>' +
          renderStockList(state.data.risers, "up") +
        '</div>' +
        '<div class="stock-col">' +
          '<h3 class="stock-col-title">급락</h3>' +
          renderStockList(state.data.fallers, "down") +
        '</div>' +
      '</div>';
  }

  async function fetchStocks() {
    renderStocks({ status: "loading" });
    try {
      var res = await fetch("/api/stocks");
      var data = await res.json();
      if (!res.ok || data.error) throw new Error((data && data.message) || "요청 실패");
      renderStocks({ status: "ok", data: data });
    } catch (err) {
      console.error(err);
      renderStocks({ status: "error" });
    }
  }

  document.getElementById("stocks-refresh").addEventListener("click", fetchStocks);
  document.getElementById("stocks-content").addEventListener("click", function (e) {
    if (e.target.id === "stocks-retry") fetchStocks();
  });

  // ---- clients ----
  // 🔴 리밸런싱 필요(이탈 초과) > 🟡 점검 임박(다음 점검 예정일까지 3일 이하) > 🟢 정상, 이 우선순위로 판정
  function clientStatus(client) {
    var rows = holdings.filter(function (h) { return h.client_id === client.id; });
    var overDeviation = rows.some(function (h) { return Math.abs(deviationOf(h)) > DEVIATION_THRESHOLD; });
    if (overDeviation) return "danger";
    var dueDate = addDays(client.review_date, OVERDUE_DAYS);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var daysUntilDue = Math.round((dueDate - today) / 86400000);
    if (daysUntilDue <= 3) return "warning";
    return "ok";
  }

  function maxAbsDeviationForClient(clientId) {
    var devs = holdings.filter(function (h) { return h.client_id === clientId; }).map(function (h) { return Math.abs(deviationOf(h)); });
    return devs.length ? Math.max.apply(null, devs) : 0;
  }

  function filteredClients() {
    var query = clientSearchQuery.trim().toLowerCase();
    if (!query) return clients;
    return clients.filter(function (c) { return c.name.toLowerCase().indexOf(query) !== -1; });
  }

  function sortedClients(rows) {
    var sorted = rows.slice();
    if (clientSortOption === "deviation-desc") {
      sorted.sort(function (a, b) { return maxAbsDeviationForClient(b.id) - maxAbsDeviationForClient(a.id); });
    } else if (clientSortOption === "name") {
      sorted.sort(function (a, b) { return a.name.localeCompare(b.name, "ko"); });
    } else {
      sorted.sort(function (a, b) { return a.review_date < b.review_date ? -1 : a.review_date > b.review_date ? 1 : 0; });
    }
    return sorted;
  }

  function renderClientCards() {
    var box = document.getElementById("client-cards");
    if (clients.length === 0) {
      box.innerHTML = '<div class="empty-state">아직 등록된 고객이 없습니다. 위에서 고객을 등록해보세요.</div>';
      return;
    }
    var rows = sortedClients(filteredClients());
    if (rows.length === 0) {
      box.innerHTML = '<div class="empty-state">조건에 맞는 고객이 없습니다.</div>';
      return;
    }
    box.innerHTML = rows.map(function (c) {
      var selected = c.id === selectedClientId;
      var meta = STATUS_META[clientStatus(c)];
      return (
        '<div class="client-card' + (selected ? " selected" : "") + '" data-id="' + c.id + '" data-action="select-client">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="name">' + escapeHtml(c.name) + '</div>' +
              '<div class="review-date">점검일 ' + escapeHtml(c.review_date) + '</div>' +
              (c.total_assets != null ? '<div class="review-date">총자산 ' + fmtWeight(c.total_assets) + '억원</div>' : '') +
            '</div>' +
            '<div class="card-actions">' +
              '<span class="status-badge" title="' + meta.label + '">' + meta.emoji + '</span>' +
              '<button class="delete-btn" data-action="delete-client" data-id="' + c.id + '" aria-label="고객 삭제" title="삭제">✕</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  async function fetchClients() {
    var res = await db.from("clients").select("*").order("review_date", { ascending: false });
    if (res.error) { reportError(res.error); return; }
    clients = res.data;
    if (selectedClientId && !clients.some(function (c) { return c.id === selectedClientId; })) {
      selectedClientId = null;
    }
    renderClientCards();
  }

  document.getElementById("client-search").addEventListener("input", function (e) {
    clientSearchQuery = e.target.value;
    renderClientCards();
  });

  document.getElementById("client-sort").addEventListener("change", function (e) {
    clientSortOption = e.target.value;
    renderClientCards();
  });

  document.getElementById("client-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = document.getElementById("client-name").value.trim();
    var reviewDate = document.getElementById("client-date").value;
    var assetsInput = document.getElementById("client-assets").value;
    if (!name || !reviewDate) return;
    var res = await db.from("clients").insert({
      name: name,
      review_date: reviewDate,
      total_assets: assetsInput === "" ? null : Number(assetsInput)
    }).select().single();
    if (res.error) { reportError(res.error); return; }
    this.reset();
    await fetchClients();
    renderReminderList();
    location.hash = "#/clients/" + res.data.id;
  });

  document.getElementById("client-cards").addEventListener("click", async function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-client"]');
    var card = e.target.closest('[data-action="select-client"]');
    if (deleteBtn) {
      var confirmed = await askConfirm("이 고객과 등록된 자산군 데이터를 모두 삭제합니다. 정말 삭제하시겠습니까?");
      if (!confirmed) return;
      var id = deleteBtn.getAttribute("data-id");
      var res = await db.from("clients").delete().eq("id", id);
      if (res.error) { reportError(res.error); return; }
      if (selectedClientId === id) selectedClientId = null;
      await fetchClients();
      await fetchHoldings();
      renderClientCards();
      renderRebalanceList();
      renderReminderList();
    } else if (card) {
      location.hash = "#/clients/" + card.getAttribute("data-id");
    }
  });

  // ---- holdings (좌측 자산군별 비중 입력) ----
  function selectedClientHoldings() {
    return holdings.filter(function (h) { return h.client_id === selectedClientId; });
  }

  function renderSumCheck(rows) {
    var box = document.getElementById("holding-sum");
    if (rows.length === 0) {
      box.innerHTML = "";
      return;
    }
    var actualSum = rows.reduce(function (s, h) { return s + Number(h.actual_weight); }, 0);
    var targetSum = rows.reduce(function (s, h) { return s + Number(h.target_weight); }, 0);
    box.innerHTML =
      '<span>보유비중 합계 <strong>' + fmtWeight(actualSum) + '%</strong></span>' +
      '<span>목표비중 합계 <strong>' + fmtWeight(targetSum) + '%</strong></span>';
  }

  function renderHoldingPanel() {
    var sub = document.getElementById("holding-panel-sub");
    var selected = clients.find(function (c) { return c.id === selectedClientId; });
    sub.textContent = selected
      ? selected.name + " 고객의 자산군별 보유/목표 비중을 입력하세요."
      : "위에서 고객을 먼저 선택하세요.";

    var list = document.getElementById("holding-list");
    var rows = selectedClientHoldings();
    if (!selected) {
      list.innerHTML = "";
      renderSumCheck([]);
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = '<li class="empty-state">등록된 자산군이 없습니다. 위에서 추가해보세요.</li>';
      renderSumCheck([]);
      return;
    }
    renderSumCheck(rows);
    list.innerHTML = rows.map(function (h) {
      if (h.id === editingHoldingId) {
        return (
          '<li class="holding-item editing" data-id="' + h.id + '">' +
            '<form class="add-form inline-edit-form" data-action="save-holding-edit" data-id="' + h.id + '">' +
              '<input class="asset-name-input" name="asset_class" type="text" list="asset-class-options" value="' + escapeAttr(h.asset_class) + '" required>' +
              '<input class="weight-input" name="actual_weight" type="number" step="0.1" min="0" max="100" value="' + escapeAttr(h.actual_weight) + '" required>' +
              '<input class="weight-input" name="target_weight" type="number" step="0.1" min="0" max="100" value="' + escapeAttr(h.target_weight) + '" required>' +
              '<div class="edit-actions">' +
                '<button type="submit">저장</button>' +
                '<button type="button" class="btn-ghost" data-action="cancel-holding-edit">취소</button>' +
              '</div>' +
            '</form>' +
          '</li>'
        );
      }
      return (
        '<li class="holding-item" data-id="' + h.id + '">' +
          '<div>' +
            '<div class="asset-name">' + escapeHtml(h.asset_class) + '</div>' +
            '<div class="weights">보유 ' + fmtWeight(h.actual_weight) + '% / 목표 ' + fmtWeight(h.target_weight) + '%</div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="icon-btn" data-action="edit-holding" data-id="' + h.id + '" aria-label="자산군 수정" title="수정">✎</button>' +
            '<button class="delete-btn" data-action="delete-holding" data-id="' + h.id + '" aria-label="자산군 삭제" title="삭제">✕</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  async function fetchHoldings() {
    var res = await db.from("holdings").select("*").order("created_at", { ascending: true });
    if (res.error) { reportError(res.error); return; }
    holdings = res.data;
    renderAssetClassOptions();
  }

  // 자산군명 입력 자동완성 — 기본 자산군 + 그동안 입력했던 자산군명을 후보로 제공
  function renderAssetClassOptions() {
    var seen = {};
    var names = [];
    DEFAULT_ASSET_CLASSES.concat(holdings.map(function (h) { return h.asset_class; })).forEach(function (name) {
      if (!seen[name]) { seen[name] = true; names.push(name); }
    });
    document.getElementById("asset-class-options").innerHTML = names.map(function (name) {
      return '<option value="' + escapeAttr(name) + '">';
    }).join("");
  }

  document.getElementById("holding-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!selectedClientId) {
      alert("먼저 위에서 고객을 선택하세요.");
      return;
    }
    var assetClass = document.getElementById("holding-asset").value.trim();
    var actual = document.getElementById("holding-actual").value;
    var target = document.getElementById("holding-target").value;
    if (!assetClass || actual === "" || target === "") return;
    var res = await db.from("holdings").insert({
      client_id: selectedClientId,
      asset_class: assetClass,
      actual_weight: Number(actual),
      target_weight: Number(target)
    });
    if (res.error) { reportError(res.error); return; }
    this.reset();
    await fetchHoldings();
    renderHoldingPanel();
    renderDeviationCards();
    renderRebalanceList();
  });

  document.getElementById("holding-list").addEventListener("click", async function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-holding"]');
    var editBtn = e.target.closest('[data-action="edit-holding"]');
    var cancelBtn = e.target.closest('[data-action="cancel-holding-edit"]');
    if (deleteBtn) {
      if (!confirm("이 자산군 항목을 삭제할까요?")) return;
      var id = deleteBtn.getAttribute("data-id");
      var res = await db.from("holdings").delete().eq("id", id);
      if (res.error) { reportError(res.error); return; }
      await fetchHoldings();
      renderHoldingPanel();
      renderDeviationCards();
      renderRebalanceList();
    } else if (editBtn) {
      editingHoldingId = editBtn.getAttribute("data-id");
      renderHoldingPanel();
    } else if (cancelBtn) {
      editingHoldingId = null;
      renderHoldingPanel();
    }
  });

  document.getElementById("holding-list").addEventListener("submit", async function (e) {
    var form = e.target.closest('[data-action="save-holding-edit"]');
    if (!form) return;
    e.preventDefault();
    var id = form.getAttribute("data-id");
    var assetClass = form.elements["asset_class"].value.trim();
    var actual = form.elements["actual_weight"].value;
    var target = form.elements["target_weight"].value;
    if (!assetClass || actual === "" || target === "") return;
    var res = await db.from("holdings").update({
      asset_class: assetClass,
      actual_weight: Number(actual),
      target_weight: Number(target)
    }).eq("id", id);
    if (res.error) { reportError(res.error); return; }
    editingHoldingId = null;
    await fetchHoldings();
    renderHoldingPanel();
    renderDeviationCards();
    renderRebalanceList();
  });

  // ---- deviation cards (우측 이탈률 결과, 선택된 고객 기준) ----
  function renderDeviationCards() {
    var box = document.getElementById("deviation-cards");
    var selected = clients.find(function (c) { return c.id === selectedClientId; });
    if (!selected) {
      box.innerHTML = '<div class="empty-state">고객을 선택하면 이탈률이 표시됩니다.</div>';
      return;
    }
    var rows = selectedClientHoldings();
    if (rows.length === 0) {
      box.innerHTML = '<div class="empty-state">등록된 자산군이 없습니다.</div>';
      return;
    }
    box.innerHTML = rows.map(function (h) {
      var dev = deviationOf(h);
      var over = Math.abs(dev) > DEVIATION_THRESHOLD;
      // dev > 0: 초과보유(보유 > 목표) → 매도 필요 · dev < 0: 부족보유(보유 < 목표) → 매수 필요
      var direction = dev > 0 ? "sell" : "buy";
      var actionLabel = dev > 0 ? "매도 필요" : "매수 필요";
      var sign = dev > 0 ? "+" : "";
      var actualPct = Math.max(0, Math.min(100, Number(h.actual_weight)));
      var targetPct = Math.max(0, Math.min(100, Number(h.target_weight)));
      var amountHtml = "";
      if (over && selected.total_assets != null) {
        var amount = Math.abs(dev) / 100 * Number(selected.total_assets);
        amountHtml =
          '<div class="amount-suggestion">' +
            '약 <strong>' + fmtAmount(amount) + '억원 ' + (dev > 0 ? "매도" : "매수") + ' 필요</strong>' +
            '<div class="amount-basis">이탈 ' + fmtWeight(Math.abs(dev)) + '%p × 총자산 ' + fmtWeight(selected.total_assets) + '억원</div>' +
          '</div>';
      }
      return (
        '<div class="deviation-card' + (over ? " over over-" + direction : "") + '">' +
          '<div class="asset-name">' + escapeHtml(h.asset_class) + '</div>' +
          '<div class="weight-bar">' +
            '<div class="weight-bar-fill" style="width:' + actualPct + '%"></div>' +
            '<div class="weight-bar-target" style="left:' + targetPct + '%"></div>' +
          '</div>' +
          '<div class="stat-row"><span>보유</span><span>' + fmtWeight(h.actual_weight) + '%</span></div>' +
          '<div class="stat-row"><span>목표</span><span>' + fmtWeight(h.target_weight) + '%</span></div>' +
          '<div class="deviation-value">' + sign + fmtWeight(dev) + '%p' + (over ? ' <span class="action-label">' + actionLabel + '</span>' : '') + '</div>' +
          amountHtml +
        '</div>'
      );
    }).join("");
  }

  // ---- rebalance list (우측, 전체 고객 중 이탈 기준 초과) ----
  function renderRebalanceList() {
    var list = document.getElementById("rebalance-list");
    var byClient = {};
    holdings.forEach(function (h) {
      var dev = deviationOf(h);
      if (Math.abs(dev) <= DEVIATION_THRESHOLD) return;
      (byClient[h.client_id] = byClient[h.client_id] || []).push({ h: h, dev: dev });
    });

    var entries = Object.keys(byClient).map(function (clientId) {
      var client = clients.find(function (c) { return c.id === clientId; });
      var items = byClient[clientId];
      var maxAbsDev = Math.max.apply(null, items.map(function (i) { return Math.abs(i.dev); }));
      return { client: client, items: items, maxAbsDev: maxAbsDev };
    }).filter(function (e) { return e.client; });

    entries.sort(function (a, b) { return b.maxAbsDev - a.maxAbsDev; });

    if (entries.length === 0) {
      list.innerHTML = '<li class="empty-state">리밸런싱이 필요한 고객이 없습니다.</li>';
      return;
    }

    list.innerHTML = entries.map(function (e) {
      var reason = e.items.map(function (i) {
        var sign = i.dev > 0 ? "+" : "";
        return escapeHtml(i.h.asset_class) + " " + sign + fmtWeight(i.dev) + "%p";
      }).join(", ");
      return (
        '<li class="rebalance-item" data-action="goto-client" data-id="' + e.client.id + '">' +
          '<div class="name-row">' +
            '<span class="name">' + escapeHtml(e.client.name) + '</span>' +
            '<span class="review-date">점검일 ' + escapeHtml(e.client.review_date) + '</span>' +
          '</div>' +
          '<div class="reason">' + reason + '</div>' +
        '</li>'
      );
    }).join("");
  }

  document.getElementById("rebalance-list").addEventListener("click", function (e) {
    var item = e.target.closest('[data-action="goto-client"]');
    if (item) location.hash = "#/clients/" + item.getAttribute("data-id");
  });

  // ---- generic confirm modal (네이티브 confirm() 대체용) ----
  function askConfirm(message) {
    document.getElementById("confirm-message").textContent = message;
    document.getElementById("confirm-modal").classList.add("open");
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }

  function closeConfirm(result) {
    document.getElementById("confirm-modal").classList.remove("open");
    if (confirmResolve) {
      var resolve = confirmResolve;
      confirmResolve = null;
      resolve(result);
    }
  }

  document.getElementById("confirm-cancel").addEventListener("click", function () { closeConfirm(false); });
  document.getElementById("confirm-ok").addEventListener("click", function () { closeConfirm(true); });
  document.getElementById("confirm-modal").addEventListener("click", function (e) {
    if (e.target.id === "confirm-modal") closeConfirm(false);
  });

  // ---- personal events (개인 일정, 달력 날짜 클릭 시 모달에서 추가/조회) ----
  function eventsForDate(dateStr) {
    return personalEvents.filter(function (ev) { return ev.event_date === dateStr; });
  }

  function renderEventModal() {
    if (!openEventDate) return;
    var d = new Date(openEventDate + "T00:00:00");
    document.getElementById("event-modal-date").textContent = (d.getMonth() + 1) + "월 " + d.getDate() + "일 일정";
    document.getElementById("event-modal-list").innerHTML = eventsForDate(openEventDate).map(function (ev) {
      return (
        '<li class="holding-item" data-id="' + ev.id + '">' +
          '<div>' +
            '<div class="asset-name">' + escapeHtml(ev.title) + '</div>' +
            (ev.memo ? '<div class="weights">' + escapeHtml(ev.memo) + '</div>' : '') +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="delete-btn" data-action="delete-event" data-id="' + ev.id + '" aria-label="일정 삭제" title="삭제">✕</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  function openEventModal(dateStr) {
    openEventDate = dateStr;
    document.getElementById("event-form").reset();
    renderEventModal();
    document.getElementById("event-modal").classList.add("open");
  }

  function closeEventModal() {
    openEventDate = null;
    document.getElementById("event-modal").classList.remove("open");
  }

  async function fetchPersonalEvents() {
    var res = await db.from("personal_events").select("*").order("event_date", { ascending: true });
    if (res.error) { reportError(res.error); return; }
    personalEvents = res.data;
  }

  document.getElementById("reminder-list").addEventListener("click", function (e) {
    var cell = e.target.closest(".calendar-day[data-date]");
    if (cell) openEventModal(cell.getAttribute("data-date"));
  });

  document.getElementById("event-modal-close").addEventListener("click", closeEventModal);
  document.getElementById("event-modal").addEventListener("click", function (e) {
    if (e.target.id === "event-modal") closeEventModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (openEventDate) closeEventModal();
    if (confirmResolve) closeConfirm(false);
  });

  document.getElementById("event-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var title = document.getElementById("event-title").value.trim();
    var memo = document.getElementById("event-memo").value.trim();
    if (!title || !openEventDate) return;
    var res = await db.from("personal_events").insert({
      title: title,
      event_date: openEventDate,
      memo: memo === "" ? null : memo
    });
    if (res.error) { reportError(res.error); return; }
    this.reset();
    await fetchPersonalEvents();
    renderEventModal();
    renderReminderList();
  });

  document.getElementById("event-modal-list").addEventListener("click", async function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-event"]');
    if (!deleteBtn) return;
    if (!confirm("이 일정을 삭제할까요?")) return;
    var id = deleteBtn.getAttribute("data-id");
    var res = await db.from("personal_events").delete().eq("id", id);
    if (res.error) { reportError(res.error); return; }
    await fetchPersonalEvents();
    renderEventModal();
    renderReminderList();
  });

  // ---- reminder list (우측, 마지막 점검일로부터 7일 이상 지난 고객) ----
  function addDays(dateStr, days) {
    var d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + days);
    return d;
  }
  function dateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function renderReminderList() {
    var box = document.getElementById("reminder-list");
    var latestByName = {};
    clients.forEach(function (c) {
      var existing = latestByName[c.name];
      if (!existing || c.review_date > existing.review_date) {
        latestByName[c.name] = c;
      }
    });

    // 고객별 다음 점검 예정일 = 마지막 점검일 + OVERDUE_DAYS, 같은 날짜끼리 묶는다
    var dueByDate = {};
    Object.keys(latestByName).forEach(function (name) {
      var due = addDays(latestByName[name].review_date, OVERDUE_DAYS);
      var key = dateKey(due);
      (dueByDate[key] = dueByDate[key] || []).push(name);
    });

    // personal_events.event_date는 Supabase에서 "YYYY-MM-DD" 문자열로 오므로
    // dateKey()의 출력 형식과 그대로 맞아떨어져 추가 변환 없이 키로 쓴다
    var eventsByDate = {};
    personalEvents.forEach(function (ev) {
      (eventsByDate[ev.event_date] = eventsByDate[ev.event_date] || []).push(ev);
    });

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var year = today.getFullYear();
    var month = today.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var startWeekday = new Date(year, month, 1).getDay();
    var todayKeyStr = dateKey(today);

    var weekdayNames = ["일", "월", "화", "수", "목", "금", "토"];
    var cellsHtml = weekdayNames.map(function (w) {
      return '<div class="calendar-weekday">' + w + '</div>';
    }).join("");

    for (var i = 0; i < startWeekday; i++) {
      cellsHtml += '<div class="calendar-day empty"></div>';
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var cellDate = new Date(year, month, day);
      var key = dateKey(cellDate);
      var names = dueByDate[key] || [];
      var events = eventsByDate[key] || [];
      var isToday = key === todayKeyStr;
      var isPast = cellDate < today;
      var cls = "calendar-day";
      if (isToday) cls += " today";
      if (names.length > 0) cls += isPast ? " overdue" : " upcoming";
      cellsHtml +=
        '<div class="' + cls + '" data-date="' + key + '">' +
          '<div class="calendar-day-num">' + day + '</div>' +
          (names.length > 0 ? '<div class="calendar-day-names">' + names.map(escapeHtml).join(", ") + '</div>' : '') +
          (events.length > 0 ? '<div class="calendar-day-events">' + events.map(function (ev) { return escapeHtml(ev.title); }).join(", ") + '</div>' : '') +
        '</div>';
    }

    box.innerHTML =
      '<div class="calendar-month">' + (month + 1) + '월</div>' +
      '<div class="calendar-grid">' + cellsHtml + '</div>';
  }

  // ---- client detail header (고객 상세 페이지 상단: 이름/점검일/총자산) ----
  function renderClientDetailHeader(client) {
    document.getElementById("detail-client-name").textContent = client.name;
    document.getElementById("detail-client-meta").textContent =
      "점검일 " + client.review_date + (client.total_assets != null ? " · 총자산 " + fmtWeight(client.total_assets) + "억원" : "");
  }

  // ---- routing (해시 기반 페이지 전환: #/, #/clients, #/clients/:id) ----
  function parseRoute() {
    var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "clients" && parts[1]) return { view: "client-detail", clientId: parts[1] };
    if (parts[0] === "clients") return { view: "clients" };
    return { view: "dashboard" };
  }

  function showView(view) {
    document.querySelectorAll(".view").forEach(function (section) {
      section.classList.toggle("active", section.getAttribute("data-view") === view);
    });
    document.querySelectorAll(".nav-link").forEach(function (btn) {
      var target = btn.getAttribute("data-nav");
      var active = target === view || (target === "clients" && view === "client-detail");
      btn.classList.toggle("active", active);
    });
  }

  function renderRoute() {
    var route = parseRoute();
    if (route.view === "client-detail") {
      var client = clients.find(function (c) { return c.id === route.clientId; });
      if (!client) { location.hash = "#/clients"; return; }
      selectedClientId = route.clientId;
      renderClientDetailHeader(client);
      renderHoldingPanel();
      renderDeviationCards();
    } else if (route.view === "clients") {
      selectedClientId = null;
      renderClientCards();
    } else {
      renderRebalanceList();
      renderReminderList();
    }
    showView(route.view);
  }

  window.addEventListener("hashchange", renderRoute);
  document.addEventListener("click", function (e) {
    var navBtn = e.target.closest("[data-nav]");
    if (!navBtn) return;
    var target = navBtn.getAttribute("data-nav");
    location.hash = target === "dashboard" ? "#/" : "#/" + target;
  });

  // ---- init ----
  renderHeader();
  fetchStocks(); // 고객/자산 데이터와 독립적이므로 별도로 바로 호출
  (async function init() {
    await Promise.all([fetchClients(), fetchHoldings(), fetchPersonalEvents()]);
    renderRoute();
  })();
})();
