// LawLLM 三法训练集构建脚本（可复现）。
// 用法：node build-dataset.mjs <dataDir>
// 前置：dataDir 下已有 DISC-Law-SFT-Pair-QA-released.jsonl、
//       DISC-Law-SFT-Triplet-QA-released.jsonl、statutes/（just-laws 法条 md）、
//       comparative-samples.jsonl（与脚本同目录）。
// 产出：<dataDir>/train.jsonl 与 <dataDir>/val.jsonl（98:2）。
import fs from "node:fs";
import path from "node:path";

const dataDir = process.argv[2] || ".";
const SYS =
  "你是 LawLLM，一个由复旦大学 DISC 实验室训练的中国法律助手。回答必须准确引用法律条文；不确定的内容要明确说明需核验，不得编造条文。";

// ── 1) DISC 咨询按三法关键词分拣 ──
const KW = {
  criminal: ["刑法", "犯罪", "刑事", "罪名", "有期徒刑", "无期徒刑", "拘役", "管制", "缓刑", "假释", "正当防卫", "故意", "过失", "抢劫", "盗窃", "诈骗罪", "贪污", "受贿", "自首", "立功", "累犯", "死刑", "刑罚", "减刑"],
  civil: ["民法典", "民事", "合同", "侵权", "物权", "债权", "婚姻", "继承", "离婚", "抚养", "遗嘱", "赡养", "婚姻家庭", "人格权", "隐私", "名誉权", "抵押", "质押", "担保", "租赁", "买卖合同", "不当得利", "无因管理"],
  labor: ["劳动", "劳动合同", "用工", "劳动者", "用人单位", "工伤", "劳动仲裁", "劳动争议", "工资", "加班", "辞退", "解雇", "经济补偿", "赔偿金", "试用期", "劳务派遣", "社会保险", "工伤保险", "失业保险"],
};

function classify(text) {
  const score = {};
  for (const [cat, words] of Object.entries(KW)) {
    score[cat] = 0;
    for (const w of words) {
      const hits = text.split(w).length - 1;
      if (hits) score[cat] += hits * (w.length >= 3 ? 2 : 1);
    }
  }
  return Object.entries(score).sort((a, b) => b[1] - a[1])[0];
}

