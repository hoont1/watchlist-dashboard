// Vercel Serverless Function — proxies 네이버 금융 등락률 상위 페이지를 서버에서
// 가져와 파싱한다. 브라우저에서 finance.naver.com을 직접 fetch하면 CORS로
// 막히므로 이 프록시가 필요하다. 공식 API가 아닌 HTML 파싱이라 네이버가
// 마크업을 바꾸면 깨질 수 있다.

var RISE_URLS = [
  "https://finance.naver.com/sise/sise_rise.naver?sosok=0",
  "https://finance.naver.com/sise/sise_rise.naver?sosok=1"
];
var FALL_URLS = [
  "https://finance.naver.com/sise/sise_fall.naver?sosok=0",
  "https://finance.naver.com/sise/sise_fall.naver?sosok=1"
];

async function fetchHtml(url) {
  var res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://finance.naver.com/sise/"
    }
  });
  if (!res.ok) throw new Error("네이버 금융 응답 오류 (" + res.status + ")");
  var buf = await res.arrayBuffer();
  var html = new TextDecoder("euc-kr").decode(buf);
  if (!/[가-힣]/.test(html)) html = new TextDecoder("utf-8").decode(buf);
  return html;
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
      throw new Error("네이버 금융 페이지에서 종목을 파싱하지 못했습니다");
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      risers: risers,
      fallers: fallers
    });
  } catch (err) {
    res.status(502).json({ error: true, message: String((err && err.message) || err) });
  }
};
