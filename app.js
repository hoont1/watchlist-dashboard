(function () {
  "use strict";

  var SUPABASE_URL = "https://gbjozahbwvrdspskxxcx.supabase.co";
  var SUPABASE_KEY = "sb_publishable_EdPru57DKX1iH7w6_F0K-A_CLb2u7Pu";
  var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var DEVIATION_THRESHOLD = 5; // %p

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
  function reportError(err) {
    console.error(err);
    alert("저장소(Supabase)와 통신 중 오류가 발생했습니다: " + (err && err.message ? err.message : err));
  }

  // ---- state (in-memory cache of the last fetch from Supabase) ----
  var clients = [];
  var holdings = []; // all holdings, across all clients — needed for the rebalance list
  var selectedClientId = null;
  var editingHoldingId = null;

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
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = '<li class="empty-state">등록된 자산군이 없습니다. 위에서 추가해보세요.</li>';
      return;
    }
    list.innerHTML = rows.map(function (h) {
      if (h.id === editingHoldingId) {
        return (
          '<li class="holding-item editing" data-id="' + h.id + '">' +
            '<form class="add-form inline-edit-form" data-action="save-holding-edit" data-id="' + h.id + '">' +
              '<input class="asset-name-input" name="asset_class" type="text" value="' + escapeAttr(h.asset_class) + '" required>' +
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
      var sign = dev > 0 ? "+" : "";
      return (
        '<div class="deviation-card' + (over ? " over" : "") + '">' +
          '<div class="asset-name">' + escapeHtml(h.asset_class) + '</div>' +
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

  // ---- init ----
  renderHeader();
  (async function init() {
    await Promise.all([fetchClients(), fetchHoldings()]);
    renderHoldingPanel();
    renderDeviationCards();
    renderRebalanceList();
  })();
})();
