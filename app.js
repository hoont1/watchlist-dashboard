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
  var selectedClientId = null;
  var editingHoldingId = null;

  // ---- KPI row (상단 요약: 전체 고객 / 이탈 초과 고객 / 점검 밀린 고객) ----
  function renderKpis() {
    var box = document.getElementById("kpi-row");

    var totalNames = {};
    clients.forEach(function (c) { totalNames[c.name] = true; });
    var totalCount = Object.keys(totalNames).length;

    var overClientIds = {};
    holdings.forEach(function (h) {
      if (Math.abs(deviationOf(h)) > DEVIATION_THRESHOLD) overClientIds[h.client_id] = true;
    });
    var overCount = Object.keys(overClientIds).length;

    var latestByName = {};
    clients.forEach(function (c) {
      var existing = latestByName[c.name];
      if (!existing || c.review_date > existing.review_date) latestByName[c.name] = c;
    });
    var overdueCount = Object.keys(latestByName).filter(function (name) {
      return daysSince(latestByName[name].review_date) >= OVERDUE_DAYS;
    }).length;

    box.innerHTML =
      '<div class="stat-tile"><div class="stat-value">' + totalCount + '</div><div class="stat-label">전체 고객</div></div>' +
      '<div class="stat-tile' + (overCount > 0 ? ' over' : '') + '"><div class="stat-value">' + overCount + '</div><div class="stat-label">이탈 초과 고객</div></div>' +
      '<div class="stat-tile' + (overdueCount > 0 ? ' over' : '') + '"><div class="stat-value">' + overdueCount + '</div><div class="stat-label">점검 밀린 고객</div></div>';
  }

  // ---- header ----
  function renderHeader() {
    var d = new Date();
    var days = ["일", "월", "화", "수", "목", "금", "토"];
    var dateStr = d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + days[d.getDay()] + ")";
    document.getElementById("today-date").textContent = dateStr;
  }

  // ---- clients ----
  function renderClientCards() {
    var box = document.getElementById("client-cards");
    if (clients.length === 0) {
      box.innerHTML = '<div class="empty-state">등록된 고객이 없습니다. 위에서 추가해보세요.</div>';
      return;
    }
    box.innerHTML = clients.map(function (c) {
      var selected = c.id === selectedClientId;
      return (
        '<div class="client-card' + (selected ? " selected" : "") + '" data-id="' + c.id + '" data-action="select-client">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="name">' + escapeHtml(c.name) + '</div>' +
              '<div class="review-date">점검일 ' + escapeHtml(c.review_date) + '</div>' +
            '</div>' +
            '<div class="card-actions">' +
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

  document.getElementById("client-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = document.getElementById("client-name").value.trim();
    var reviewDate = document.getElementById("client-date").value;
    if (!name || !reviewDate) return;
    var res = await db.from("clients").insert({ name: name, review_date: reviewDate }).select().single();
    if (res.error) { reportError(res.error); return; }
    this.reset();
    selectedClientId = res.data.id;
    await fetchClients();
    renderHoldingPanel();
    renderDeviationCards();
    renderReminderList();
    renderKpis();
  });

  document.getElementById("client-cards").addEventListener("click", async function (e) {
    var deleteBtn = e.target.closest('[data-action="delete-client"]');
    var card = e.target.closest('[data-action="select-client"]');
    if (deleteBtn) {
      if (!confirm("이 고객과 등록된 자산군 데이터를 모두 삭제할까요?")) return;
      var id = deleteBtn.getAttribute("data-id");
      var res = await db.from("clients").delete().eq("id", id);
      if (res.error) { reportError(res.error); return; }
      if (selectedClientId === id) selectedClientId = null;
      await fetchClients();
      await fetchHoldings();
      renderHoldingPanel();
      renderDeviationCards();
      renderRebalanceList();
      renderReminderList();
      renderKpis();
    } else if (card) {
      selectedClientId = card.getAttribute("data-id");
      renderClientCards();
      renderHoldingPanel();
      renderDeviationCards();
    }
  });

  // ---- holdings (좌측 자산군별 비중 입력) ----
  function selectedClientHoldings() {
    return holdings.filter(function (h) { return h.client_id === selectedClientId; });
  }

  var WEIGHT_SUM_TOLERANCE = 0.05; // absolute %p slack around 100 before flagging a bad sum

  function renderSumCheck(rows) {
    var box = document.getElementById("holding-sum");
    if (rows.length === 0) {
      box.innerHTML = "";
      return;
    }
    var actualSum = rows.reduce(function (s, h) { return s + Number(h.actual_weight); }, 0);
    var targetSum = rows.reduce(function (s, h) { return s + Number(h.target_weight); }, 0);
    var actualOff = Math.abs(actualSum - 100) > WEIGHT_SUM_TOLERANCE;
    var targetOff = Math.abs(targetSum - 100) > WEIGHT_SUM_TOLERANCE;
    box.innerHTML =
      '<span>보유비중 합계 <strong>' + fmtWeight(actualSum) + '%</strong>' + (actualOff ? ' <span class="tag over">100% 아님</span>' : '') + '</span>' +
      '<span>목표비중 합계 <strong>' + fmtWeight(targetSum) + '%</strong>' + (targetOff ? ' <span class="tag over">100% 아님</span>' : '') + '</span>';
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
    renderKpis();
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
      renderKpis();
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
    renderKpis();
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
      var sign = dev > 0 ? "+" : "";
      var actualPct = Math.max(0, Math.min(100, Number(h.actual_weight)));
      var targetPct = Math.max(0, Math.min(100, Number(h.target_weight)));
      return (
        '<div class="deviation-card' + (over ? " over" : "") + '">' +
          '<div class="asset-name">' + escapeHtml(h.asset_class) + '</div>' +
          '<div class="weight-bar">' +
            '<div class="weight-bar-fill" style="width:' + actualPct + '%"></div>' +
            '<div class="weight-bar-target" style="left:' + targetPct + '%"></div>' +
          '</div>' +
          '<div class="stat-row"><span>보유</span><span>' + fmtWeight(h.actual_weight) + '%</span></div>' +
          '<div class="stat-row"><span>목표</span><span>' + fmtWeight(h.target_weight) + '%</span></div>' +
          '<div class="deviation-value">' + sign + fmtWeight(dev) + '%p' + (over ? ' · 리밸런싱 필요' : '') + '</div>' +
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
        '<li class="rebalance-item">' +
          '<div class="name-row">' +
            '<span class="name">' + escapeHtml(e.client.name) + '</span>' +
            '<span class="review-date">점검일 ' + escapeHtml(e.client.review_date) + '</span>' +
          '</div>' +
          '<div class="reason">' + reason + '</div>' +
        '</li>'
      );
    }).join("");
  }

  // ---- reminder list (우측, 마지막 점검일로부터 7일 이상 지난 고객) ----
  function renderReminderList() {
    var list = document.getElementById("reminder-list");
    var latestByName = {};
    clients.forEach(function (c) {
      var existing = latestByName[c.name];
      if (!existing || c.review_date > existing.review_date) {
        latestByName[c.name] = c;
      }
    });

    var overdue = Object.keys(latestByName).map(function (name) {
      var c = latestByName[name];
      return { client: c, days: daysSince(c.review_date) };
    }).filter(function (e) { return e.days >= OVERDUE_DAYS; });

    overdue.sort(function (a, b) { return b.days - a.days; });

    if (overdue.length === 0) {
      list.innerHTML = '<li class="empty-state">점검이 밀린 고객이 없습니다.</li>';
      return;
    }

    list.innerHTML = overdue.map(function (e) {
      return (
        '<li class="rebalance-item">' +
          '<div class="name-row">' +
            '<span class="name">' + escapeHtml(e.client.name) + '</span>' +
            '<span class="review-date">' + e.days + '일 경과</span>' +
          '</div>' +
          '<div class="reason">마지막 점검일 ' + escapeHtml(e.client.review_date) + '</div>' +
        '</li>'
      );
    }).join("");
  }

  // ---- init ----
  renderHeader();
  (async function init() {
    await Promise.all([fetchClients(), fetchHoldings()]);
    renderHoldingPanel();
    renderDeviationCards();
    renderRebalanceList();
    renderReminderList();
    renderKpis();
  })();
})();
