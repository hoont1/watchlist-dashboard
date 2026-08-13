// Vercel Serverless Function — proxies 네이버 금융 등락률 상위 페이지를 서버에서
// 가져와 파싱한다. 브라우저에서 finance.naver.com을 직접 fetch하면 CORS로
// 막히므로 이 프록시가 필요하다. 공식 API가 아닌 HTML 파싱이라 네이버가
// 마크업을 바꾸면 깨질 수 있고, 네이버가 클라우드 IP를 차단/지연시키면
// 타임아웃이 날 수도 있다 — 그래서 실패 시에도 화면이 비지 않도록 마지막
// 성공 데이터 캐시 → 없으면 더미 데이터로 폴백한다 (항상 HTTP 200 응답).

// 서울 리전에서 실행 — 네이버가 클라우드 리전 IP를 차단/제한할 가능성을 줄인다
module.exports.config = { regions: ["icn1"] };

var RISE_URLS = [
  "https://finance.naver.com/sise/sise_rise.naver?sosok=0",
  "https://finance.naver.com/sise/sise_rise.naver?sosok=1"
];
var FALL_URLS = [
  "https://finance.naver.com/sise/sise_fall.naver?sosok=0",
  "https://finance.naver.com/sise/sise_fall.naver?sosok=1"
];
var FETCH_TIMEOUT_MS = 6000;

// 실제 시세를 못 가져올 때 화면이 비지 않도록 보여줄 예시 데이터.
// 종목명은 실제 코스피/코스닥 상장사명을 쓰지만 가격·등락률은 임의 값이며,
// notice 문구("실시간 데이터를 불러오지 못해 예시 데이터를 표시 중입니다")로
// 실제 시세가 아님을 알린다.
var FALLBACK_DATA = {
  risers: [
    { code: "000000", name: "삼성전자", price: "12,500", changePercent: 29.8 },
    { code: "000001", name: "SK하이닉스", price: "8,420", changePercent: 21.3 },
    { code: "000002", name: "카카오", price: "45,100", changePercent: 15.7 },
    { code: "000003", name: "NAVER", price: "3,150", changePercent: 12.1 },
    { code: "000004", name: "현대차", price: "67,800", changePercent: 9.4 }
  ],
  fallers: [
    { code: "000005", name: "LG에너지솔루션", price: "5,230", changePercent: -28.6 },
    { code: "000006", name: "셀트리온", price: "19,900", changePercent: -19.2 },
    { code: "000007", name: "POSCO홀딩스", price: "2,780", changePercent: -14.5 },
    { code: "000008", name: "삼성바이오로직스", price: "33,450", changePercent: -11.8 },
    { code: "000009", name: "기아", price: "9,610", changePercent: -8.3 }
  ]
};

// 같은 함수 인스턴스가 재사용되는 동안(warm)엔 마지막 성공 데이터를 들고 있다가
// 다음 요청이 실패하면 그걸 대신 보여준다. 콜드 스타트 후 첫 실패라면
// lastGood이 없으므로 FALLBACK_DATA를 쓴다.
var lastGood = null;

async function fetchHtml(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": "https://finance.naver.com/sise/",
        "Accept-Language": "ko-KR,ko;q=0.9"
      }
    });
    console.log("[stocks] GET " + url + " -> " + res.status);
    var buf = await res.arrayBuffer();
    if (!res.ok) {
      console.error("[stocks] non-OK response body head:", Buffer.from(buf).toString("utf-8").slice(0, 300));
      throw new Error("네이버 응답 코드 " + res.status);
    }
    var html = new TextDecoder("euc-kr").decode(buf);
    if (!/[가-힣]/.test(html)) html = new TextDecoder("utf-8").decode(buf);
    return html;
  } catch (err) {
    if (err && err.name === "AbortError") {
      console.error("[stocks] timeout after " + FETCH_TIMEOUT_MS + "ms:", url);
      throw new Error("네이버 금융 응답 지연(타임아웃): " + url);
    }
    console.error("[stocks] fetch failed:", url, err && err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 표의 각 <tr>에서 종목코드 링크를 기준으로 행을 찾고, 그 안의 <td> 텍스트들
// 중 %가 붙은 값을 등락률로, 한글/영문이 포함된 값을 종목명으로, 쉼표 섞인
// 숫자값(3자리 이상)을 현재가로 추정한다. 고정된 컬럼 인덱스 대신 패턴
// 매칭을 쓰는 이유는 네이버가 열 순서를 바꿔도 어느 정도 견고하기 위함이다.
function parseRows(html, forceSign) {
  var rows = html.split(/<tr[\s>]/i).slice(1);
  var results = [];
  rows.forEach(function (rowHtml) {
    var codeMatch = rowHtml.match(/\/item\/main\.naver\?code=(\d{6})/);
    if (!codeMatch) return;

    var cells = [];
    var cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    var m;
    while ((m = cellRe.exec(rowHtml))) {
      var text = m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
      cells.push(text);
    }

    var name = null, price = null, percent = null;
    cells.forEach(function (text) {
      if (!text) return;
      if (percent === null) {
        var pm = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
        if (pm) { percent = parseFloat(pm[1]); return; }
      }
      if (name === null && /[가-힣A-Za-z]/.test(text) && !/^[\d,.]+$/.test(text)) { name = text; return; }
      if (price === null && /^[\d,]+$/.test(text) && text.replace(/,/g, "").length >= 3) { price = text; return; }
    });

    if (name && price && percent !== null) {
      if (forceSign > 0) percent = Math.abs(percent);
      if (forceSign < 0) percent = -Math.abs(percent);
      // 국내 증시 가격제한폭은 ±30% — 이를 넘거나 1원당 단가가 비현실적으로
      // 큰 값은 다른 열(거래량 등)을 잘못 집은 파싱 오류로 보고 버린다
      if (Math.abs(percent) > 30.5) return;
      if (price.replace(/,/g, "").length > 7) return;
      results.push({ code: codeMatch[1], name: name, price: price, changePercent: percent });
    }
  });
  return results;
}

async function fetchDirection(urls, forceSign) {
  var htmls = await Promise.all(urls.map(fetchHtml));
  var all = [];
  htmls.forEach(function (html) { all = all.concat(parseRows(html, forceSign)); });
  return all;
}

module.exports = async function handler(req, res) {
  try {
    var results = await Promise.all([
      fetchDirection(RISE_URLS, 1),
      fetchDirection(FALL_URLS, -1)
    ]);
    var risers = results[0].sort(function (a, b) { return b.changePercent - a.changePercent; }).slice(0, 5);
    var fallers = results[1].sort(function (a, b) { return a.changePercent - b.changePercent; }).slice(0, 5);

    if (risers.length === 0 && fallers.length === 0) {
      throw new Error("네이버 금융 페이지에서 종목을 파싱하지 못했습니다 (파싱 결과 0건)");
    }

    lastGood = { risers: risers, fallers: fallers };
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      risers: risers,
      fallers: fallers
    });
  } catch (err) {
    console.error("[stocks] live fetch failed, falling back:", err && err.message);
    var fallbackSource = lastGood || FALLBACK_DATA;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      risers: fallbackSource.risers,
      fallers: fallbackSource.fallers,
      notice: lastGood
        ? "실시간 데이터를 불러오지 못해 마지막으로 조회된 데이터를 표시 중입니다."
        : "실시간 데이터를 불러오지 못해 예시 데이터를 표시 중입니다.",
      debugMessage: String((err && err.message) || err)
    });
  }
};