function pickDisc(file, n, domain) {
  const raw = fs.readFileSync(path.join(dataDir, file), "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const seen = new Set();
  const scored = [];
  for (const x of raw) {
    const out = x.output || "";
    if (out.length < 60 || out.length > 2000) continue;
    const key = (x.input || "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    let score = 0;
    if (/《[^》]{2,20}》第[一二三四五六七八九十百千零\d]+条/.test(out)) score += 2;
    if (/首先|其次|再次|另外|综上|路径|要件|风险|结论/.test(out)) score += 1;
    if (out.length >= 150) score += 1;
    scored.push({ score, x });
  }
  scored.sort((a, b) => b.score - a.score || a.x.input.length - b.x.input.length);
  return scored.slice(0, n).map(({ x }) => ({ domain, type: "disc_qa", messages: [
    { role: "system", content: SYS },
    { role: "user", content: x.input },
    { role: "assistant", content: x.output },
  ] }));
}

// ── 2) 法条 QA（零幻觉：背诵 15% + 反向定位 85%）──
const LAW_FILES = [
  ["statutes/criminal-law_criminal-law_01-general-provisions.md", "《刑法》总则", "criminal"],
  ["statutes/criminal-law_criminal-law_02-specific-provisions.md", "《刑法》分则", "criminal"],
  ["statutes/civil-and-commercial_civil-code_01-general-principles.md", "《民法典》总则编", "civil"],
  ["statutes/civil-and-commercial_civil-code_02-property-rights.md", "《民法典》物权编", "civil"],
  ["statutes/civil-and-commercial_civil-code_03-contracts.md", "《民法典》合同编", "civil"],
  ["statutes/civil-and-commercial_civil-code_04-personality-rights.md", "《民法典》人格权编", "civil"],
  ["statutes/civil-and-commercial_civil-code_05-marriage-and-family.md", "《民法典》婚姻家庭编", "civil"],
  ["statutes/civil-and-commercial_civil-code_06-inheritance.md", "《民法典》继承编", "civil"],
  ["statutes/civil-and-commercial_civil-code_07-tort-liability.md", "《民法典》侵权责任编", "civil"],
  ["statutes/social_labor-law_README.md", "《劳动法》", "labor"],
  ["statutes/social_labor-contracts-law_README.md", "《劳动合同法》", "labor"],
];

function buildStatuteQA() {
  const out = [];
  for (const [file, lawName, domain] of LAW_FILES) {
    const text = fs.readFileSync(path.join(dataDir, file), "utf8");
    const re = /\*\*(第[零一二三四五六七八九十百千]+条[^*]{0,12})\*\*/g;
    const articles = [];
    let m, last = null;
    while ((m = re.exec(text)) !== null) {
      if (last) articles.push({ head: last.head, text: text.slice(last.end, m.index).trim() });
      last = { head: m[1], end: m.index + m[0].length };
    }
    if (last) articles.push({ head: last.head, text: text.slice(last.end).trim() });
    for (const a of articles) {
      a.text = a.text.replace(/^##.*$/gm, "").replace(/^---.*$/gm, "").replace(/\*\*/g, "").replace(/\n{3,}/g, "\n\n").trim();
    }
    for (const a of articles.filter((x) => x.text.length >= 40 && x.text.length <= 1600 && x.head.includes("条"))) {
      const articleNo = a.head.split("　")[0].split(" ")[0];
      const roll = Math.random();
      if (roll < 0.15 && a.text.length <= 800) {
        out.push({ domain, type: "article_recall", messages: [
          { role: "system", content: SYS },
          { role: "user", content: `请完整引用${lawName}中${articleNo}的原文。` },
          { role: "assistant", content: `${lawName}${articleNo}规定：\n\n${a.text}` },
        ] });
      } else if (roll >= 0.15 && a.text.length <= 900) {
        const shortened = a.text.length > 500 ? a.text.slice(0, 480) + "……" : a.text;
        out.push({ domain, type: "article_locate", messages: [
          { role: "system", content: SYS },
          { role: "user", content: `以下条文出自哪部法律的哪一条？\n\n「${shortened}」` },
          { role: "assistant", content: `这段条文出自${lawName}${articleNo}。` },
        ] });
      }
    }
  }
  return out;
}

// ── 3) Triplet（法条依据融入回答）──
function pickTriplet(file, perDomain, domains) {
  const raw = fs.readFileSync(path.join(dataDir, file), "utf8").trim().split("\n");
  const selected = Object.fromEntries(domains.map((d) => [d, []]));
  const seen = new Set();
  for (const line of raw) {
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(x.reference) || !x.reference.length) continue;
    const out = x.output || "";
    if (out.length < 80 || out.length > 1800) continue;
    const key = (x.input || "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const [cat, catScore] = classify((x.input || "") + out + x.reference.join(""));
    if (catScore < 4 || !selected[cat] || selected[cat].length >= perDomain) continue;
    selected[cat].push({ domain: cat, type: "triplet_qa", messages: [
      { role: "system", content: SYS },
      { role: "user", content: x.input + "\n\n（相关法条已随问题提供，请依据其作答。）" },
      { role: "assistant", content: "【依据】\n" + x.reference.join("\n") + "\n\n【分析】\n" + out },
    ] });
  }
  return Object.values(selected).flat();
}

// ── 4) 比较法（仓库固化的通说样本 + 权重）──
const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// ── 组装 ──
const parts = [
  ...pickDisc("DISC-Law-SFT-Pair-QA-released.jsonl", 6400 / 3 * 1, "criminal").slice(0, 1800).map((x) => JSON.stringify(x)),
  ...pickDisc("DISC-Law-SFT-Pair-QA-released.jsonl", 2200, "civil").map((x) => JSON.stringify(x)),
  ...pickDisc("DISC-Law-SFT-Pair-QA-released.jsonl", 2400, "labor").map((x) => JSON.stringify(x)),
  ...buildStatuteQA().map((x) => JSON.stringify(x)),
  ...pickTriplet("DISC-Law-SFT-Triplet-QA-released.jsonl", 300, ["criminal", "civil", "labor"]).map((x) => JSON.stringify(x)),
];
const compFile = path.join(scriptDir, "comparative-samples.jsonl");
const compLines = fs.readFileSync(compFile, "utf8").trim().split("\n");
for (let i = 0; i < 4; i++) parts.push(...compLines);

const seen = new Set();
const uniq = parts.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
for (let i = uniq.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
}
const valN = Math.floor(uniq.length * 0.02);
fs.writeFileSync(path.join(dataDir, "train.jsonl"), uniq.slice(valN).join("\n") + "\n");
fs.writeFileSync(path.join(dataDir, "val.jsonl"), uniq.slice(0, valN).join("\n") + "\n");
console.log("total:", uniq.length, "| train:", uniq.length - valN, "| val:", valN);
